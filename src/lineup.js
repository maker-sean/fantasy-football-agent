/**
 * Positional eligibility and optimal-lineup solving.
 *
 * Without this, "points left on the bench" is a meaningless number and
 * "you benched X and started Y" is often an impossible swap. A QB on the bench
 * cannot replace a WR in a WR slot — claiming otherwise in a league chat is the
 * kind of error that gets a bot muted by people who know the rules better than
 * it does.
 *
 * Sleeper alignment: `starters[i]` occupies the i-th NON-BN entry of the
 * league's `roster_positions`. Verified against a real league:
 *   roster_positions = ["QB","RB","RB","WR","WR","TE","FLEX","K","DEF","BN",...]
 *   starters         = [QB,   RB,  RB,  WR,  WR,  TE,  RB,    K,   DEF]
 */

/** Which player positions may fill each lineup slot. */
const SLOT_ELIGIBILITY = {
  QB: ['QB'],
  RB: ['RB'],
  WR: ['WR'],
  TE: ['TE'],
  K: ['K'],
  DEF: ['DEF'],
  DL: ['DL', 'DE', 'DT'],
  LB: ['LB'],
  DB: ['DB', 'CB', 'S'],
  FLEX: ['RB', 'WR', 'TE'],
  WRRB_FLEX: ['WR', 'RB'],
  WRRB_WRT: ['WR', 'RB', 'TE'],
  REC_FLEX: ['WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  IDP_FLEX: ['DL', 'LB', 'DB', 'DE', 'DT', 'CB', 'S'],
};

const BENCH_SLOTS = new Set(['BN', 'IR', 'TAXI']);

function eligiblePositions(slot) {
  return SLOT_ELIGIBILITY[String(slot).toUpperCase()] || [];
}

function canFill(slot, position) {
  if (!position) return false;
  return eligiblePositions(slot).includes(String(position).toUpperCase());
}

/** The startable slots, in the order `starters[]` uses. */
function activeSlots(rosterPositions = []) {
  return rosterPositions.filter(s => !BENCH_SLOTS.has(String(s).toUpperCase()));
}

/**
 * Slot names this table does not recognize.
 *
 * This matters more than it looks. An unknown slot has NO eligible positions,
 * so the optimal-lineup solver silently leaves it empty and under-reports what
 * a manager could have scored — a wrong number stated confidently in a league
 * chat. Every caller should check this and refuse to publish rather than
 * publish something wrong.
 */
function unknownSlots(rosterPositions = []) {
  return [...new Set(
    activeSlots(rosterPositions)
      .map(s => String(s).toUpperCase())
      .filter(s => !SLOT_ELIGIBILITY[s])
  )];
}

/**
 * Human-readable description of one league's actual lineup rules, derived from
 * that league's own roster_positions. Nothing here is hardcoded to a format —
 * a 2QB league, a SUPERFLEX league, and a TE-premium league all describe
 * themselves correctly.
 */
function describeRules(rosterPositions = []) {
  const slots = activeSlots(rosterPositions);
  const counts = new Map();
  for (const s of slots) {
    const k = String(s).toUpperCase();
    counts.set(k, (counts.get(k) || 0) + 1);
  }

  const qbCapable = slots.filter(s => canFill(s, 'QB')).length;
  const flexish = [...counts.keys()].filter(k => (SLOT_ELIGIBILITY[k] || []).length > 1);

  return {
    slots,
    starterCount: slots.length,
    benchCount: rosterPositions.filter(s => BENCH_SLOTS.has(String(s).toUpperCase())).length,
    counts: Object.fromEntries(counts),
    qbSlots: qbCapable,
    superflex: qbCapable > 1,
    flexTypes: flexish.map(k => ({ slot: k, accepts: SLOT_ELIGIBILITY[k] })),
    unknown: unknownSlots(rosterPositions),
    summary: [...counts].map(([k, n]) => (n > 1 ? `${n}×${k}` : k)).join(', '),
  };
}

/**
 * Exact optimal lineup via bitmask DP over slots.
 *
 * Greedy assignment ("best player to the most restrictive open slot") is the
 * usual shortcut and is *usually* right, but it can be beaten on rosters with
 * overlapping flex eligibility — and a wrong optimal makes the headline
 * "points left on the table" number wrong. Rosters are tiny (≤ ~11 slots,
 * ≤ ~25 players), so the exact solve is cheap: O(players × 2^slots).
 *
 * @param roster  [{ pid, points, position }]
 * @param slots   ['QB','RB',...] (already BN-filtered)
 * @returns { total, assignment: [{slot, pid, points, slotIndex}] }
 */
function optimalLineup(roster, slots) {
  const S = slots.length;
  if (!S) return { total: 0, assignment: [] };
  const FULL = 1 << S;

  // Precompute which slots each player can fill.
  const cand = roster.map(p => {
    let mask = 0;
    for (let s = 0; s < S; s++) if (canFill(slots[s], p.position)) mask |= (1 << s);
    return mask;
  });

  // dp[i][mask] = max points using the first i players with `mask` filled.
  //
  // The full 2D table matters: a rolling 1D array gives the right TOTAL but an
  // unreliable backtrack, because a parent pointer can reference a state from a
  // later player generation — which silently assigns one player to two slots.
  // Rosters are tiny (≤ ~25 players × 2^11 masks), so keep the history.
  const N = roster.length;
  const dp = Array.from({ length: N + 1 }, () => new Float64Array(FULL).fill(-Infinity));
  dp[0][0] = 0;

  for (let i = 0; i < N; i++) {
    const p = roster[i];
    const m = cand[i];
    for (let mask = 0; mask < FULL; mask++) {
      const cur = dp[i][mask];
      if (cur === -Infinity) continue;
      if (cur > dp[i + 1][mask]) dp[i + 1][mask] = cur;   // skip player i
      if (!m) continue;
      for (let s = 0; s < S; s++) {
        const bit = 1 << s;
        if (!(m & bit) || (mask & bit)) continue;
        const val = cur + p.points;
        if (val > dp[i + 1][mask | bit]) dp[i + 1][mask | bit] = val;
      }
    }
  }

  // The best reachable state may not fill every slot (e.g. no kicker rostered).
  let bestMask = 0;
  for (let mask = 0; mask < FULL; mask++) {
    if (dp[N][mask] > dp[N][bestMask]) bestMask = mask;
  }

  // Walk backwards: at each step, either player i-1 was skipped (value carried
  // over unchanged) or it filled exactly one slot in the current mask.
  const assignment = [];
  let mask = bestMask;
  for (let i = N; i > 0; i--) {
    if (dp[i][mask] === dp[i - 1][mask]) continue;        // player i-1 unused
    const p = roster[i - 1];
    for (let s = 0; s < S; s++) {
      const bit = 1 << s;
      if (!(mask & bit)) continue;
      if (!(cand[i - 1] & bit)) continue;
      if (dp[i - 1][mask ^ bit] + p.points === dp[i][mask]) {
        assignment.push({
          slot: slots[s], slotIndex: s, pid: p.pid, points: p.points, position: p.position,
        });
        mask ^= bit;
        break;
      }
    }
  }
  assignment.reverse();

  return { total: Math.round(dp[N][bestMask] * 100) / 100, assignment };
}

/**
 * The single most defensible "you should have started X over Y" claim:
 * a bench player who was eligible for the exact slot a starter occupied, and
 * outscored them. Never crosses slot boundaries.
 */
function bestLegalSwap(starters, bench) {
  let best = null;
  for (const s of starters) {
    for (const b of bench) {
      if (!canFill(s.slot, b.position)) continue;
      const swing = b.points - s.points;
      if (swing <= 0) continue;
      if (!best || swing > best.swing) {
        best = {
          slot: s.slot,
          started: s,
          benched: b,
          swing: Math.round(swing * 100) / 100,
        };
      }
    }
  }
  return best;
}

module.exports = {
  SLOT_ELIGIBILITY, BENCH_SLOTS,
  eligiblePositions, canFill, activeSlots, unknownSlots, describeRules,
  optimalLineup, bestLegalSwap,
};
