/**
 * What the waiver wire actually bought, and what it threw away.
 *
 * A league argues about a $75 claim for one week and then forgets it. The
 * snapshot remembers: 75 dollars, five weeks on the roster, started zero of
 * them, nought points. That is the joke and the number is doing the work.
 *
 * STARTED POINTS, not points. A pickup who scores 90 on a bench won nobody
 * anything, and counting bench production would flatter every panic add in the
 * league. Same rule the trade grades follow, for the same reason.
 *
 * NOT EVERY LEAGUE USES FAAB. Halcyon runs 50 waiver claims a season with no
 * bids at all, so anything keyed on money would be dead there. Spend is
 * reported when it exists and the value questions — what did this pickup do,
 * what did that drop go on to do — answer either way.
 */

const db = require('./db');

/**
 * A week-by-week index of who was rostered where, who started, and what they
 * scored, built from the season's final snapshot.
 *
 * `pp` covers a roster's whole squad rather than just its starters, which is
 * what makes "started 0 of 5 weeks" answerable at all.
 */
function indexSeason(payload) {
  const byWeek = new Map();
  for (const g of payload?.games || []) {
    const w = Number(g.w);
    if (!byWeek.has(w)) byWeek.set(w, new Map());
    for (const [rid, lineup] of Object.entries(g.lineups || {})) {
      byWeek.get(w).set(Number(rid), {
        started: new Set(lineup.s || []),
        points: lineup.pp || {},
      });
    }
  }
  return byWeek;
}

/** What a player did from `after` onward, on one roster, while STARTED. */
function pointsAfter(byWeek, rosterId, playerId, after, lastWeek) {
  let points = 0, started = 0, held = 0;
  for (let w = after + 1; w <= lastWeek; w++) {
    const r = byWeek.get(w)?.get(Number(rosterId));
    if (!r) continue;
    const p = r.points[playerId];
    if (p === undefined) continue;   // no longer on this roster
    held++;
    if (r.started.has(playerId)) { points += p; started++; }
  }
  return { points: Math.round(points * 10) / 10, started, held };
}

/** What a dropped player went on to score for ANYONE, which is the sore point. */
function pointsAnywhere(byWeek, playerId, after, lastWeek) {
  let points = 0, started = 0;
  let landedOn = null;
  for (let w = after + 1; w <= lastWeek; w++) {
    for (const [rid, r] of byWeek.get(w) || []) {
      const p = r.points[playerId];
      if (p === undefined) continue;
      if (landedOn == null) landedOn = rid;
      if (r.started.has(playerId)) { points += p; started++; }
    }
  }
  return { points: Math.round(points * 10) / 10, started, landedOn };
}

/**
 * Every waiver and free agent move of a season, with what it was worth.
 *
 * @param o.transactionsFor  async (week) => Sleeper transactions, injected so
 *                           this is testable without the network
 */
async function analyze(sleeperLeagueId, { season, transactionsFor, weeks = 18 } = {}) {
  const { rows: [snap] } = await db.query(
    `select s.payload from snapshots s join leagues l on l.id = s.league_id
      where l.sleeper_league_id = $1 and s.kind = 'final'
        and ($2::text is null or s.season = $2)
      order by s.season desc limit 1`, [sleeperLeagueId, season || null]);
  if (!snap?.payload) return null;

  const byWeek = indexSeason(snap.payload);
  if (!byWeek.size) return null;
  const lastWeek = Math.max(...byWeek.keys());

  const adds = [];
  const drops = [];
  let anyBid = false;

  for (let wk = 1; wk <= weeks; wk++) {
    const tx = await transactionsFor(wk).catch(() => null);
    if (!Array.isArray(tx)) continue;
    for (const t of tx) {
      if (t.status !== 'complete') continue;
      if (t.type !== 'waiver' && t.type !== 'free_agent') continue;
      const bid = Number(t.settings?.waiver_bid) || 0;
      if (bid > 0) anyBid = true;

      for (const [playerId, rosterId] of Object.entries(t.adds || {})) {
        const got = pointsAfter(byWeek, rosterId, playerId, wk, lastWeek);
        adds.push({ week: wk, rosterId: Number(rosterId), playerId, bid, type: t.type, ...got });
      }
      for (const [playerId, rosterId] of Object.entries(t.drops || {})) {
        const gone = pointsAnywhere(byWeek, playerId, wk, lastWeek);
        drops.push({ week: wk, rosterId: Number(rosterId), playerId, ...gone });
      }
    }
  }

  return { season: season || null, lastWeek, faab: anyBid, adds, drops };
}

/**
 * The handful worth saying out loud.
 *
 * WORST SPEND needs a floor on the bid, or the top of the list is somebody who
 * paid a dollar for nothing — technically the worst points per dollar in the
 * league and not a story. Ranked by money burned, not by ratio.
 */
function highlights(result, { minBid = 5, minDropPoints = 40 } = {}) {
  if (!result) return null;
  const { adds, drops, faab } = result;

  const wasted = faab
    ? adds.filter(a => a.bid >= minBid && a.points < 20)
        .sort((a, b) => b.bid - a.bid || a.points - b.points)
    : [];

  /*
   * Ranked by POINTS, not by points per dollar.
   *
   * Per-dollar sounds like the right measure and buries the story: every free
   * pickup divides by one, so the list came back as five $0 claims and the $30
   * bid that returned 144 points never appeared. The bid is printed beside each
   * one, which is where it belongs — a reader can see 196 points for nothing.
   */
  const steals = adds.filter(a => a.points >= 40).sort((a, b) => b.points - a.points);

  /*
   * A drop only stings if somebody else got the production — and only once.
   *
   * A player the league keeps churning generates a row per drop, so Tyler
   * Williams came back three times with three different totals and three
   * different beneficiaries, all true and all the same story told worse. One
   * entry per player, the drop that cost the most.
   */
  const worstPerPlayer = new Map();
  for (const d of drops) {
    if (d.points < minDropPoints) continue;
    if (d.landedOn == null || d.landedOn === d.rosterId) continue;
    const prev = worstPerPlayer.get(d.playerId);
    if (!prev || d.points > prev.points) worstPerPlayer.set(d.playerId, d);
  }
  const regrets = [...worstPerPlayer.values()].sort((a, b) => b.points - a.points);

  const spend = new Map();
  for (const a of adds) {
    const e = spend.get(a.rosterId) || { rosterId: a.rosterId, spent: 0, adds: 0, points: 0 };
    e.spent += a.bid; e.adds++; e.points += a.points;
    spend.set(a.rosterId, e);
  }

  return {
    faab,
    wasted: wasted.slice(0, 5),
    steals: steals.slice(0, 5),
    regrets: regrets.slice(0, 5),
    byManager: [...spend.values()].sort((a, b) => b.spent - a.spent || b.points - a.points),
  };
}

/**
 * The season's analysis, computed once and kept.
 *
 * Eighteen Sleeper calls a season is fine annually and absurd per question —
 * the reply path was just taken from 55 calls to 7 and this would put a third
 * of that straight back for something asked a handful of times a year.
 *
 * A finished season is stored and never recomputed: the claims were made, the
 * points were scored, nothing about it can move. The current season is stored
 * with the week it was computed through and redone when the week advances.
 */
async function cached(sleeperLeagueId, { season, transactionsFor, currentWeek = null } = {}) {
  const key = [sleeperLeagueId, String(season)];
  const finished = Number(season) < Number(new Date().getFullYear());

  const { rows } = await db.query(
    'select through_week, result from waiver_analysis where sleeper_league_id = $1 and season = $2',
    key);
  if (rows.length) {
    const stale = !finished && currentWeek != null && Number(rows[0].through_week) < Number(currentWeek);
    if (!stale) return rows[0].result;
  }

  const fresh = await analyze(sleeperLeagueId, { season, transactionsFor });
  if (!fresh) return null;
  await db.query(
    `insert into waiver_analysis (sleeper_league_id, season, through_week, result, computed_at)
     values ($1, $2, $3, $4, now())
     on conflict (sleeper_league_id, season) do update
       set through_week = excluded.through_week, result = excluded.result,
           computed_at = now()`,
    [...key, Number(currentWeek) || fresh.lastWeek, JSON.stringify(fresh)])
    .catch(err => console.error('[waivers] cache write failed:', err.message));
  return fresh;
}

module.exports = { analyze, cached, highlights, indexSeason, pointsAfter, pointsAnywhere };
