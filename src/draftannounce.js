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
    /*
     * BOUNDED WINDOWS, not "any time before the draft".
     *
     * t24 was due from 24 hours out right up until the draft started, so a
     * fire at any point in that day counted as the day-before notice — which
     * is how a league got the day-before message five hours before its draft.
     * The copy no longer lies when that happens, but a day-before notice sent
     * on the day is still not a day-before notice.
     *
     * Four hours of slack on each: enough that a worker restart or a slow tick
     * does not silently drop an announcement, short enough that neither can
     * arrive somewhere it does not belong. Missing one is better than sending
     * it at the wrong time — the reader cannot tell a late notice from a
     * confused one.
     */
    if (now >= start - 24 * HOUR && now < start - 20 * HOUR) out.push('t24');
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

/**
 * The countdown messages. Short on purpose: this is a nudge, not a briefing.
 *
 * ANCHORED TO THE DATE, NEVER TO "TOMORROW".
 *
 * This said "Draft is tomorrow" and that was true at the moment it was composed
 * and false by the time it was read. On 2026-08-30 a league got the identical
 * "Draft is tomorrow: Sunday, August 30" message twice — once at 8:21pm
 * Saturday, when it was correct, and again at 2:40pm Sunday, five hours before
 * the draft, when the draft was that evening.
 *
 * A relative word is a claim about WHEN IT IS READ, and nothing here controls
 * that. The message can be delayed, retried, resent after a marking failure, or
 * read the next morning by somebody who was asleep. A date is true whenever it
 * arrives, so that is what these say now. The relative framing survives only as
 * urgency — "starting soon" — which is vague enough to stay honest and is the
 * only part that was ever doing real work.
 *
 * Weekday included deliberately: "Sunday, August 30" is checkable against the
 * reader's own sense of what day it is in a way that a bare date is not.
 */
function countdownText(phase, schedule) {
  const when = whenText(schedule.startsAt);
  const rounds = schedule.rounds ? `${schedule.rounds} rounds` : null;
  if (phase === 't24') {
    return `Draft day: ${when}.`
      + (rounds ? ` ${rounds}.` : '')
      + (schedule.orderSet ? '' : ' Draft order still is not set.')
      + ' Set your queue now if you cannot be there live.';
  }
  return `Draft starting soon — ${when}.`
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

  /*
   * Pick order, per team, so the recap can say what somebody DID and not only
   * how it scored. The grade is the same shape for every team — a letter and a
   * thin position — which is why nobody argues with it. The decision is the
   * part people argue about, and it is only visible in the order.
   *
   * Best effort: a draft Sleeper has not written out yet gives no picks, and
   * the recap is still worth sending without the colour.
   */
  let colourFor = () => [];
  try {
    const d = await sleeper.draft(league.sleeper_league_id);
    const { draftNeeds } = require('./context');

    /*
     * Positions come from the players table, which is the only place that
     * definitely has them.
     *
     * The first version read ctx.players and fell back to the projections map.
     * ctx has no players map at all, and the projection rows are keyed for
     * points rather than metadata — so every position resolved to null, seq
     * came back empty, and draftColour returned nothing for every team without
     * erroring. A silent no-op is the worst outcome here: the recap would have
     * looked exactly like a draft nobody made an interesting decision in.
     */
    const ids = [...new Set((d?.picks || []).map(pk => String(pk.player_id)).filter(Boolean))];
    const positions = new Map();
    if (ids.length) {
      const { rows: prows } = await db.query(
        'select player_id, position from players where player_id = any($1::text[])', [ids]);
      for (const r of prows) positions.set(String(r.player_id), r.position);
    }

    const byRoster = new Map();
    for (const pk of d?.picks || []) {
      if (!byRoster.has(pk.roster_id)) byRoster.set(pk.roster_id, []);
      byRoster.get(pk.roster_id).push({
        position: positions.get(String(pk.player_id)) || null,
        round: pk.round,
      });
    }
    colourFor = t => {
      const needs = draftNeeds(rosters, proj, t.rosterId,
        { rosterPositions: lg.roster_positions });
      return dg.draftColour({
        picks: byRoster.get(t.rosterId) || [],
        need: needs?.need || null,
        holes: t.holes || [],
        weaknesses: t.weaknesses || [],
      });
    };
  } catch (err) {
    console.error('[draft-announce] no pick order, sending grades only:', err.message);
  }
  if (!out?.teams?.length) return null;

  const n = Math.min(top, Math.max(1, Math.floor(out.teams.length / 3)));
  const lines = ['Draft is done. Graded on the starting lineup each roster can field,'
               + ` against Sleeper's ${ctx.season} projections.`];
  lines.push('Best of it:');
  for (const t of out.teams.slice(0, n)) {
    const up = (t.strengths || []).map(x => x.pos).join('/');
    lines.push(`  ${t.name} ${t.grade}${up ? `, strongest at ${up}` : ''}`);
    for (const note of colourFor(t)) lines.push(`    ${note}`);
  }
  lines.push('Rough day:');
  for (const t of out.teams.slice(-n).reverse()) {
    const down = (t.weaknesses || []).map(x => x.pos).join('/');
    lines.push(`  ${t.name} ${t.grade}${down ? `, thin at ${down}` : ''}`
      + (t.holes.length ? `, cannot fill ${t.holes.join('/')}` : ''));
    for (const note of colourFor(t)) lines.push(`    ${note}`);
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
       * There used to be a supersede step here: when a sleeping worker woke to
       * find both countdowns due, it marked t24 without sending so the
       * day-before notice could not go out after the draft. The bounded windows
       * in due() make that unreachable — t24 lives in [-24h, -20h) and t1 in
       * [-1h, 0), which cannot overlap — so a t24 that missed its window is
       * simply never due again, and there is nothing to suppress.
       */
      let text;
      try {
        text = phase === 'recap' ? await recapText(lg) : countdownText(phase, schedule);
      } catch (err) {
        detail.skipped.push({ league: lg.name, phase, why: `build failed: ${err.message}` });
        continue;
      }
      if (!text) { detail.skipped.push({ league: lg.name, phase, why: 'nothing to say yet' }); continue; }

      if (dryRun) { detail.sent.push({ league: lg.name, phase, dryRun: true, text }); continue; }
      /*
       * SENDING AND MARKING ARE SEPARATE FAILURES.
       *
       * They shared a try, so a marking failure was reported as a send failure
       * — and the comment underneath said "not marked, so it goes again",
       * which was exactly wrong in that case: the message HAD gone, and going
       * again meant sending it twice. A duplicate announcement in a group chat
       * is worse than a missing one.
       *
       * So a send that succeeded is marked in its own try, and a failure to
       * mark is loud rather than silently queuing a repeat.
       */
      try {
        await provider.send(lg.chat_id, text, { leagueId: lg.id });
      } catch (err) {
        // Genuinely not sent. Unmarked on purpose: the next pass retries.
        detail.skipped.push({ league: lg.name, phase, why: `send failed: ${err.message}` });
        continue;
      }
      try {
        await markSent(lg.id, schedule.draftId, phase, { at: new Date().toISOString() });
        detail.sent.push({ league: lg.name, phase });
      } catch (err) {
        detail.sent.push({ league: lg.name, phase, unmarked: true });
        console.error(`[draft-announce] SENT BUT NOT MARKED for ${lg.name} (${phase}): `
                    + `${err.message} — it may go again`);
      }
    }
  }
  return detail;
}

module.exports = { run, due, recapText, countdownText, whenText, alreadySent, markSent, flagKey };
