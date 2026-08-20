/**
 * Derive roast-worthy facts from a week snapshot.
 *
 * Deliberately pure and LLM-free. Language models are unreliable at arithmetic
 * and will confidently invent a margin of victory; every number the agent says
 * out loud should be computed here and handed to the model as a fact. The model
 * supplies voice, never math.
 *
 * Fantasy rules are enforced in src/lineup.js — a bench QB cannot replace a
 * starting WR, and "points left on the bench" is meaningless without slot
 * eligibility. The honest number is optimal-lineup minus actual-lineup.
 */

const { activeSlots, optimalLineup, bestLegalSwap, canFill, describeRules, unstartablePositions } = require('./lineup');
const waivers = require('./waivers');

const round = n => Math.round(Number(n || 0) * 100) / 100;

/** roster_id -> team/manager/record from the snapshot's users + rosters. */
function teamNames(payload) {
  const byUser = new Map((payload.users || []).map(u => [u.user_id, u]));
  const out = new Map();
  for (const r of payload.rosters || []) {
    const u = byUser.get(r.owner_id);
    out.set(r.roster_id, {
      name: u?.metadata?.team_name || u?.display_name || u?.username || `Roster ${r.roster_id}`,
      manager: u?.display_name || u?.username || null,
      ownerId: r.owner_id,
      record: r.settings ? `${r.settings.wins}-${r.settings.losses}${r.settings.ties ? '-' + r.settings.ties : ''}` : null,
    });
  }
  return out;
}

const nameOf = (players, pid) => players.get(pid)?.full_name || pid;
const posOf = (players, pid) => players.get(pid)?.position || null;

/**
 * Slot-aware lineup analysis for one team-week.
 *
 * `starters[i]` occupies the i-th non-BN slot, so the slot each player actually
 * filled is knowable — which is what makes a swap claim legal or nonsense.
 */
function lineupAnalysis(m, players, slots) {
  const pts = m.players_points || {};

  const starters = (m.starters || []).map((pid, i) => ({
    pid,
    slot: slots[i] || 'UNKNOWN',
    slotIndex: i,
    points: round((m.starters_points || [])[i] ?? pts[pid] ?? 0),
    name: nameOf(players, pid),
    position: posOf(players, pid),
  })).filter(s => s.pid && s.pid !== '0');

  const startedIds = new Set(starters.map(s => s.pid));
  const bench = (m.players || [])
    .filter(pid => !startedIds.has(pid))
    .map(pid => ({
      pid,
      points: round(pts[pid] ?? 0),
      name: nameOf(players, pid),
      position: posOf(players, pid),
    }))
    .sort((a, b) => b.points - a.points);

  // Every rostered player is a candidate for the optimal lineup — including
  // the ones who were actually started.
  const all = [...starters.map(s => ({ pid: s.pid, points: s.points, position: s.position })),
               ...bench.map(b => ({ pid: b.pid, points: b.points, position: b.position }))];

  const optimal = optimalLineup(all, slots);
  const actual = round(starters.reduce((s, x) => s + x.points, 0));
  const swap = bestLegalSwap(starters, bench);

  return {
    starters,
    bench,
    actualPoints: actual,
    optimalPoints: optimal.total,
    // The honest "you blew it by this much" number: what a perfect lineup from
    // the SAME roster would have scored, minus what they actually started.
    pointsLeftOnTable: round(Math.max(0, optimal.total - actual)),
    optimalLineup: optimal.assignment.map(a => ({
      slot: a.slot, name: nameOf(players, a.pid), points: round(a.points), position: a.position,
    })),
    bestLegalSwap: swap,
    zeroStarters: starters.filter(s => s.points === 0),
    // Bench players who could not have started anywhere — the reason raw
    // "bench points" overstates the mistake.
    unusableBench: bench.filter(b => !slots.some(sl => canFill(sl, b.position))),
  };
}

/**
 * @param payload  a snapshot payload (see sleeper.weekSnapshot)
 * @param players  Map(player_id -> {full_name, position, team})
 */
function weekFacts(payload, players = new Map()) {
  const names = teamNames(payload);
  const rosterPositions = payload.league?.roster_positions || [];
  const slots = activeSlots(rosterPositions);
  const matchups = payload.matchups || [];

  // Rules come from THIS league's own roster_positions — a 2QB league, a
  // superflex league, and a league whose flex excludes TE all resolve
  // correctly without any per-league configuration.
  const rules = describeRules(rosterPositions);

  const teams = matchups.map(m => {
    const t = names.get(m.roster_id) || { name: `Roster ${m.roster_id}` };
    return {
      rosterId: m.roster_id,
      matchupId: m.matchup_id,
      team: t.name,
      manager: t.manager,
      record: t.record,
      points: round(m.points),
      ...lineupAnalysis(m, players, slots),
    };
  });

  const byMatchup = new Map();
  for (const t of teams) {
    if (t.matchupId == null) continue;
    if (!byMatchup.has(t.matchupId)) byMatchup.set(t.matchupId, []);
    byMatchup.get(t.matchupId).push(t);
  }

  const games = [];
  for (const [, pair] of byMatchup) {
    if (pair.length !== 2) continue;
    const [a, b] = pair.sort((x, y) => y.points - x.points);
    games.push({
      winner: a.team, winnerPoints: a.points,
      loser: b.team, loserPoints: b.points,
      margin: round(a.points - b.points),
      // The cruellest fact in fantasy: their optimal lineup would have won it.
      loserCouldHaveWon: b.optimalPoints > a.points
        ? { team: b.team, optimal: b.optimalPoints, neededToWin: round(a.points - b.points) }
        : null,
    });
  }
  games.sort((a, b) => b.margin - a.margin);

  const scored = [...teams].sort((a, b) => b.points - a.points);
  const byLeft = [...teams].sort((a, b) => b.pointsLeftOnTable - a.pointsLeftOnTable);
  const withSwap = teams.filter(t => t.bestLegalSwap)
    .sort((a, b) => b.bestLegalSwap.swing - a.bestLegalSwap.swing);

  // Finished prose, not raw figures, and that is on purpose. src/waivers.js
  // composes these lines deterministically, so the dollar amounts in the recap
  // are the dollar amounts Sleeper reported, with no model in between. They
  // reach the prompt through factsBlock like any other fact, which also means
  // src/verify.js sees the numbers and can catch the model restating them wrong.
  const waiverDrama = waivers.describe(
    waivers.findDrama(waivers.contests(payload.transactions)),
    { names: players, teams: waivers.teamNames(payload) },
  );

  return {
    season: payload.league?.season,
    week: payload.week,
    leagueName: payload.league?.name,
    teamCount: teams.length,
    rules,
    // Non-empty means the optimal-lineup numbers are unreliable for this
    // league. Callers must refuse to publish rather than publish a wrong
    // "points left on the table" figure.
    rulesWarning: (() => {
      const rostered = [...new Set(teams.flatMap(t =>
        [...t.starters, ...t.bench].map(p => p.position).filter(Boolean)))];
      const orphanPositions = unstartablePositions(rostered, rosterPositions)
        // Genuinely unstartable everywhere (stashed linemen, punters) is normal
        // and not a signal about our map.
        .filter(p => !['OL','OT','OG','G','T','C','P','LS','ATH'].includes(p));
      const problems = [];
      if (rules.unknown.length) {
        problems.push(`Unrecognized lineup slot(s): ${rules.unknown.join(', ')}.`);
      }
      if (orphanPositions.length) {
        problems.push(`Rostered position(s) that fit no slot: ${orphanPositions.join(', ')}.`);
      }
      return problems.length
        ? `${problems.join(' ')} Optimal-lineup figures may be understated — verify src/lineup.js before publishing.`
        : null;
    })(),
    slots,
    games,
    standingsThisWeek: scored.map(t => ({ team: t.team, points: t.points, record: t.record })),
    highScore: scored[0] ? { team: scored[0].team, points: scored[0].points } : null,
    lowScore: scored[scored.length - 1]
      ? { team: scored[scored.length - 1].team, points: scored[scored.length - 1].points }
      : null,
    blowout: games[0] || null,
    nailbiter: games.length ? games[games.length - 1] : null,

    // Slot-legal: the benched player was eligible for the exact slot the
    // started player occupied.
    biggestRegret: withSwap[0]
      ? {
          team: withSwap[0].team,
          slot: withSwap[0].bestLegalSwap.slot,
          benched: withSwap[0].bestLegalSwap.benched.name,
          benchedPosition: withSwap[0].bestLegalSwap.benched.position,
          benchedPoints: withSwap[0].bestLegalSwap.benched.points,
          started: withSwap[0].bestLegalSwap.started.name,
          startedPoints: withSwap[0].bestLegalSwap.started.points,
          swing: withSwap[0].bestLegalSwap.swing,
        }
      : null,

    mostPointsLeftOnTable: byLeft[0] && byLeft[0].pointsLeftOnTable > 0
      ? {
          team: byLeft[0].team,
          started: byLeft[0].actualPoints,
          optimal: byLeft[0].optimalPoints,
          left: byLeft[0].pointsLeftOnTable,
        }
      : null,

    gooseEggs: teams
      .filter(t => t.zeroStarters.length)
      .map(t => ({ team: t.team, players: t.zeroStarters.map(s => `${s.name} (${s.slot})`) })),

    // Waiver wire, from the transactions already in the snapshot.
    //
    // Deliberately gated on the bids themselves rather than on
    // league.settings.waiver_type. Rolling-priority leagues record no
    // waiver_bid at all, so contests() returns empty on its own, and every
    // snapshot captured before settings was added lacks the field entirely.
    // Reading waiver_type would make this feature fail closed on exactly the
    // archive data it was calibrated against. The data gates itself.
    waiverDrama,

    // Kept for the recap's own use; not surfaced as a headline.
    perTeam: teams.map(t => ({
      team: t.team, points: t.points, optimal: t.optimalPoints, left: t.pointsLeftOnTable,
    })),
  };
}

module.exports = { weekFacts, teamNames, lineupAnalysis, round };
