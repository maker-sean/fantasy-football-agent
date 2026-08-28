/**
 * What a dynasty trade is worth right now, and what the price cannot see.
 *
 * src/trades.js grades a settled REDRAFT trade on points actually scored three
 * weeks later, which is ground truth and needs no opinion. Dynasty gets none of
 * that: a 2021 dynasty trade is still resolving, so nothing here is ever a
 * verdict on how it worked out. It answers the other question — was this fair
 * when it was made — which is the one a chat actually argues about.
 *
 * WHY A LOOKUP IS ENOUGH. Dynasty market values already price the things that
 * would otherwise need modelling: age, years of team control, breakout odds,
 * how much a 29 year old running back is discounted. Sean's framing and it is
 * the right one — do not rebuild what the market has already priced. What the
 * market cannot know is the ROSTER the asset is landing on, and that is the
 * only place this adds its own judgement.
 *
 * The handcuff is the case that forced it. A second round pick was spent on the
 * backup to a starting running back who is carrying a knee injury, on the same
 * roster. Every fact needed to see that was in this database — both men on the
 * same NFL team, same position, one of them Questionable — and nothing joined
 * them. By pure value it reads as an overpay. With the roster in view it is a
 * premium somebody chose to pay, which is a different sentence and possibly a
 * different verdict.
 *
 * NOT PRICED IS SAID OUT LOUD. Future picks beyond the source's horizon have no
 * value here at all — the sheet carries 2026 and no 2027 — and a side whose
 * assets could not be priced must never come back as "worth zero". That is the
 * false absence this codebase keeps paying for.
 */

const db = require('./db');

/** Early, Mid or Late, by thirds of the round. */
function bucketFor(slot, teams) {
  if (!slot || !teams) return null;
  const third = teams / 3;
  if (slot <= third) return 'Early';
  if (slot <= third * 2) return 'Mid';
  return 'Late';
}

const ORDINAL = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th' };

/**
 * The label the value sheet uses, e.g. "2026 Early 2nd".
 *
 * Needs the slot the pick will land in, which is NOT reverse standings in every
 * league — this one's real order had a team that finished 7th picking 3rd. So
 * the actual draft order is used when a draft exists, and the standings-based
 * guess only stands in for seasons that have no draft yet. Guessing when the
 * answer is knowable is how you get a confident wrong number.
 */
function pickLabel({ season, round, slot, teams }) {
  const bucket = bucketFor(slot, teams);
  const ord = ORDINAL[round];
  if (!bucket || !ord) return null;
  return `${season} ${bucket} ${ord}`;
}

/** Slot lookup from a Sleeper draft's slot_to_roster_id, inverted. */
function slotsFromDraft(slotToRoster) {
  const out = new Map();
  for (const [slot, roster] of Object.entries(slotToRoster || {})) {
    out.set(Number(roster), Number(slot));
  }
  return out;
}

/** Standings fallback: worst finish drafts first. Only for seasons with no draft. */
function slotsFromFinish(finishes, teams) {
  const out = new Map();
  for (const [rosterId, place] of finishes || []) {
    if (place) out.set(Number(rosterId), teams - Number(place) + 1);
  }
  return out;
}

/**
 * Value every asset on both sides of a trade.
 *
 * @param trade  a row from `trades` — received, draft_picks, roster_ids
 * @param o.superflex   which value flavour to read
 * @param o.asOf        capture date; defaults to the newest available
 * @param o.slots       Map of rosterId -> draft slot, per season
 * @param o.teams       league size
 */
async function priceTrade(trade, o = {}) {
  const { superflex = false, teams = 12, slots = new Map(), asOf = null } = o;

  const { rows: [cap] } = await db.query(
    asOf
      ? `select max(captured_on) d from player_values where captured_on <= $1`
      : `select max(captured_on) d from player_values`,
    asOf ? [asOf] : []);
  const on = cap?.d;
  if (!on) return null;

  const received = trade.received || {};
  const rosterIds = trade.roster_ids || Object.keys(received).map(Number);

  const sides = new Map();
  const side = rid => {
    const k = Number(rid);
    if (!sides.has(k)) sides.set(k, { rosterId: k, players: [], picks: [], unpriced: [], value: 0 });
    return sides.get(k);
  };
  for (const rid of rosterIds) side(rid);

  // Players received.
  const ids = [...new Set(Object.values(received).flat())];
  const byId = new Map();
  if (ids.length) {
    const { rows } = await db.query(
      `select v.sleeper_id, v.name, v.value, p.position, p.team
         from player_values v left join players p on p.player_id = v.sleeper_id
        where v.captured_on = $1 and v.superflex = $2 and v.sleeper_id = any($3::text[])`,
      [on, superflex, ids]);
    for (const r of rows) byId.set(String(r.sleeper_id), r);
  }
  for (const [rid, list] of Object.entries(received)) {
    for (const pid of list || []) {
      const v = byId.get(String(pid));
      if (v) { side(rid).players.push({ playerId: pid, name: v.name, value: v.value, position: v.position, team: v.team }); side(rid).value += v.value; }
      else side(rid).unpriced.push({ playerId: pid, what: 'player' });
    }
  }

  // Picks. owner_id is who holds it after the trade; roster_id is whose pick it is.
  const labels = new Map();
  for (const pk of trade.draft_picks || []) {
    const slot = slots.get(Number(pk.roster_id));
    const label = pickLabel({ season: pk.season, round: pk.round, slot, teams });
    if (label) labels.set(label, null);
  }
  if (labels.size) {
    const { rows } = await db.query(
      `select name, value from player_values
        where captured_on = $1 and superflex = $2 and position = 'PICK' and name = any($3::text[])`,
      [on, superflex, [...labels.keys()]]);
    for (const r of rows) labels.set(r.name, r.value);
  }

  /*
   * A season the market has not started pricing yet, carried across from one it
   * has. The source lists 2026 picks and no 2027, so "my 2027 second" priced at
   * nothing and no margin could be given for a trade containing one.
   *
   * Sean's call, and it is defensible: a mid second is a mid second. It is also
   * KNOWN to be slightly generous — real dynasty markets discount a future pick
   * against the same pick this year, because its slot is not yet decided — so
   * it reads high for whoever GIVES UP the future pick. That is why every one
   * of these is recorded as an assumption and repeated back with the margin,
   * rather than quietly folded into a number.
   */
  const assumptions = [];
  const missing = [...labels].filter(([, v]) => v == null).map(([k]) => k);
  if (missing.length) {
    const { rows: priced } = await db.query(
      `select name, value from player_values
        where captured_on = $1 and superflex = $2 and position = 'PICK'`, [on, superflex]);
    const byShape = new Map();
    for (const r of priced) {
      const m = /^(\d{4}) (Early|Mid|Late) (1st|2nd|3rd|4th)$/.exec(r.name);
      if (!m) continue;
      const shape = `${m[2]} ${m[3]}`;
      if (!byShape.has(shape)) byShape.set(shape, []);
      byShape.get(shape).push({ year: Number(m[1]), value: r.value, name: r.name });
    }
    for (const label of missing) {
      const m = /^(\d{4}) (Early|Mid|Late) (1st|2nd|3rd|4th)$/.exec(label);
      if (!m) continue;
      const want = Number(m[1]);
      const options = byShape.get(`${m[2]} ${m[3]}`) || [];
      if (!options.length) continue;
      // Nearest priced year, so a 2027 leans on 2026 rather than something old.
      const best = options.sort((a, b) => Math.abs(a.year - want) - Math.abs(b.year - want))[0];
      labels.set(label, best.value);
      assumptions.push({ label, from: best.name, value: best.value });
    }
  }
  for (const pk of trade.draft_picks || []) {
    const slot = slots.get(Number(pk.roster_id));
    const label = pickLabel({ season: pk.season, round: pk.round, slot, teams });
    const value = label ? labels.get(label) : null;
    const assumed = assumptions.find(a => a.label === label) || null;
    const entry = { season: pk.season, round: pk.round, from: Number(pk.roster_id), label, value,
                    assumedFrom: assumed?.from || null };
    const s = side(pk.owner_id);
    s.picks.push(entry);
    if (value != null) s.value += value;
    else s.unpriced.push({ what: 'pick', season: pk.season, round: pk.round, label });
  }

  const list = [...sides.values()].sort((a, b) => b.value - a.value);
  const anyUnpriced = list.some(s => s.unpriced.length);
  return {
    capturedOn: on,
    superflex,
    sides: list,
    // A margin computed over assets that could not all be priced is not a
    // margin. Null, and the caller says why, rather than a number that quietly
    // treats an unpriceable 2027 second as nothing.
    margin: anyUnpriced ? null : Math.round(list[0].value - list[list.length - 1].value),
    unpricedReason: anyUnpriced
      ? 'at least one asset has no market value on file, so no margin is given'
      : null,
    // Never empty-by-omission: a margin that rests on a carried-over price has
    // to arrive with that fact attached, or it reads as a measurement.
    assumptions,
  };
}

/**
 * What the price cannot see: where these players landed.
 *
 * Only the arriving side's own roster is consulted, and only for the same NFL
 * team and position, which is what a handcuff is. Injury status is the point —
 * "a backup" and "the backup to your starter who is carrying a knee injury" are
 * different assets, and only the second explains paying over the odds.
 */
async function rosterFlags(playerIds, rosterPlayerIds) {
  if (!playerIds?.length || !rosterPlayerIds?.length) return [];
  const { rows } = await db.query(
    `select player_id, full_name, position, team, injury_status, injury_body_part
       from players where player_id = any($1::text[])`,
    [[...new Set([...playerIds, ...rosterPlayerIds])]]);
  const by = new Map(rows.map(r => [String(r.player_id), r]));

  const flags = [];
  for (const pid of playerIds) {
    const got = by.get(String(pid));
    if (!got?.team || !got?.position) continue;
    for (const held of rosterPlayerIds) {
      if (String(held) === String(pid)) continue;
      const other = by.get(String(held));
      if (!other || other.team !== got.team || other.position !== got.position) continue;
      flags.push({
        playerId: pid,
        name: got.full_name,
        handcuffOf: other.full_name,
        team: got.team,
        position: got.position,
        starterInjury: other.injury_status || null,
        starterBodyPart: other.injury_body_part || null,
      });
      break;
    }
  }
  return flags;
}

module.exports = { priceTrade, rosterFlags, pickLabel, bucketFor, slotsFromDraft, slotsFromFinish };
