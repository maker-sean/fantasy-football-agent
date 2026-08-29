/**
 * Tell a league its draft is coming, then tell it how the draft went.
 *
 * A draft is the largest single event in a redraft league's year — twelve people
 * in a chat for three hours — and until now the bot sat through it silently.
 *
 * THREE MOMENTS, and they are different messages. A day out is a reminder to
 * turn up. An hour out is the last useful warning, and the one that saves an
 * autopick. Afterwards is the only one anybody will argue about.
 *
 * DUE, NOT SCHEDULED. Each announcement fires the first time the check runs
 * past its moment, rather than in a narrow window — a cron that must land
 * inside a five minute slot will eventually miss the one draft a year that
 * mattered, and a reminder that arrives twenty minutes late is still a
 * reminder. The guard is a flag per draft per phase, so late never means twice.
 *
 * SILENCE IS THE FALLBACK. A draft with no start time set gets no countdown at
 * all rather than a guess, and a recap that cannot be built is not sent. The
 * failure everybody remembers is the bot announcing the wrong thing to twelve
 * people, not the bot saying nothing.
 */

const db = require('./db');

const HOUR = 3600 * 1000;

const flagKey = (leagueId, draftId, phase) => `draft_announce:${leagueId}:${draftId}:${phase}`;

/**
 * Which announcements are due for this draft, now.
 *
 * @param schedule  sleeper.draftSchedule output
 * @param now       ms since epoch
 */
function due(schedule, now = Date.now()) {
  if (!schedule?.draftId) return [];
  const out = [];
  const start = Number(schedule.startsAt) || null;
  const status = String(schedule.status || '').toLowerCase();

  if (start && status === 'pre_draft') {
    // Past the mark and not yet started. Both can be due at once if the bot was
    // asleep, and the caller sends only the latest — see run().
    if (now >= start - 24 * HOUR && now < start) out.push('t24');
    if (now >= start - 1 * HOUR && now < start) out.push('t1');
  }
  if (status === 'complete') out.push('recap');
  return out;
}

async function alreadySent(leagueId, draftId, phase) {
  const { rows } = await db.query('select 1 from system_flags where key = $1',
    [flagKey(leagueId, draftId, phase)]);
  return rows.length > 0;
}

async function markSent(leagueId, draftId, phase, detail) {
  await db.query(
    `insert into system_flags (key, value, updated_by) values ($1, $2, 'draft-announce')
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [flagKey(leagueId, draftId, phase), JSON.stringify(detail || {})]);
}

/** When it starts, in the league's own words. */
function whenText(startsAt, tz = 'America/New_York') {
  if (!startsAt) return null;
  return new Date(Number(startsAt)).toLocaleString('en-US', {
    timeZone: tz, weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

/** The countdown messages. Short on purpose: this is a nudge, not a briefing. */
function countdownText(phase, schedule) {
  const when = whenText(schedule.startsAt);
  const rounds = schedule.rounds ? `${schedule.rounds} rounds` : null;
  if (phase === 't24') {
    return `Draft is tomorrow: ${when}.`
      + (rounds ? ` ${rounds}.` : '')
      + (schedule.orderSet ? '' : ' Draft order still is not set.')
      + ' Set your queue now if you cannot be there live.';
  }
  return `Draft starts in an hour, ${when}.`
    + (schedule.pickSeconds ? ` ${Math.round(schedule.pickSeconds / 60)} minutes a pick.` : '')
    + ' Last call to set a queue — autopick does not care what you wanted.';
}

/**
 * The recap: every team graded and ranked, ends first.
 *
 * Reuses the same grading the chat can ask for, so the broadcast and the answer
 * to "grade my draft" can never disagree — two code paths saying different
 * things about the same draft is the argument nobody wins.
 */
async function recapText(league, { top = 3 } = {}) {
  const sleeper = require('./sleeper');
  const dg = require('./draftgrade');
  const { leagueContext } = require('./context');

  const ctx = await leagueContext(league.id);
  if (!ctx) return null;

  const [lg, rosters, proj] = await Promise.all([
    sleeper.leagueSettings(league.sleeper_league_id).catch(() => null),
    sleeper.rosters(league.sleeper_league_id).catch(() => null),
    sleeper.seasonProjections(ctx.season).catch(() => null),
  ]);
  if (!lg || !rosters || !proj) return null;

  // An empty roster set means Sleeper has not written the picks out yet, which
  // is a wait rather than a result.
  if (!rosters.some(r => (r.players || []).length)) return null;

  const nameOf = rid => {
    const m = (ctx.members || []).find(x => Number(x.rosterId) === Number(rid));
    return m?.name || `roster ${rid}`;
  };
  const out = dg.gradeDraft({ rosters, rosterPositions: lg.roster_positions, proj, nameOf });
  if (!out?.teams?.length) return null;

  const n = Math.min(top, Math.max(1, Math.floor(out.teams.length / 3)));
  const lines = ['Draft is done. Graded on the starting lineup each roster can field,'
               + ` against Sleeper's ${ctx.season} projections.`];
  lines.push('Best of it:');
  for (const t of out.teams.slice(0, n)) {
    const up = (t.strengths || []).map(x => x.pos).join('/');
    lines.push(`  ${t.name} ${t.grade}${up ? `, strongest at ${up}` : ''}`);
  }
  lines.push('Rough day:');
  for (const t of out.teams.slice(-n).reverse()) {
    const down = (t.weaknesses || []).map(x => x.pos).join('/');
    lines.push(`  ${t.name} ${t.grade}${down ? `, thin at ${down}` : ''}`
      + (t.holes.length ? `, cannot fill ${t.holes.join('/')}` : ''));
  }
  const middle = out.teams.length - 2 * n;
  if (middle > 0) lines.push(`${middle} others in between — ask me for a name.`);
  return lines.join('\n');
}

/**
 * Check every active league and send whatever is due.
 *
 * Only the LATEST due countdown is sent. A worker that was down for a day would
 * otherwise wake up and fire the day-out reminder an hour before the draft,
 * which is worse than useless.
 */
async function run(provider, { dryRun = false, now = Date.now() } = {}) {
  const sleeper = require('./sleeper');
  const detail = { sent: [], skipped: [] };
  const leagues = await db.activeLeagues();

  for (const lg of leagues) {
    const schedule = await sleeper.draftSchedule(lg.sleeper_league_id).catch(() => null);
    if (!schedule?.draftId) { detail.skipped.push({ league: lg.name, why: 'no draft' }); continue; }

    const phases = due(schedule, now);
    if (!phases.length) { detail.skipped.push({ league: lg.name, why: 'nothing due' }); continue; }

    // t1 supersedes t24; recap is its own thing and can ride alongside neither.
    const countdown = phases.includes('t1') ? 't1' : phases.includes('t24') ? 't24' : null;
    const wanted = [phases.includes('recap') ? 'recap' : null, countdown].filter(Boolean);

    for (const phase of wanted) {
      if (await alreadySent(lg.id, schedule.draftId, phase)) {
        detail.skipped.push({ league: lg.name, phase, why: 'already sent' });
        continue;
      }
      /*
       * A countdown that was superseded is marked WITHOUT sending, so a league
       * that only ever gets the one-hour warning is not told tomorrow about a
       * draft that already happened.
       */
      if (phase === 't1' && phases.includes('t24')
          && !(await alreadySent(lg.id, schedule.draftId, 't24'))) {
        await markSent(lg.id, schedule.draftId, 't24', { superseded: true });
      }

      let text;
      try {
        text = phase === 'recap' ? await recapText(lg) : countdownText(phase, schedule);
      } catch (err) {
        detail.skipped.push({ league: lg.name, phase, why: `build failed: ${err.message}` });
        continue;
      }
      if (!text) { detail.skipped.push({ league: lg.name, phase, why: 'nothing to say yet' }); continue; }

      if (dryRun) { detail.sent.push({ league: lg.name, phase, dryRun: true, text }); continue; }
      try {
        await provider.send(lg.chat_id, text, { leagueId: lg.id });
        await markSent(lg.id, schedule.draftId, phase, { at: new Date().toISOString() });
        detail.sent.push({ league: lg.name, phase });
      } catch (err) {
        // Not marked, so it goes again on the next pass.
        detail.skipped.push({ league: lg.name, phase, why: `send failed: ${err.message}` });
      }
    }
  }
  return detail;
}

module.exports = { run, due, recapText, countdownText, whenText, alreadySent, markSent, flagKey };
