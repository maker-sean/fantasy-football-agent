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

/**
 * Which player positions may fill each lineup slot.
 *
 * The granular defensive positions are load-bearing, not thoroughness. Sleeper
 * labels defenders with specific positions, and a league's slots are generic:
 * an OLB or ILB must be startable in an `LB` slot, a CB/SS/FS in a `DB` slot,
 * a DE/DT/NT in a `DL` slot. Counts from a real 12,218-player pull:
 *   LB 1162 · CB 1034 · DB 861 · DE 691 · DT 645 · DL 303 · OLB 215
 *   SS 162 · FS 145 · ILB 129 · NT 89 · S 45 · DEF 32
 * Omitting any of them makes those players silently unstartable — the optimal
 * lineup under-reports and a legal swap is never suggested.
 */
const DL_POSITIONS = ['DL', 'DE', 'DT', 'NT'];
const LB_POSITIONS = ['LB', 'OLB', 'ILB', 'MLB'];
const DB_POSITIONS = ['DB', 'CB', 'S', 'SS', 'FS'];
const IDP_POSITIONS = [...DL_POSITIONS, ...LB_POSITIONS, ...DB_POSITIONS];

// A fullback is a running back for fantasy purposes in every league that
// rosters one.
const RB_POSITIONS = ['RB', 'FB'];

const SLOT_ELIGIBILITY = {
  QB: ['QB'],
  RB: RB_POSITIONS,
  WR: ['WR'],
  TE: ['TE'],
  K: ['K', 'K/P'],
  DEF: ['DEF', 'DST', 'D/ST'],

  // Individual defensive players.
  DL: DL_POSITIONS,
  LB: LB_POSITIONS,
  DB: DB_POSITIONS,
  IDP_FLEX: IDP_POSITIONS,
  IDP: IDP_POSITIONS,
  DP: IDP_POSITIONS,
  DEF_FLEX: IDP_POSITIONS,

  // Offensive flexes.
  FLEX: [...RB_POSITIONS, 'WR', 'TE'],
  WRRB_FLEX: ['WR', ...RB_POSITIONS],
  WRRB_WRT: ['WR', ...RB_POSITIONS, 'TE'],
  REC_FLEX: ['WR', 'TE'],
  SUPER_FLEX: ['QB', ...RB_POSITIONS, 'WR', 'TE'],
};

const BENCH_SLOTS = new Set(['BN', 'IR', 'TAXI']);

/** Every position any slot in this table can start. */
const STARTABLE_POSITIONS = new Set(Object.values(SLOT_ELIGIBILITY).flat());

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
 * Rostered positions that cannot fill ANY slot in this league.
 *
 * The mirror of `unknownSlots`, and the same silent failure in the other
 * direction: if a league has an `LB` slot and our table doesn't map `OLB`, that
 * player is treated as unstartable — the optimal lineup under-reports and a
 * legal swap is never suggested. No error is raised anywhere.
 *
 * Some hits are legitimate (a stashed offensive lineman, a punter), so this is
 * a signal to check the map, not proof of a bug.
 */
function unstartablePositions(rosterPositionsList, leagueSlots) {
  const slots = activeSlots(leagueSlots);
  const out = new Set();
  for (const pos of rosterPositionsList) {
    if (!pos) continue;
    const p = String(pos).toUpperCase();
    if (!slots.some(s => canFill(s, p))) out.add(p);
  }
  return [...out];
}

/**
 * Human-readable description of one league's actual lineup rules, derived from
 * that league's own roster_positions. Nothing here is hardcoded to a format —
 * a 2QB league, a SUPERFLEX league, an IDP league, and a TE-premium league all
 * describe themselves correctly.
 */
function describeRules(rosterPositions = []) {
  const slots = activeSlots(rosterPositions);
  const counts = new Map();
  for (const s of slots) {
    const k = String(s).toUpperCase();
    counts.set(k, (counts.get(k) || 0) + 1);
  }

  const qbCapable = slots.filter(s => canFill(s, 'QB')).length;
  const idp = slots.filter(s => canFill(s, 'LB') || canFill(s, 'DL') || canFill(s, 'DB')).length;
  const flexish = [...counts.keys()].filter(k => (SLOT_ELIGIBILITY[k] || []).length > 1);

  return {
    slots,
    starterCount: slots.length,
    benchCount: rosterPositions.filter(s => BENCH_SLOTS.has(String(s).toUpperCase())).length,
    counts: Object.fromEntries(counts),
    qbSlots: qbCapable,
    superflex: qbCapable > 1,
    idpSlots: idp,
    idp: idp > 0,
    teamDefense: slots.some(sl => canFill(sl, 'DEF')),
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

  // Group identical slots. Two RB slots are interchangeable, so the state only
  // needs to know HOW MANY of each type are filled — not which ones.
  //
  // This is the difference between shipping and crashing on IDP leagues. A
  // bitmask over individual slots is 2^S: a 20-slot IDP league costs ~344MB and
  // ~450ms, and a 22-slot league OOMs. Counting types instead collapses that
  // same league to ~37k states and ~12MB, because 3×DL is one type with
  // capacity 3 rather than three independent bits.
  const typeNames = [];
  const typeIndex = new Map();
  const typeSlotIdx = [];
  for (let s = 0; s < S; s++) {
    const key = String(slots[s]).toUpperCase();
    if (!typeIndex.has(key)) {
      typeIndex.set(key, typeNames.length);
      typeNames.push(key);
      typeSlotIdx.push([]);
    }
    typeSlotIdx[typeIndex.get(key)].push(s);
  }

  const T = typeNames.length;
  const cap = typeSlotIdx.map(a => a.length);

  // Mixed-radix encoding: state = Σ usedₜ · multₜ
  const mult = new Array(T);
  let states = 1;
  for (let t = 0; t < T; t++) { mult[t] = states; states *= (cap[t] + 1); }

  // Which slot TYPES each player can fill.
  const cand = roster.map(p => {
    const list = [];
    for (let t = 0; t < T; t++) if (canFill(typeNames[t], p.position)) list.push(t);
    return list;
  });

  // Full 2D history. A rolling 1D array gives the right TOTAL but an unreliable
  // backtrack — a parent pointer can reference a later player's generation,
  // which silently assigns one player to two slots.
  const N = roster.length;
  const dp = Array.from({ length: N + 1 }, () => new Float64Array(states).fill(-Infinity));
  dp[0][0] = 0;

  for (let i = 0; i < N; i++) {
    const p = roster[i];
    const cs = cand[i];
    const cur = dp[i];
    const next = dp[i + 1];
    for (let st = 0; st < states; st++) {
      const v = cur[st];
      if (v === -Infinity) continue;
      if (v > next[st]) next[st] = v;                     // skip player i
      for (const t of cs) {
        const used = Math.floor(st / mult[t]) % (cap[t] + 1);
        if (used >= cap[t]) continue;
        const ns = st + mult[t];
        const val = v + p.points;
        if (val > next[ns]) next[ns] = val;
      }
    }
  }

  // The best reachable state may not fill every slot (e.g. no kicker rostered).
  let bestState = 0;
  for (let st = 0; st < states; st++) if (dp[N][st] > dp[N][bestState]) bestState = st;

  // Walk backwards: player i-1 was either skipped (value carried over) or
  // filled exactly one slot type.
  const perType = typeSlotIdx.map(() => []);
  let st = bestState;
  for (let i = N; i > 0; i--) {
    if (dp[i][st] === dp[i - 1][st]) continue;            // player i-1 unused
    const p = roster[i - 1];
    for (const t of cand[i - 1]) {
      const used = Math.floor(st / mult[t]) % (cap[t] + 1);
      if (used === 0) continue;
      if (dp[i - 1][st - mult[t]] + p.points === dp[i][st]) {
        perType[t].push(p);
        st -= mult[t];
        break;
      }
    }
  }

  // Expand type counts back onto concrete slot indices, so callers still see
  // "FLEX" vs "RB" and the original lineup order.
  const assignment = [];
  for (let t = 0; t < T; t++) {
    perType[t].forEach((p, k) => {
      const slotIndex = typeSlotIdx[t][k];
      assignment.push({
        slot: slots[slotIndex], slotIndex, pid: p.pid, points: p.points, position: p.position,
      });
    });
  }
  assignment.sort((a, b) => a.slotIndex - b.slotIndex);

  return { total: Math.round(dp[N][bestState] * 100) / 100, assignment };
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
  eligiblePositions, canFill, activeSlots, unknownSlots, unstartablePositions, describeRules,
  STARTABLE_POSITIONS, IDP_POSITIONS,
  optimalLineup, bestLegalSwap,
};
