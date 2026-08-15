/**
 * Derive roast-worthy facts from a week snapshot.
 *
 * Deliberately pure and LLM-free. Language models are unreliable at arithmetic
 * and will confidently invent a margin of victory; every number the agent says
 * out loud should be computed here and handed to the model as a fact. The model
 * supplies voice, never math.
 *
 * That split also makes the interesting half testable: this file can be checked
 * against a real week without an API key.
 *
 * Sleeper matchup shape:
 *   { roster_id, matchup_id, points, starters: [pid], starters_points: [num],
 *     players: [pid], players_points: { pid: num } }
 */

const round = n => Math.round(Number(n || 0) * 100) / 100;

/** roster_id -> { name, ownerId } from the snapshot's users + rosters. */
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

/** Points a manager left on the bench, and the single worst individual case. */
function benchAnalysis(m, players) {
  const starters = new Set(m.starters || []);
  const pts = m.players_points || {};
  const bench = [];

  for (const pid of m.players || []) {
    if (starters.has(pid)) continue;
    const p = Number(pts[pid] || 0);
    bench.push({ pid, points: round(p), name: players.get(pid)?.full_name || pid, position: players.get(pid)?.position || null });
  }
  bench.sort((a, b) => b.points - a.points);

  const startedList = (m.starters || []).map((pid, i) => ({
    pid,
    points: round((m.starters_points || [])[i] ?? 0),
    name: players.get(pid)?.full_name || pid,
    position: players.get(pid)?.position || null,
  })).filter(s => s.pid && s.pid !== '0');
  startedList.sort((a, b) => a.points - b.points);

  const topBench = bench[0] || null;
  const worstStarter = startedList[0] || null;

  // The classic fantasy indictment: a bench player who outscored someone the
  // manager actually started, at the same position.
  let regret = null;
  if (topBench && worstStarter && topBench.points > worstStarter.points) {
    const samePos = bench.find(b => b.position && b.position === worstStarter.position && b.points > worstStarter.points);
    const pick = samePos || topBench;
    regret = {
      benched: pick,
      started: worstStarter,
      swing: round(pick.points - worstStarter.points),
      samePosition: Boolean(samePos),
    };
  }

  return {
    benchTotal: round(bench.reduce((s, b) => s + b.points, 0)),
    topBench,
    worstStarter,
    regret,
    zeroStarters: startedList.filter(s => s.points === 0),
  };
}

/**
 * @param payload  a snapshot payload (see sleeper.weekSnapshot)
 * @param players  Map(player_id -> {full_name, position, team})
 */
function weekFacts(payload, players = new Map()) {
  const names = teamNames(payload);
  const matchups = payload.matchups || [];

  const teams = matchups.map(m => {
    const t = names.get(m.roster_id) || { name: `Roster ${m.roster_id}` };
    return {
      rosterId: m.roster_id,
      matchupId: m.matchup_id,
      team: t.name,
      manager: t.manager,
      record: t.record,
      points: round(m.points),
      ...benchAnalysis(m, players),
    };
  });

  // Pair rosters by matchup_id into head-to-head results.
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
    });
  }
  games.sort((a, b) => b.margin - a.margin);

  const scored = [...teams].sort((a, b) => b.points - a.points);
  const withRegret = teams.filter(t => t.regret).sort((a, b) => b.regret.swing - a.regret.swing);

  return {
    season: payload.league?.season,
    week: payload.week,
    leagueName: payload.league?.name,
    teamCount: teams.length,
    games,
    standingsThisWeek: scored.map(t => ({ team: t.team, points: t.points, record: t.record })),
    highScore: scored[0] ? { team: scored[0].team, points: scored[0].points } : null,
    lowScore: scored[scored.length - 1]
      ? { team: scored[scored.length - 1].team, points: scored[scored.length - 1].points }
      : null,
    blowout: games[0] || null,
    nailbiter: games.length ? games[games.length - 1] : null,
    // The single most roastable decision of the week.
    biggestRegret: withRegret[0]
      ? {
          team: withRegret[0].team,
          benched: withRegret[0].regret.benched.name,
          benchedPoints: withRegret[0].regret.benched.points,
          started: withRegret[0].regret.started.name,
          startedPoints: withRegret[0].regret.started.points,
          swing: withRegret[0].regret.swing,
          samePosition: withRegret[0].regret.samePosition,
        }
      : null,
    mostBenchPoints: [...teams].sort((a, b) => b.benchTotal - a.benchTotal)[0]
      ? { team: [...teams].sort((a, b) => b.benchTotal - a.benchTotal)[0].team,
          points: [...teams].sort((a, b) => b.benchTotal - a.benchTotal)[0].benchTotal }
      : null,
    gooseEggs: teams
      .filter(t => t.zeroStarters.length)
      .map(t => ({ team: t.team, players: t.zeroStarters.map(s => `${s.name} (${s.position || '?'})`) })),
  };
}

module.exports = { weekFacts, teamNames, benchAnalysis, round };
