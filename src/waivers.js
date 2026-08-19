/**
 * Waiver wire drama, from FAAB bids.
 *
 * Two things worth saying out loud in a recap, and both are pure arithmetic on
 * data Sleeper already reports — no projections, nothing to invent:
 *
 *   - the squeaker: won a player by a dollar
 *   - the blowout: paid far more than anyone else was willing to
 *
 * Only leagues using FAAB (waiver_type 2) have bids at all. Leagues on rolling
 * priority record `settings.seq` and nothing else, so there is nothing to
 * compare and this returns empty rather than inventing a narrative — one of the
 * two leagues on file is exactly that case.
 */

const FAAB = 2;

/** Sleeper's waiver_type: 0 rolling priority, 1 reverse standings, 2 FAAB. */
const usesFaab = leagueSettings => Number(leagueSettings?.waiver_type) === FAAB;

/**
 * Group a week's waiver transactions into contests — one per player claimed.
 *
 * The losing bids are the whole point and they are already there: Sleeper
 * records unsuccessful claims as `status: 'failed'` with the bid intact. Without
 * them there is no margin to report, only a price.
 */
function contests(transactions) {
  const byPlayer = new Map();

  for (const t of transactions || []) {
    if (t.type !== 'waiver') continue;
    const bid = t.settings?.waiver_bid;
    if (bid == null) continue;               // not a FAAB league

    for (const [playerId, rosterId] of Object.entries(t.adds || {})) {
      if (!byPlayer.has(playerId)) byPlayer.set(playerId, []);
      byPlayer.get(playerId).push({
        playerId,
        rosterId: Number(rosterId),
        bid: Number(bid),
        won: t.status === 'complete',
        seq: t.settings?.seq ?? null,
      });
    }
  }

  const out = [];
  for (const [playerId, claims] of byPlayer) {
    const winner = claims.find(c => c.won);
    if (!winner) continue;                   // everyone failed; nobody got him

    const losers = claims.filter(c => !c.won).sort((a, b) => b.bid - a.bid);
    const runnerUp = losers[0] || null;

    out.push({
      playerId,
      winner,
      runnerUp,
      losers,
      contested: losers.length > 0,
      // null when unopposed: there is no margin against nobody, and reporting
      // one would imply a rival that did not exist.
      margin: runnerUp ? winner.bid - runnerUp.bid : null,
      bidders: claims.length,
    });
  }
  return out.sort((a, b) => b.winner.bid - a.winner.bid);
}

/**
 * Pick out the ones worth mentioning.
 *
 * Thresholds are calibrated against a real FAAB season (208 bids, $0-$81)
 * rather than chosen a priori — see scripts/waivers.js, which prints the
 * distribution for any league.
 */
function findDrama(all, opts = {}) {
  const {
    squeakerMax = 1,        // won by this much or less
    blowoutMargin = 20,     // beat the next bid by this much
    unopposedMin = 15,      // paid this much with nobody bidding against them
  } = opts;

  const squeakers = all.filter(c => c.contested && c.margin <= squeakerMax);
  const blowouts = all.filter(c => c.contested && c.margin >= blowoutMargin);
  const unopposed = all.filter(c => !c.contested && c.winner.bid >= unopposedMin);

  return { squeakers, blowouts, unopposed };
}

/**
 * Deterministic prose for the recap. No model involved, so nothing here can
 * drift from the numbers it is describing.
 */
function describe(drama, { names = new Map(), teams = new Map() } = {}) {
  const player = id => names.get(id)?.full_name || `player ${id}`;
  const team = rid => teams.get(rid) || `Roster ${rid}`;
  const lines = [];

  for (const c of drama.squeakers) {
    const by = c.margin === 0 ? 'tied and won on priority' : `by $${c.margin}`;
    lines.push(`${team(c.winner.rosterId)} got ${player(c.playerId)} for $${c.winner.bid} — ${by} over ${team(c.runnerUp.rosterId)} at $${c.runnerUp.bid}.`);
  }

  for (const c of drama.blowouts) {
    lines.push(`${team(c.winner.rosterId)} paid $${c.winner.bid} for ${player(c.playerId)}. Next closest was $${c.runnerUp.bid}. That's $${c.margin} more than anyone else thought he was worth.`);
  }

  for (const c of drama.unopposed) {
    lines.push(`${team(c.winner.rosterId)} bid $${c.winner.bid} on ${player(c.playerId)}. Nobody else bid at all.`);
  }

  return lines;
}

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

module.exports = { usesFaab, contests, findDrama, describe, teamNames, FAAB };
