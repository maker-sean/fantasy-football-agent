/**
 * Can this bot actually answer questions about this league — asked before the
 * setup link goes out, not after the group chat asks.
 *
 * On 2026-08-23 the bot sat in a thirteen-person chat with six seasons indexed
 * and said "No league data has been captured yet" to every historical question,
 * because leagueContext returned early for a live league with no snapshot of
 * its own. The archive rows were two code paths below that return. Nothing
 * errored. It was invisible in review and obvious in one query against the
 * running system.
 *
 * That league belongs to Sean. The next one does not, and a stranger's first
 * impression of this product is the first six answers it gives. So the query
 * runs first, deliberately, and its output is kept.
 *
 * WHY THE GATE LIVES BEHIND invites.send() RATHER THAN ON THE BUTTON. There are
 * three ways to invite somebody — the dashboard, INVITE from the operator
 * phone, and the CLI — and this codebase's most repeated bug is a second path
 * that never learned the first path's rules: the welcome, the mute, the
 * operator alert and the invite logic each broke that way in a single day. A
 * check enforced in the UI is a check two callers skip.
 */

const db = require('./db');

/**
 * The standard set, fixed on purpose.
 *
 * The value is that it is the SAME six every time, so two leagues are
 * comparable and a regression after an ingest change is visible. They are also
 * all checkable against the fact sheet stored beside them — which is the only
 * reason to keep answers rather than a pass/fail.
 *
 * They deliberately span the shapes that break differently: one lookup, one
 * superlative over a computed list, one over league history, one that depends
 * on the toilet bowl being distinct from last place, one statistical, one
 * enumeration, and one open-ended judgement with no right answer at all.
 */
const QUESTIONS = [
  'Who won last year?',
  'What manager had the best draft?',
  'Who had the most whiffs in league history?',
  'Who was last place in the toilet bowl?',
  'Who is statistically scoring the most points every season?',
  'What is the list of all winners by year?',
  'What is the worst manager decision made in league history?',
];

/** A run still marked running after this long was killed mid-flight. */
const STALE_MS = 10 * 60 * 1000;

/**
 * Is this signup clear to invite?
 *
 * `thin` is deliberately not a pass and not a failure. A league in its first
 * season has no completed seasons to ingest: nothing is broken, there is simply
 * nothing historical for the bot to say. Whether that is worth inviting is a
 * judgement about the product, not about the data, so it needs an explicit
 * override rather than a silent yes.
 */
function verdict(run) {
  if (!run) return { ok: false, reason: 'no_run' };
  if (run.status === 'running') {
    const age = Date.now() - new Date(run.started_at).getTime();
    return age > STALE_MS
      ? { ok: false, reason: 'stale' }
      : { ok: false, reason: 'running' };
  }
  if (run.status === 'passed') return { ok: true, reason: 'passed' };
  if (run.status === 'thin') return { ok: false, reason: 'thin', overridable: true };
  return { ok: false, reason: 'failed' };
}

async function latest(signupId) {
  const { rows } = await db.query(
    `select * from preflight_runs where signup_id = $1
      order by started_at desc limit 1`, [signupId]);
  return rows[0] || null;
}

async function gate(signupId) {
  const run = await latest(signupId);
  return { ...verdict(run), run };
}

/**
 * The league row the context is built against.
 *
 * Prefers a live row when one exists, because for an already-onboarded league
 * that row IS the truth and building context against a parallel archive row
 * would test something nobody uses.
 *
 * Otherwise a provisional row with provider = 'archive'. That is not cosmetic:
 * liveLeagueBySleeperId filters archive rows out, so a pre-flight can never
 * make a league look already-claimed and lock its real commissioner out of the
 * setup flow with "is already set up on Commish AI".
 */
async function contextLeague(current) {
  const live = await db.liveLeagueBySleeperId(current.league_id);
  if (live) return { league: live, provisional: false };

  const { rows: existing } = await db.query(
    `select * from leagues where sleeper_league_id = $1 and provider = 'archive' limit 1`,
    [current.league_id]);
  if (existing[0]) return { league: existing[0], provisional: true };

  const { rows } = await db.query(
    `insert into leagues (name, sleeper_league_id, provider, chat_id, active, season)
     values ($1, $2, 'archive', null, false, $3) returning *`,
    [`${current.name} ${current.season} (pre-flight)`, current.league_id, current.season]);
  return { league: rows[0], provisional: true };
}

/**
 * Start a run. Returns the row immediately; the work continues in the
 * background and the caller polls.
 *
 * Not awaited on purpose — a full chain walk plus seven model calls is about a
 * minute and a half, which is a background job wearing an HTTP request's
 * clothes if you block on it.
 */
async function start(signupId, { byEmail = null, runner = execute } = {}) {
  const existing = await latest(signupId);
  if (existing && verdict(existing).reason === 'running') {
    return { run: existing, started: false, reason: 'already_running' };
  }

  const { rows: [signup] } = await db.query('select * from signups where id = $1', [signupId]);
  if (!signup) return { run: null, started: false, reason: 'not_found' };

  const { rows: [run] } = await db.query(
    `insert into preflight_runs (signup_id, sleeper_league_id, by_email)
     values ($1, $2, $3) returning *`,
    [signupId, signup.sleeper_league_id || null, byEmail]);

  // Failure here must land on the row rather than in an unhandled rejection:
  // the row is the only thing anybody looks at.
  runner(run.id).catch(async err => {
    console.error('[preflight] run threw:', err.message);
    await fail(run.id, err.message).catch(() => {});
  });

  return { run, started: true };
}

async function fail(runId, message) {
  const { rows } = await db.query(
    `update preflight_runs set status = 'failed', error = $2, finished_at = now()
      where id = $1 returning *`, [runId, String(message).slice(0, 500)]);
  return rows[0];
}

/** The work. Exported so a script or a test can drive it synchronously. */
async function execute(runId) {
  const history = require('./history');
  const { leagueContext, contextBlock } = require('./context');

  const { rows: [run] } = await db.query('select * from preflight_runs where id = $1', [runId]);
  if (!run) throw new Error('run not found');

  const sleeperLeagueId = run.sleeper_league_id;
  if (!sleeperLeagueId) return fail(runId, 'This signup has no Sleeper league id on file.');

  // 1. Does the league exist, and how far back does it go.
  const seasons = await history.chain(sleeperLeagueId);
  if (!seasons.length) {
    return fail(runId, `Sleeper returned nothing for league ${sleeperLeagueId}.`);
  }
  const complete = seasons.filter(s => s.status === 'complete');
  await db.query('update preflight_runs set seasons_found = $2 where id = $1',
    [runId, seasons.length]);

  // 2. Ingest. archiveLeague is idempotent, so a re-run is cheap and a season
  //    that fails must not cost the other six.
  let captured = 0, failed = 0;
  for (const lg of complete) {
    try { await history.captureSeason(lg); captured++; }
    catch (err) { failed++; console.error(`[preflight] ${lg.season} failed:`, err.message); }
  }
  await db.query(
    'update preflight_runs set seasons_captured = $2, seasons_failed = $3 where id = $1',
    [runId, captured, failed]);

  // 3. Build the context the bot would actually be handed.
  const { league } = await contextLeague(seasons[0]);
  const ctx = await leagueContext(league.id);
  if (!ctx) return fail(runId, 'leagueContext returned nothing for the pre-flight league row.');
  const block = contextBlock(ctx);

  await db.query(
    `update preflight_runs set league_id = $2, context_block = $3, context_chars = $4
      where id = $1`, [runId, league.id, block, block.length]);

  /*
   * Nothing to be wrong about. A first-season league reaches here legitimately:
   * the chain is one row, nothing is complete, and there is no history. That is
   * `thin`, and it stops before spending seven model calls proving the bot has
   * nothing to say.
   */
  if (!captured || !ctx.career?.length) {
    const { rows } = await db.query(
      `update preflight_runs set status = 'thin', finished_at = now() where id = $1 returning *`,
      [runId]);
    return rows[0];
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return fail(runId, 'ANTHROPIC_API_KEY is not set on this service, so the '
      + 'questions could not be asked. The history ingested fine.');
  }

  // 4. Ask. Sequential rather than parallel: seven at once is a burst against
  //    the rate limit for no gain on a job nobody is watching in real time.
  const { generateAnswer } = require('./answer');
  const asked = [];
  for (const question of QUESTIONS) {
    const t0 = Date.now();
    try {
      const out = await generateAnswer(question, ctx, { recentChat: [] });
      asked.push({
        question, answer: out.text, ms: Date.now() - t0,
        tokens: {
          in: out.meta?.usage?.input_tokens ?? null,
          out: out.meta?.usage?.output_tokens ?? null,
          cacheRead: out.meta?.usage?.cache_read_input_tokens ?? null,
        },
      });
    } catch (err) {
      asked.push({ question, answer: null, ms: Date.now() - t0, error: err.message });
    }
    // Written as we go, so a run that dies on question five still shows four.
    await db.query('update preflight_runs set questions = $2 where id = $1',
      [runId, JSON.stringify(asked)]).catch(() => {});
  }

  const allFailed = asked.every(a => a.error);
  const { rows } = await db.query(
    `update preflight_runs set status = $2, error = $3, finished_at = now()
      where id = $1 returning *`,
    [runId, allFailed ? 'failed' : 'passed',
     allFailed ? 'Every question failed against the model.' : null]);
  return rows[0];
}

module.exports = { QUESTIONS, start, execute, latest, gate, verdict, contextLeague, STALE_MS };
