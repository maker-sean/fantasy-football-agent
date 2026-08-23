/**
 * Who actually drafts well.
 *
 * The question a league asks is "who is best at drafting", and the obvious
 * answer — where a player was taken minus where he finished — does not survive
 * contact with six seasons of this league. Both failures are worth recording,
 * because both look correct until you run them.
 *
 * FAILURE ONE: RANK DELTA AS A SCORE. All twelve managers came out negative,
 * every year. The finish pool contains every player who logged a stat (~1,300
 * receivers), while only about sixty are ever drafted, so upside is capped at
 * the draft slot and downside runs to four digits. Michael Thomas in 2021 went
 * WR26 and "finished" WR1351 — one pick worth -1,325, outweighing the league's
 * forty largest steals combined. What that leaderboard ranks is who avoided a
 * season-ending injury.
 *
 * FAILURE TWO: FIXING IT WITH A BETTER METRIC. Points above an expectation
 * curve fitted to draft slot behaves correctly and is unquotable. Nobody in a
 * group chat can check it, so every result becomes an argument about the model
 * instead of about the pick.
 *
 * WHAT THIS DOES INSTEAD. It stops scoring people and reports picks. Rank delta
 * is kept, because "WR43 to WR4" needs no explanation, and each list is gated
 * on the thing that makes a pick worth mentioning at all:
 *
 *   STEALS  must finish STARTABLE. A large delta into a bench player is not a
 *           steal; six such picks exist here, the best of them WR60 to WR33.
 *   WHIFFS  must cost something, so rounds 1-5 only. Unfiltered, the worst
 *           picks in every season are round 10-11 fliers, which are free.
 *   CURSED  is separate and never counted against the drafter. Rather than
 *           pick a weighting for injury and have the league argue about the
 *           weighting, the pick is shown next to its games played.
 *
 * Deliberately no ranking of managers. Over six seasons the spread between
 * second and tenth is inside the noise, and a table of twelve implies a
 * precision this data does not have.
 */

const db = require('./db');
const sleeper = require('./sleeper');

const POSITIONS = ['QB', 'RB', 'WR', 'TE'];

/**
 * The line between a startable finish and a bench one, per position.
 *
 * Derived from the league's own roster_positions rather than hardcoded, and a
 * flat "top 20" is wrong in both directions in a 12-team league: it drops
 * genuinely startable WR22-WR27 finishes (six of them here, including Jakobi
 * Meyers at WR55 to WR23) and it waves through a QB18 nobody could start.
 *
 * The flex split is a judgement call — roughly how flex slots get filled in
 * practice, not a measurement. It only moves each line by a rank or two, which
 * is well inside the resolution of the question being asked.
 */
function startableLine(leagueBlock) {
  const positions = leagueBlock?.roster_positions || [];
  const teams = Number(leagueBlock?.total_rosters) || 0;
  const slots = p => positions.filter(x => x === p).length * teams;

  const flex = slots('FLEX');
  const superFlex = slots('SUPER_FLEX');

  return {
    QB: slots('QB') + superFlex,
    RB: slots('RB') + Math.round(flex * 0.45),
    WR: slots('WR') + Math.round(flex * 0.40),
    TE: slots('TE') + Math.round(flex * 0.15),
  };
}

/**
 * Turn one season's stored snapshot into annotated picks.
 *
 * PICK ORDER COMES FROM ARRAY ORDER. src/sleeper.js trims each pick to
 * player_id, roster_id and round, dropping pick_no — but it maps over Sleeper's
 * response, which is already sorted by pick_no. Verified across all six stored
 * seasons: rounds are monotonic and round two is the exact reverse of round one
 * in every one of them. So the index IS the pick number, and no schema change
 * or backfill is needed to know that a player went WR33 rather than "somewhere
 * in round 4".
 *
 * THE DRAFTER IS THE ROSTER'S OWNER. picked_by is also trimmed away, but
 * roster_id joins to owner_id through the same snapshot, and owner_id is the
 * Sleeper account — the only identifier stable across seasons. Display names
 * are not: two of these twelve renamed themselves mid-history, so a label taken
 * from the wrong season silently reattributes a six-year record.
 *
 * A drafted player with no stats row at all is skipped, which shifts the slots
 * below him by one. Across six seasons that is two picks, both in 2020 and both
 * jokes — Ray Rice and Aaron Hernandez, retired long before the draft.
 */
function annotate({ season, payload, stats }) {
  const owner = new Map((payload.rosters || []).map(r => [Number(r.roster_id), r.owner_id]));
  const picks = payload?.draft?.picks || [];
  const takenAt = Object.fromEntries(POSITIONS.map(p => [p, 0]));
  const out = [];

  for (const pick of picks) {
    const finish = stats.get(String(pick.player_id));
    if (!finish || !POSITIONS.includes(finish.position)) continue;

    const sleeperUserId = owner.get(Number(pick.roster_id));
    if (!sleeperUserId) continue;

    const draftedRank = ++takenAt[finish.position];
    out.push({
      season,
      sleeperUserId,
      position: finish.position,
      player: finish.name,
      round: pick.round,
      draftedRank,
      finishRank: finish.rank,
      gamesPlayed: finish.gamesPlayed,
      // Null rather than zero when he never ranked. A player who did not exist
      // at the position all year has no delta, only an outcome.
      gain: finish.rank == null ? null : draftedRank - finish.rank,
    });
  }
  return out;
}

/**
 * The three lists.
 *
 * Steals and whiffs are capped and dense — every season here offers 25 to 50
 * candidates for each, so there is never a reason to reach. Cursed is capped
 * but NOT padded: an early pick who played four games or fewer is genuinely
 * rare, one or two per season and in 2022 and 2024 exactly one. A year where
 * nobody got wrecked should say nothing rather than widen its own definition
 * until it finds someone, which would make the word mean different things in
 * different windows.
 */
function buckets(picks, startable, { limit = 3, perSeason = true } = {}) {
  const capBySeason = rows => {
    if (!perSeason) return rows.slice(0, limit);
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      if (seen.has(r.season)) continue;
      seen.add(r.season);
      out.push(r);
      if (out.length === limit) break;
    }
    // A single-season window can only ever yield one row under that rule, so
    // fall back to filling from the same season once every season is spoken for.
    if (out.length < limit) {
      for (const r of rows) {
        if (out.includes(r)) continue;
        out.push(r);
        if (out.length === limit) break;
      }
    }
    return out;
  };

  const steals = picks
    .filter(p => p.gain > 0 && p.finishRank != null && p.finishRank <= startable[p.position])
    .sort((a, b) => b.gain - a.gain);

  const whiffs = picks
    .filter(p => p.gain < 0 && p.round <= 5 && p.gamesPlayed >= 12)
    .sort((a, b) => a.gain - b.gain);

  const cursed = picks
    .filter(p => p.round <= 5 && p.gamesPlayed <= 4)
    .sort((a, b) => a.draftedRank - b.draftedRank);

  return {
    steals: capBySeason(steals),
    whiffs: capBySeason(whiffs),
    // Variable length by design, including empty.
    cursed: cursed.slice(0, limit),
  };
}

/**
 * The same player, a steal one year and a whiff the next.
 *
 * Brian Thomas is hpodlin's best pick of 2024 (round 9, WR43 to WR4) and
 * tdermott96's worst of 2025 (round 2, WR8 to WR43) — the ranks very nearly
 * mirror each other. That line only exists because six seasons are kept, and
 * the model will not find it on its own from two separate lists.
 */
function mirrors(picks) {
  const byPlayer = new Map();
  for (const p of picks) {
    if (!p.player || p.gain == null) continue;
    const list = byPlayer.get(p.player) || [];
    list.push(p);
    byPlayer.set(p.player, list);
  }

  const out = [];
  for (const [player, seasons] of byPlayer) {
    if (seasons.length < 2) continue;
    const up = seasons.filter(s => s.gain >= 15).sort((a, b) => b.gain - a.gain)[0];
    const down = seasons.filter(s => s.gain <= -15 && s.gamesPlayed >= 12)
      .sort((a, b) => a.gain - b.gain)[0];
    if (up && down && up.season !== down.season) out.push({ player, up, down });
  }
  /*
   * Ranked by total swing, with a thumb on the scale for consecutive seasons.
   * "Best pick of 2024 and worst of 2025" carries a year-after sting that the
   * same swing spread over 2021 and 2024 does not, and the bonus is sized to
   * reorder near-ties rather than to promote a weak pair over a strong one.
   */
  const swing = m => (m.up.gain - m.down.gain)
    + (Math.abs(Number(m.up.season) - Number(m.down.season)) === 1 ? 25 : 0);
  return out.sort((a, b) => swing(b) - swing(a));
}

// ------------------------------------------------------------- assembly ----

/**
 * Everything, for one league line.
 *
 * `seasons` narrows the window — ['2025'] answers "last year" and the same
 * filters hold, because scarcity was never the constraint. Startable is
 * computed from EACH season's own roster settings, so a 2020 question is not
 * scored against 2025's lineup rules.
 */
async function analyze(sleeperLeagueId, { seasons = null } = {}) {
  const { rows } = await db.query(
    `select s.season, s.payload
       from snapshots s
       join leagues l on l.id = s.league_id
      where l.sleeper_league_id = any($1::text[]) and s.kind = 'final'
      order by s.season asc`,
    [(await require('./history').chain(sleeperLeagueId)).map(s => s.league_id)]
  );
  if (!rows.length) return null;

  const wanted = rows.filter(r => !seasons || seasons.includes(String(r.season)));
  if (!wanted.length) return null;

  // Display names from the LATEST season present, for the reason in annotate().
  const names = new Map();
  for (const { payload } of rows) {
    for (const u of payload.users || []) names.set(u.user_id, u.display_name);
  }

  const picks = [];
  let startable = null;
  for (const { season, payload } of wanted) {
    const stats = await sleeper.seasonStats(season);
    startable = startableLine(payload.league);
    for (const p of annotate({ season, payload, stats })) {
      picks.push({ ...p, manager: names.get(p.sleeperUserId) || p.sleeperUserId, startable });
    }
  }

  return {
    seasons: wanted.map(r => String(r.season)),
    startable,
    ...buckets(picks, startable),
    mirrors: mirrors(picks).slice(0, 2),
    picks,
  };
}

// --------------------------------------------------------------- prompt ----

const move = p => `${p.position}${p.draftedRank} -> ` +
  (p.finishRank == null ? 'never ranked' : `${p.position}${p.finishRank}`);

/**
 * One block for the prompt, in the shape careerBlock already established:
 * computed facts, phrased by the model, never numbers it has to derive.
 *
 * `names` maps sleeper_user_id to the person's real name. Without it the model
 * cannot connect "Sean" in KNOWN PEOPLE to "smeadows" here, and it is instructed
 * not to guess — which once produced a flatly correct "I don't know" with the
 * answer sitting four lines below in a block it could not join.
 */
function draftBlock(result, names = new Map()) {
  if (!result) return '';
  const { steals, whiffs, cursed } = result;
  if (!steals.length && !whiffs.length && !cursed.length) return '';

  const who = p => {
    const known = names.get(p.sleeperUserId);
    return known && p.manager && known !== p.manager ? `${known} (${p.manager})`
         : known || p.manager || p.sleeperUserId;
  };
  const line = p => `  ${p.season} ${who(p)}: ${p.player}, round ${p.round}, ${move(p)}`;

  const span = result.seasons.length === 1
    ? result.seasons[0]
    : `${result.seasons[0]}-${result.seasons.at(-1)}`;

  const L = [`DRAFT HISTORY (${span}). Draft position against where the player actually`
           + ` finished at his position. These are the only draft facts you have. Do not`
           + ` rank the managers against each other, the differences are not meaningful:`];

  if (steals.length) {
    L.push('  BEST PICKS (finished as a startable player, so the value was real):');
    steals.forEach(p => L.push(line(p)));
  }
  if (whiffs.length) {
    L.push('  WORST PICKS (rounds 1-5, played 12+ games, so no injury excuse):');
    whiffs.forEach(p => L.push(line(p)));
  }
  if (cursed.length) {
    L.push('  WRECKED BY INJURY (early pick, barely played. NOT the drafter\'s fault,'
         + ' say so if it comes up):');
    cursed.forEach(p => L.push(`${line(p)}, ${p.gamesPlayed} games`));
  }
  for (const m of result.mirrors || []) {
    L.push(`  SAME PLAYER, BOTH WAYS: ${m.player} was ${who(m.up)}'s best pick in ${m.up.season}`
         + ` (${move(m.up)}) and ${who(m.down)}'s worst in ${m.down.season} (${move(m.down)}).`);
  }
  return L.join('\n');
}

module.exports = {
  analyze, startableLine, annotate, buckets, mirrors, draftBlock,
  POSITIONS,
};
