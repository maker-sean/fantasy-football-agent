/**
 * Trades: announced when they happen, graded three weeks later.
 *
 * The grade is the whole feature, and it only works in retrospect. At trade
 * time an honest system has nothing to say about who won — that needs
 * rest-of-season projections, which we do not have and could not verify, and
 * which is precisely the fabricated number src/verify.js exists to block. Three
 * weeks later the answer is arithmetic: Sleeper's players_points is in every
 * snapshot, so "what did these players actually do for you" is ground truth.
 *
 * Announcements therefore carry facts only. Grades appear at revisit.
 *
 * Scheduling is per league (default 8am and 6pm) but is NOT implemented as per
 * league cron entries — see leaguesDue(). A hundred leagues would mean a
 * hundred registrations, a restart to change one, and a silently skipped day
 * whenever the worker was down at the exact minute.
 */

const db = require('./db');
const sleeper = require('./sleeper');
const fanout = require('./fanout');

/** Local hours at which a league is polled. Two calls a day, not ninety-six. */
const DEFAULT_POLL_HOURS = [8, 18];
const DEFAULT_TZ = process.env.CRON_TZ || 'America/New_York';

/** How many weeks later the trade gets judged. */
const REVISIT_WEEKS = 3;

/**
 * Statuses we understand. Anything else is recorded verbatim rather than
 * guessed at.
 *
 * This is deliberately defensive. No pending or vetoed trade has ever been
 * captured in our data — the one real trade on file settled instantly, because
 * that league runs trade_review_days = 0 — so Sleeper's exact vocabulary for a
 * rejected trade is unverified. Hardcoding a guess would fail silently: the
 * feature would simply never fire, and nothing would report it.
 */
const SETTLED = new Set(['complete', 'completed']);
const REJECTED = new Set(['vetoed', 'veto', 'rejected', 'failed']);
const PENDING = new Set(['pending', 'proposed', 'in_review']);

const isSettled = s => SETTLED.has(String(s).toLowerCase());
const isRejected = s => REJECTED.has(String(s).toLowerCase());
const isPending = s => PENDING.has(String(s).toLowerCase());

// ----------------------------------------------------------- scheduling ----

/** The hour, 0-23, in a league's own timezone. */
function localHour(now, tz) {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', hour12: false,
  }).format(new Date(now)));
}

/**
 * Is this league due for a poll?
 *
 * Elapsed-time based, not clock-match based: "it is past a configured hour and
 * we have not polled since that hour came around". A worker that was down at
 * 08:00 polls at 08:15 instead of losing the window until 18:00.
 */
function isDue(league, now = Date.now()) {
  const cfg = league.config || {};
  const tz = cfg.timezone || DEFAULT_TZ;
  const hours = (cfg.tradePollHours || DEFAULT_POLL_HOURS).slice().sort((a, b) => a - b);
  if (!hours.length) return false;

  const hour = localHour(now, tz);
  // The most recent window that has already opened today.
  const opened = hours.filter(h => h <= hour).pop();
  if (opened == null) return false;   // before the first window of the day

  const last = league.trades_polled_at ? new Date(league.trades_polled_at).getTime() : 0;
  if (!last) return true;             // never polled

  // Start of the window that opened, in the league's own day.
  const d = new Date(now);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
  const windowStart = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00`).getTime()
    + opened * 3600 * 1000;

  return last < windowStart;
}

async function leaguesDue(now = Date.now()) {
  return (await db.activeLeagues()).filter(l => isDue(l, now));
}

// -------------------------------------------------------------- syncing ----

/** roster_id -> [player_id], from Sleeper's adds map. */
function receivedBy(txn) {
  const out = {};
  for (const [pid, rid] of Object.entries(txn.adds || {})) {
    (out[rid] = out[rid] || []).push(pid);
  }
  return out;
}

/**
 * Pull this week's trades for one league and record any new ones or status
 * changes. Returns the transitions worth announcing.
 *
 * `adopt` inserts everything silently instead of announcing — used the first
 * time a league is ever polled, so deploying does not dump a season of trade
 * history into the chat at once.
 */
async function syncLeague(league, { season, week, adopt = false }) {
  const txns = await sleeper.transactions(league.sleeper_league_id, week);
  const trades = (txns || []).filter(t => t.type === 'trade');
  const transitions = [];

  for (const t of trades) {
    const { rows: existing } = await db.query(
      'select * from trades where league_id = $1 and transaction_id = $2',
      [league.id, String(t.transaction_id)]
    );
    const prior = existing[0] || null;
    const status = String(t.status || 'unknown').toLowerCase();

    if (!prior) {
      const { rows } = await db.query(
        `insert into trades (league_id, transaction_id, season, week, status, received,
                             roster_ids, draft_picks, raw, revisit_week, status_updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (league_id, transaction_id) do nothing
         returning *`,
        [league.id, String(t.transaction_id), String(season), Number(week), status,
         JSON.stringify(receivedBy(t)), t.roster_ids || [],
         JSON.stringify(t.draft_picks || []), JSON.stringify(t),
         isSettled(status) ? Number(week) + REVISIT_WEEKS : null,
         t.status_updated ? new Date(t.status_updated) : null]
      );
      const trade = rows[0];
      if (!trade) continue;   // another tick inserted it first

      const ev = await recordEvent(trade.id, null, status, { adopt });
      if (!adopt) transitions.push({ trade, from: null, to: status, eventId: ev.id });
      continue;
    }

    if (prior.status === status) continue;   // nothing changed

    const { rows } = await db.query(
      `update trades set status = $2, raw = $3, status_updated_at = $4,
              revisit_week = coalesce(revisit_week, $5)
       where id = $1 returning *`,
      [prior.id, status, JSON.stringify(t),
       t.status_updated ? new Date(t.status_updated) : null,
       isSettled(status) ? Number(week) + REVISIT_WEEKS : null]
    );
    const ev = await recordEvent(prior.id, prior.status, status, { adopt });
    if (!adopt) transitions.push({ trade: rows[0], from: prior.status, to: status, eventId: ev.id });
  }

  return transitions;
}

/**
 * Every trade a league has ever made, pulled in one pass.
 *
 * The poller only ever sees trades happening NOW — it reads the current week of
 * a live season — so a league arrives with six years of history and none of it
 * recorded. moves_by_roster stored a COUNT, which answers "who is busiest" and
 * nothing about what was actually swapped.
 *
 * ADOPTED, NOT ANNOUNCED. Every one of these settled years ago; recording them
 * must not fire a single message. `adopt` already exists on syncLeague for
 * exactly this reason — it writes the row and the event and suppresses the
 * transition — and reusing it means the backfill and the live path cannot
 * disagree about what a trade row looks like.
 *
 * ATTACHED TO THE SEASON, not the current league. Each season is its own
 * Sleeper league with its own id, and its archive row is where its snapshots
 * already live. A trade belongs beside the games it was made during, and
 * anything wanting the whole history walks the chain — the same walk career()
 * and gameRecords() already do.
 *
 * Weeks 1-17 because Sleeper indexes transactions by week and offseason moves
 * land in week 1. Empty weeks cost one request and return nothing.
 */
async function backfill(sleeperLeagueId, { weeks = 17, onSeason = null } = {}) {
  const history = require('./history');
  const seasons = await history.chain(sleeperLeagueId);
  const out = { seasons: 0, trades: 0, detail: [] };

  for (const lg of seasons) {
    // The row this season's data hangs off. archiveLeague is idempotent and is
    // what captureSeason already used, so this reuses rather than duplicates.
    const row = await history.archiveLeague(lg);
    let found = 0;
    for (let week = 1; week <= weeks; week++) {
      try {
        await syncLeague({ id: row.id, sleeper_league_id: lg.league_id },
          { season: lg.season, week, adopt: true });
      } catch (err) {
        console.error(`[trades] ${lg.season} wk${week} failed:`, err.message);
      }
    }
    const { rows: [c] } = await db.query(
      'select count(*)::int n from trades where league_id = $1', [row.id]);
    found = c.n;
    out.seasons++;
    out.trades += found;
    out.detail.push({ season: lg.season, trades: found });
    if (onSeason) onSeason(lg.season, found);
  }
  return out;
}

/**
 * Settle every trade in a season that is over.
 *
 * REDRAFT ONLY, and that is the whole reason this can be written to the row and
 * never touched again. When a redraft season ends the answer is final: those
 * players scored what they scored, nobody's opinion moves it, and the verdict is
 * a fact rather than a snapshot of one. In dynasty a 2021 trade is still
 * resolving in 2026 — grading it once would freeze an answer that is still
 * moving, which is worse than having none.
 *
 * REST OF SEASON, not the live path's three weeks. Three weeks is right for a
 * trade announced on Tuesday, where a verdict has to arrive while anyone still
 * cares. Looking back, the honest window is everything that followed.
 *
 * The weekly matchups are FETCHED. Only one snapshot per season is stored, the
 * final one, so the week-by-week scoring this needs does not exist locally —
 * bounded and one-time, since a settled season never needs asking again.
 */
async function gradeClosedSeason(leagueRow, sleeperLeagueId, season, { lastWeek = 17 } = {}) {
  const { rows: trades } = await db.query(
    `select * from trades
      where league_id = $1 and season = $2 and status = 'complete' and verdict is null
      order by week`, [leagueRow.id, String(season)]);
  if (!trades.length) return { graded: 0, trades: 0 };

  const earliest = Math.min(...trades.map(t => Number(t.week) + 1));
  const snapshotsByWeek = new Map();
  for (let w = earliest; w <= lastWeek; w++) {
    const matchups = await sleeper.matchups(sleeperLeagueId, w).catch(() => null);
    if (matchups) snapshotsByWeek.set(w, { matchups });
  }

  const players = await playerMap();
  let graded = 0;
  for (const t of trades) {
    // Rest of season, so the live path's revisit_week is deliberately ignored.
    const verdict = scoreTrade({ ...t, revisit_week: lastWeek }, snapshotsByWeek, players,
      { season: String(season) });
    if (verdict.margin == null) continue;   // not a two-sided trade; nothing to grade
    await db.query(
      'update trades set verdict = $2, revisited_at = now() where id = $1',
      [t.id, JSON.stringify({ ...verdict, basis: 'rest_of_season', gradedAt: new Date().toISOString() })]);
    graded++;
  }
  return { graded, trades: trades.length };
}

/**
 * Grade the history of a league whose seasons actually close.
 *
 * The CURRENT season is skipped: it has not finished, so its trades are still
 * the live path's business and its three-week revisits are the right answer
 * until the season ends.
 */
async function gradeHistory(sleeperLeagueId, { onSeason = null } = {}) {
  const history = require('./history');
  const seasons = await history.chain(sleeperLeagueId);
  const out = { seasons: 0, graded: 0, skipped: [] };

  for (const lg of seasons) {
    if (lg.status !== 'complete') { out.skipped.push(lg.season); continue; }
    const { rows: [row] } = await db.query(
      "select id from leagues where sleeper_league_id = $1 and provider = 'archive' limit 1",
      [lg.league_id]);
    if (!row) { out.skipped.push(lg.season); continue; }

    const r = await gradeClosedSeason(row, lg.league_id, lg.season);
    out.seasons++;
    out.graded += r.graded;
    if (onSeason) onSeason(lg.season, r);
  }
  return out;
}

async function recordEvent(tradeId, from, to, { adopt = false } = {}) {
  const { rows } = await db.query(
    `insert into trade_events (trade_id, from_status, to_status, announced, announced_at)
     values ($1,$2,$3,$4,$5) returning *`,
    [tradeId, from, to, adopt, adopt ? new Date() : null]
  );
  return rows[0];
}

async function markAnnounced(eventId) {
  await db.query(
    'update trade_events set announced = true, announced_at = now() where id = $1',
    [eventId]
  );
}

// --------------------------------------------------------- announcements ----

/** roster_id -> team name, from a snapshot payload. */
function teamNames(payload) {
  const byUser = new Map((payload.users || []).map(u => [u.user_id, u]));
  const m = new Map();
  for (const r of payload.rosters || []) {
    const u = byUser.get(r.owner_id);
    m.set(r.roster_id, u?.metadata?.team_name || u?.display_name || u?.username || `Roster ${r.roster_id}`);
  }
  return m;
}

/**
 * Facts only. No grade, no projection, no claim about who won — at this point
 * nobody knows, including us, and saying otherwise is the exact failure the
 * recap verifier was built to catch.
 */
function composeAnnouncement({ trade, from, to }, { names, players }) {
  const side = rid => {
    const got = (trade.received || {})[rid] || [];
    const who = got.map(p => players.get(p)?.full_name || `player ${p}`).join(', ');
    return `${names.get(Number(rid)) || `Roster ${rid}`} gets ${who || 'draft picks'}`;
  };
  const sides = Object.keys(trade.received || {}).map(side).join('\n');

  if (isRejected(to)) {
    return `Trade vetoed.\n\n${sides}\n\nDead on arrival.`;
  }
  if (isPending(to)) {
    return `Trade proposed, in review.\n\n${sides}\n\nI'll grade it in ${REVISIT_WEEKS} weeks, once it means something.`;
  }
  if (isSettled(to)) {
    // A follow-up when the league already heard the proposal: short, and it
    // exists so that silence is never ambiguous. If only vetoes got a message,
    // nobody could tell "it went through" from "the bot broke".
    if (from && isPending(from)) {
      return `That trade went through.\n\n${sides}\n\nGrade in ${REVISIT_WEEKS} weeks.`;
    }
    return `Trade.\n\n${sides}\n\nNo grade yet. Ask me in ${REVISIT_WEEKS} weeks.`;
  }
  return null;   // an unknown status is recorded, not narrated
}

// ------------------------------------------------------------- the grade ----

/**
 * What the traded players actually did, from real scored points.
 *
 * Counts only points from weeks the player was STARTED. That is the honest
 * measure of the decision — acquiring someone and benching him means he did
 * nothing for you — and it matches how the recap already treats bench points.
 * The distinction has to survive into the wording: "contributed 0.0 to your
 * lineup" is true where "scored 0.0" would not be.
 */
function scoreTrade(trade, snapshotsByWeek, players, { season = null } = {}) {
  const from = Number(trade.week) + 1;
  const to = Number(trade.revisit_week);
  const sides = [];

  for (const [rid, pids] of Object.entries(trade.received || {})) {
    const rosterId = Number(rid);
    const lines = [];
    let started = 0;

    for (const pid of pids) {
      const weeks = [];
      let gone = false;
      for (let w = from; w <= to; w++) {
        const snap = snapshotsByWeek.get(w);
        if (!snap) { weeks.push({ week: w, missing: true }); continue; }
        const mu = (snap.matchups || []).find(m => m.roster_id === rosterId);
        const pts = mu?.players_points?.[pid];
        if (pts == null) {
          // Not on the roster at all — traded for and then cut. Recorded
          // explicitly rather than silently counted as zero, because it is both
          // arithmetically different and a better story.
          weeks.push({ week: w, offRoster: true });
          gone = true;
          continue;
        }
        const inLineup = (mu.starters || []).includes(pid);
        if (inLineup) started += pts;
        weeks.push({ week: w, points: pts, started: inLineup });
      }
      lines.push({
        playerId: pid,
        name: players.get(pid)?.full_name || `player ${pid}`,
        weeks,
        droppedAfterTrade: gone,
        startedPoints: weeks.filter(w => w.started).reduce((a, w) => a + w.points, 0),
      });
    }
    sides.push({ rosterId, players: lines, startedPoints: Number(started.toFixed(2)) });
  }

  /*
   * A HANDCUFF is a defensive move, not a win or a loss.
   *
   * Trading for the back-up to a player you already own — same NFL team, same
   * position — buys insurance, not points. He sits unless the starter gets
   * hurt, so he scores nothing and the trade reads as a fleecing when it was
   * a hedge that (happily) never paid out.
   *
   * Detected from the roster the manager actually held the week after the
   * trade, which the matchups already carry: mu.players is everyone, not just
   * the starters. Players arriving in this same trade are excluded, or a
   * two-back package would flag itself.
   */
  /*
   * ONLY FOR THE CURRENT SEASON, because players.team is today's team.
   *
   * The players table is refreshed nightly and carries no history, so asking
   * whether two men were teammates in November 2025 gets an answer about
   * August 2026. Free agency moves half the league every March; asserting a
   * handcuff on a 2020 trade from today's rosters would be confidently wrong,
   * which is worse than saying nothing.
   *
   * Historical team-by-season data exists — nflverse publishes rosters — and
   * until it is ingested this claim stays inside the one window where it is
   * true.
   */
  const currentSeason = String(new Date().getFullYear());
  const firstWeek = snapshotsByWeek.get(from);
  for (const side of season === currentSeason ? sides : []) {
    const mu = (firstWeek?.matchups || []).find(m => m.roster_id === side.rosterId);
    const heldIds = new Set(mu?.players || []);
    const arriving = new Set(side.players.map(pl => pl.playerId));

    for (const line of side.players) {
      const got = players.get(line.playerId);
      if (!got?.team || !got?.position) continue;
      for (const otherId of heldIds) {
        if (arriving.has(otherId)) continue;             // came in the same deal
        const other = players.get(otherId);
        if (!other || other.team !== got.team || other.position !== got.position) continue;
        line.handcuffOf = other.full_name;
        break;
      }
    }
  }

  sides.sort((a, b) => b.startedPoints - a.startedPoints);
  const margin = sides.length === 2
    ? Number((sides[0].startedPoints - sides[1].startedPoints).toFixed(2))
    : null;

  /*
   * BEST AGAINST BEST, alongside the total.
   *
   * The total sums every player a side received, so three-for-one flatters
   * whoever got three bodies — but only when they could actually field them
   * all, since a benched player already scores zero here. Comparing the best N
   * from each side, where N is the smaller side, removes the volume entirely.
   *
   * Both are reported because neither is the answer on its own: the total says
   * what the trade did for the roster, best-against-best says who got the
   * better player. On an even trade they agree, which is itself worth seeing.
   */
  let bestMargin = null;
  if (sides.length === 2) {
    const n = Math.min(sides[0].players.length, sides[1].players.length);
    const topN = side => side.players
      .map(pl => pl.startedPoints)
      .sort((a, b) => b - a)
      .slice(0, n)
      .reduce((a, b) => a + b, 0);
    bestMargin = Number((topN(sides[0]) - topN(sides[1])).toFixed(2));
  }

  return {
    weeks: { from, to },
    sides,
    margin,
    // Volume removed: the best N from each side, N being the smaller side.
    bestMargin,
    uneven: sides.length === 2 && sides[0].players.length !== sides[1].players.length,
    // Draft picks cannot be valued without projections, so they are excluded
    // from the arithmetic and disclosed rather than quietly ignored.
    hasPicks: Array.isArray(trade.draft_picks) && trade.draft_picks.length > 0,
  };
}

/**
 * A letter for a margin. Retrospective only — this describes what happened, not
 * what was likely to happen, which is why it is allowed to exist at all.
 */
function gradeFor(margin) {
  const m = Math.abs(margin);
  if (m < 5) return ['C', 'C'];        // a wash
  if (m < 15) return ['B', 'C-'];
  if (m < 30) return ['A-', 'D'];
  if (m < 50) return ['A', 'F'];
  return ['A+', 'F'];
}

/** The recap segment. Deterministic prose — no model, nothing to hallucinate. */
function composeVerdict(trade, verdict, names) {
  if (verdict.sides.length !== 2 || verdict.margin == null) return null;
  const [win, lose] = verdict.sides;
  const [gw, gl] = gradeFor(verdict.margin);
  const nm = s => names.get(s.rosterId) || `Roster ${s.rosterId}`;

  const detail = s => s.players.map(p => {
    if (p.droppedAfterTrade && p.startedPoints === 0) return `${p.name} (cut, never started)`;
    return `${p.name} ${p.startedPoints.toFixed(1)}`;
  }).join(', ');

  const head = verdict.margin < 5
    ? `Week ${trade.week} trade, revisited: basically a wash.`
    : `Week ${trade.week} trade, revisited: ${nm(win)} won it.`;

  return [
    head,
    `${nm(win)} ${gw}: ${detail(win)}`,
    `${nm(lose)} ${gl}: ${detail(lose)}`,
    `Started points only, weeks ${verdict.weeks.from}-${verdict.weeks.to}.`
      + (verdict.hasPicks ? ' Draft picks not counted.' : ''),
  ].join('\n');
}

// ---------------------------------------------------------------- the tick ----

/**
 * One poll pass. Scheduled every 15 minutes, but only leagues whose configured
 * window has opened make a Sleeper call — the frequent tick is what makes the
 * per-league schedule work without per-league cron entries, and the due check
 * is a database read, so the 48x saving over polling everyone is preserved.
 */
async function poll(provider, opts = {}) {
  const { dryRun = false, now = Date.now() } = opts;
  const jobId = await db.startJob('trades:poll');
  const detail = { leagues: [] };

  try {
    const state = await sleeper.state();
    detail.state = { season: state.season, week: state.week, type: state.season_type };

    const due = await leaguesDue(now);
    detail.due = due.length;
    if (!due.length) {
      await db.finishJob(jobId, 'ok', detail);
      return detail;
    }

    const players = await playerMap();

    const results = await fanout.forEachLeague(due, async league => {
      const entry = { league: league.name };
      // First ever poll for this league: adopt the existing history silently
      // rather than announcing a season of old trades on deploy day.
      const adopt = !league.trades_polled_at;
      entry.adopted = adopt;

      const transitions = await syncLeague(league, {
        season: state.season, week: state.week, adopt,
      });
      await db.query('update leagues set trades_polled_at = now() where id = $1', [league.id]);

      entry.transitions = transitions.length;
      if (!transitions.length) { entry.result = adopt ? 'adopted' : 'nothing new'; return entry; }

      // Team names come from the latest snapshot; without one there is nothing
      // to call anybody, so the announcement waits for the next tick.
      const { rows: snapRows } = await db.query(
        `select payload from snapshots where league_id = $1 order by captured_at desc limit 1`,
        [league.id]
      );
      if (!snapRows.length) { entry.result = 'no snapshot yet — names unavailable'; return entry; }
      const names = teamNames(snapRows[0].payload);

      entry.sent = [];
      for (const tr of transitions) {
        const text = composeAnnouncement(tr, { names, players });
        if (!text) { entry.sent.push({ to: tr.to, result: 'unknown status — recorded, not narrated' }); continue; }

        if (dryRun || !league.chat_id) {
          console.log(`[trades] (${dryRun ? 'dry run' : 'no chat'}) ${league.name}:\n${text}`);
          entry.sent.push({ to: tr.to, result: dryRun ? 'dry run' : 'no chat thread', text });
          continue;
        }

        await provider.send(league.chat_id, text);
        await db.recordMessage({
          leagueId: league.id, provider: league.provider, providerMessageId: null,
          direction: 'outbound', chatId: league.chat_id, senderPhone: null,
          isGroup: true, protocol: null, body: text,
          raw: { source: 'trade_announce', transition: `${tr.from || 'new'}->${tr.to}` },
          occurredAt: Date.now(),
        });
        // Only after the send succeeds, so a failure retries next tick.
        await markAnnounced(tr.eventId);
        entry.sent.push({ to: tr.to, result: 'sent' });
      }
      return entry;
    });

    for (const r of results) {
      detail.leagues.push(r.ok ? r.value : { result: 'ERROR', error: r.error.message });
    }
    const failed = detail.leagues.filter(l => l.result === 'ERROR');
    await db.finishJob(jobId, failed.length ? 'error' : 'ok', detail);
    return detail;
  } catch (err) {
    detail.error = err.message;
    await db.finishJob(jobId, 'error', detail);
    throw err;
  }
}

async function playerMap() {
  const { rows } = await db.query('select player_id, full_name, position, team from players');
  return new Map(rows.map(p => [p.player_id, p]));
}

/** Trades whose revisit week has arrived. Claimed by the weekly recap job. */
async function dueRevisits(leagueId, currentWeek) {
  const { rows } = await db.query(
    `select * from trades
     where league_id = $1 and revisited_at is null
       and revisit_week is not null and revisit_week <= $2
       and status = any($3)
     order by week`,
    [leagueId, Number(currentWeek), [...SETTLED]]
  );
  return rows;
}

async function markRevisited(tradeId, verdict) {
  await db.query(
    'update trades set revisited_at = now(), verdict = $2 where id = $1',
    [tradeId, JSON.stringify(verdict)]
  );
}

module.exports = {
  poll, backfill, gradeHistory, gradeClosedSeason, dueRevisits, markRevisited, playerMap,
  isDue, leaguesDue, syncLeague, recordEvent, markAnnounced,
  composeAnnouncement, scoreTrade, gradeFor, composeVerdict, teamNames, receivedBy,
  isSettled, isRejected, isPending,
  DEFAULT_POLL_HOURS, DEFAULT_TZ, REVISIT_WEEKS,
};
