/**
 * Roster teardowns, and the draft picks people quietly abandon.
 *
 * Unlike src/waivers.js this needs no FAAB. Every league drops players, so this
 * fires for rolling-priority leagues too, which is both leagues currently on
 * file. That is the whole reason it exists: waiver drama is silent for them.
 *
 * Two things worth saying, both pure arithmetic on data already in the snapshot:
 *
 *   - the teardown: dropped a pile of players in one week
 *   - the abandoned pick: dropped someone THEY drafted, early
 *
 * Thresholds are calibrated against a real 17 week season (12 teams, 259 drops,
 * 117 team-weeks with at least one drop) rather than chosen a priori:
 *
 *   drops per team per week   p50=2  p75=3  p90=4  p95=6  max=11
 *   own picks dropped by round  rd1-5: one each   rd9: 10   rd14: 13
 *
 * The round distribution is the interesting one. Nobody thinks twice about
 * cutting a round 14 kicker, and 13 of them went. A round 1 pick went ONCE all
 * season. So the earliness is the story, not the drop.
 */

/** Dropped a pile of players in one week. p95 of the calibration season is 6. */
const TEARDOWN_DROPS = 5;

/**
 * "Early" is the first half of the draft, not a fixed round number.
 *
 * A 14 round draft and a 20 round draft do not have the same round 7. Deriving
 * it keeps this correct in a league nobody has seen yet, which is most of them.
 * Against the calibration season (14 rounds, so rounds 1-7) this fires in 9 of
 * 17 weeks: often enough to be a running joke, rare enough to still land.
 */
const earlyRoundCutoff = rounds => Math.max(1, Math.floor((rounds || 0) / 2));

/**
 * Completed drops this week, per roster.
 *
 * Only `complete` transactions count. A failed waiver claim carries the drop it
 * WOULD have made, and reporting a cut that never happened is exactly the kind
 * of confident wrongness src/verify.js exists to stop.
 */
function dropsByRoster(transactions) {
  const out = new Map();
  for (const t of transactions || []) {
    if (t.status !== 'complete') continue;
    for (const [playerId, rosterId] of Object.entries(t.drops || {})) {
      const rid = Number(rosterId);
      if (!out.has(rid)) out.set(rid, []);
      out.get(rid).push(playerId);
    }
  }
  return out;
}

/** player_id -> { rosterId, round } for everyone taken in the draft. */
function draftIndex(draft) {
  const m = new Map();
  for (const p of draft?.picks || []) {
    m.set(p.player_id, { rosterId: Number(p.roster_id), round: p.round });
  }
  return m;
}

/**
 * @param transactions  payload.transactions
 * @param draft         payload.draft, or null on any snapshot captured before
 *                      it was being stored. Without it the teardown still
 *                      works and the abandoned picks simply do not appear,
 *                      rather than the whole feature going dark.
 */
function findChurn(transactions, draft = null) {
  const byRoster = dropsByRoster(transactions);
  const index = draftIndex(draft);
  const cutoff = earlyRoundCutoff(draft?.rounds);

  const teardowns = [];
  const abandoned = [];

  for (const [rosterId, playerIds] of byRoster) {
    if (playerIds.length >= TEARDOWN_DROPS) {
      teardowns.push({ rosterId, count: playerIds.length });
    }
    if (!index.size) continue;
    for (const playerId of playerIds) {
      const pick = index.get(playerId);
      // Dropped by the same roster that drafted them. A player acquired in
      // trade and then cut is somebody else's mistake.
      if (!pick || pick.rosterId !== rosterId) continue;
      if (pick.round > cutoff) continue;
      abandoned.push({ rosterId, playerId, round: pick.round });
    }
  }

  teardowns.sort((a, b) => b.count - a.count);
  abandoned.sort((a, b) => a.round - b.round);
  return { teardowns, abandoned };
}

/**
 * Deterministic prose for the recap. No model involved, so nothing here can
 * drift from the numbers it describes.
 */
function describe(churn, { names = new Map(), teams = new Map() } = {}) {
  const player = id => names.get(id)?.full_name || `player ${id}`;
  const team = rid => teams.get(rid) || `Roster ${rid}`;
  const lines = [];

  for (const t of churn.teardowns) {
    lines.push(`${team(t.rosterId)} dropped ${t.count} players this week.`);
  }
  for (const a of churn.abandoned) {
    lines.push(`${team(a.rosterId)} dropped ${player(a.playerId)}, their own round ${a.round} pick.`);
  }
  return lines;
}

module.exports = { dropsByRoster, draftIndex, findChurn, describe, earlyRoundCutoff, TEARDOWN_DROPS };
