/**
 * Who you should be trading with, and for whom.
 *
 * The premise every other feature here has been circling: a trade is not
 * zero-sum in LINEUP terms even though it is in value terms. A team with a
 * starting-calibre quarterback on its bench in a one-quarterback league is
 * carrying an asset worth nothing to it and plenty to somebody else, and the
 * match is found by simulating the swap rather than by reasoning about it.
 *
 * MUTUAL FIT IS THE PRODUCT. Ranking swaps by how much they help the asker
 * produces "send your worst bench player for their best starter" — a real
 * result of the search, and a proposal nobody has ever accepted. So a candidate
 * only survives if BOTH lineups improve and the two sides are close enough in
 * value that the other manager might say yes.
 *
 * ONE FOR ONE, deliberately. Two-for-ones open a combinatorial space this does
 * not need: the point is to find the pairing, and the managers can negotiate
 * the shape of it themselves. A suggestion that starts an argument has done its
 * job.
 */

const { draftNeeds } = require('./context');

/** Points the best legal lineup would score, given a squad. */
function lineupPoints(rosters, rosterId, players, rosterPositions, proj) {
  const swapped = rosters.map(r =>
    Number(r.roster_id) === Number(rosterId) ? { ...r, players } : r);
  const needs = draftNeeds(swapped, proj, rosterId, { rosterPositions });
  if (!needs) return null;
  return needs.lineup.filter(s => s.player).reduce((a, s) => a + (s.player.points || 0), 0);
}

/**
 * @param o.rosters, o.rosterPositions, o.proj   the league as it stands
 * @param o.values      playerId -> market value; omit in redraft and projected
 *                      points stand in, which is the right yardstick there
 * @param o.rosterId    who is asking
 * @param o.depth       how many players a side to consider, by projection
 * @param o.minGain     points of lineup improvement worth mentioning
 * @param o.maxEdge     how lopsided on value a suggestion may be
 */
function findTrades(o = {}) {
  const { rosters, rosterPositions, proj, values = null, rosterId,
          depth = 10, minGain = 5, maxEdge = 0.12 } = o;
  const mine = (rosters || []).find(r => Number(r.roster_id) === Number(rosterId));
  if (!mine?.players?.length) return null;

  const valueOf = p => {
    if (values) return values.get(String(p.playerId)) ?? null;
    // Redraft has no market, and season points ARE the currency there.
    return p.points ?? null;
  };
  const tradeable = r => (r.players || [])
    .map(p => proj.get(String(p)))
    .filter(Boolean)
    .sort((a, b) => b.points - a.points)
    .slice(0, depth);

  const myBase = lineupPoints(rosters, rosterId, mine.players, rosterPositions, proj);
  if (myBase == null) return null;

  const out = [];
  for (const them of rosters) {
    const theirId = Number(them.roster_id);
    if (theirId === Number(rosterId) || !them.players?.length) continue;
    const theirBase = lineupPoints(rosters, theirId, them.players, rosterPositions, proj);
    if (theirBase == null) continue;

    for (const give of tradeable(mine)) {
      for (const get of tradeable(them)) {
        const myNew = mine.players
          .filter(p => String(p) !== String(give.playerId)).concat([get.playerId]);
        const theirNew = them.players
          .filter(p => String(p) !== String(get.playerId)).concat([give.playerId]);

        const myGain = lineupPoints(rosters, rosterId, myNew, rosterPositions, proj) - myBase;
        const theirGain = lineupPoints(rosters, theirId, theirNew, rosterPositions, proj) - theirBase;
        if (myGain < minGain || theirGain < minGain) continue;

        /*
         * FAIR ENOUGH TO BE ACCEPTED. Without this the search happily proposes
         * a bench receiver for a first round back — both lineups do improve on
         * paper, because the other side's lineup barely notices losing him, and
         * no human alive accepts it.
         */
        const a = valueOf(give);
        const b = valueOf(get);
        if (a == null || b == null) continue;
        const pot = a + b;
        const edge = pot ? Math.abs(b - a) / pot : 1;
        if (edge > maxEdge) continue;

        out.push({
          rosterId: theirId,
          give: { id: give.playerId, name: give.name, position: give.position, value: a },
          get: { id: get.playerId, name: get.name, position: get.position, value: b },
          myGain: Math.round(myGain * 10) / 10,
          theirGain: Math.round(theirGain * 10) / 10,
          edge: Math.round(edge * 1000) / 10,
          favours: b > a ? 'you' : a > b ? 'them' : 'neither',
        });
      }
    }
  }

  /*
   * Ranked by the SMALLER of the two gains. A suggestion is only as good as the
   * side with less reason to say yes, and sorting by the asker's gain alone
   * puts the least acceptable offers at the top.
   */
  out.sort((x, y) => Math.min(y.myGain, y.theirGain) - Math.min(x.myGain, x.theirGain));

  // One suggestion per partner: five variations on the same pairing is a list
  // that looks longer than it is.
  const seen = new Set();
  const best = [];
  for (const s of out) {
    if (seen.has(s.rosterId)) continue;
    seen.add(s.rosterId);
    best.push(s);
  }
  return { all: out, best, considered: out.length };
}


/**
 * Who owns which future picks, including the ones nobody has traded.
 *
 * Sleeper only reports the EXCEPTIONS — a pick appears in traded_picks solely
 * because it changed hands. Every pick not listed still belongs to the team it
 * was minted for, so the inventory has to be built from the full grid and then
 * corrected, not read off the feed.
 */
function pickInventory({ rosters, tradedPicks, seasons, rounds }) {
  const moved = new Map();
  for (const p of tradedPicks || []) {
    moved.set(`${p.season}:${p.round}:${Number(p.roster_id)}`, Number(p.owner_id));
  }
  const held = new Map();
  for (const r of rosters || []) {
    const rid = Number(r.roster_id);
    for (const season of seasons) {
      for (let round = 1; round <= rounds; round++) {
        const owner = moved.get(`${season}:${round}:${rid}`) ?? rid;
        if (!held.has(owner)) held.set(owner, []);
        // `from` matters: a rebuilding team's own first is worth more than a
        // contender's, and the label carries that once slots are known.
        held.get(owner).push({ season: String(season), round, from: rid });
      }
    }
  }
  return held;
}

/**
 * Players for picks — the trade a contender and a rebuilder actually make.
 *
 * findTrades cannot express this and never will: it keeps swaps where BOTH
 * lineups improve, and a pick improves nobody's lineup this year. That is not a
 * gap in the search, it is the difference between the two kinds of trade. Here
 * one side is buying now and the other is selling now, and each is measured on
 * the axis it actually cares about — the buyer on lineup points, the seller on
 * value banked.
 *
 * DYNASTY ONLY, and not because of a setting: in redraft a future pick does not
 * exist as an asset and this whole shape of trade is meaningless.
 */
function findPickTrades(o = {}) {
  const { rosters, rosterPositions, proj, values, pickValues, inventory,
          rosterId, depth = 8, minGain = 8, maxEdge = 0.15 } = o;
  if (!values || !pickValues) return null;

  const me = (rosters || []).find(r => Number(r.roster_id) === Number(rosterId));
  if (!me?.players?.length) return null;

  const lineupOf = (rid, players) =>
    lineupPoints(rosters, rid, players, rosterPositions, proj);

  /*
   * WHO IS BUYING AND WHO IS SELLING, from the standings this league actually
   * has rather than from anybody's self-image. Top third buy, bottom third
   * sell; the middle is left alone because a team that is neither should not be
   * told to commit to one.
   */
  const ranked = (rosters || [])
    .map(r => ({ rid: Number(r.roster_id), pts: lineupOf(Number(r.roster_id), r.players) || 0 }))
    .sort((a, b) => b.pts - a.pts);
  const third = Math.max(1, Math.round(ranked.length / 3));
  const contenders = new Set(ranked.slice(0, third).map(x => x.rid));
  const rebuilders = new Set(ranked.slice(-third).map(x => x.rid));

  const myRank = ranked.findIndex(x => x.rid === Number(rosterId)) + 1;
  const iAmBuying = contenders.has(Number(rosterId));
  const iAmSelling = rebuilders.has(Number(rosterId));
  if (!iAmBuying && !iAmSelling) {
    return { role: 'middle', rank: myRank, of: ranked.length, deals: [] };
  }

  /*
   * A FUTURE PICK IS PRICED BY WHOSE IT IS.
   *
   * Every one of these was valued as a mid-rounder, which made a contender's
   * own first cost exactly what a rebuilding team's first costs — and the
   * entire trade being described is one team buying because it is good and
   * another selling because it is not. An early first is 6,378 against a late
   * first at 5,011: a 27% error sitting in the middle of the fairness test.
   *
   * The original owner's CURRENT standing is the best available guess at where
   * their pick lands, and it is a guess: a team can collapse or wake up between
   * now and the draft. Thirds rather than exact slots, because that is as fine
   * as this reasoning deserves to be cut.
   */
  const bandFor = rid => {
    const at = ranked.findIndex(x => x.rid === Number(rid));
    if (at < 0) return 'Mid';
    if (at < third) return 'Late';                    // good team, pick lands late
    if (at >= ranked.length - third) return 'Early';  // bad team, pick lands early
    return 'Mid';
  };
  const priceOf = pk =>
    pickValues.get(`${pk.season} ${bandFor(pk.from)} ${ordinalRound(pk.round)}`)
    ?? pickValues.get(`${pk.season} Mid ${ordinalRound(pk.round)}`)
    ?? null;
  const bundles = picks => {
    // One or two picks. Three-pick packages are a negotiation, not a suggestion.
    const out = [];
    for (let i = 0; i < picks.length; i++) {
      if (priceOf(picks[i]) != null) out.push([picks[i]]);
      for (let j = i + 1; j < picks.length; j++) {
        if (priceOf(picks[i]) != null && priceOf(picks[j]) != null) out.push([picks[i], picks[j]]);
      }
    }
    return out;
  };

  const deals = [];
  const buyers = iAmBuying ? [Number(rosterId)] : [...contenders];
  const sellers = iAmSelling ? [Number(rosterId)] : [...rebuilders];

  for (const buyer of buyers) {
    const bRoster = rosters.find(r => Number(r.roster_id) === buyer);
    const bBase = lineupOf(buyer, bRoster.players);
    const bPicks = (inventory.get(buyer) || []).filter(pk => Number(pk.season) > 0);

    for (const seller of sellers) {
      if (seller === buyer) continue;
      const sRoster = rosters.find(r => Number(r.roster_id) === seller);
      if (!sRoster?.players?.length) continue;

      const sellable = (sRoster.players || [])
        .map(p => proj.get(String(p)))
        .filter(Boolean)
        .sort((a, b) => b.points - a.points)
        .slice(0, depth);

      for (const player of sellable) {
        const pv = values.get(String(player.playerId));
        if (pv == null) continue;
        const withPlayer = bRoster.players.concat([player.playerId]);
        const gain = lineupOf(buyer, withPlayer) - bBase;
        if (gain < minGain) continue;   // the buyer must actually get better

        for (const bundle of bundles(bPicks)) {
          const cost = bundle.reduce((a, pk) => a + priceOf(pk), 0);
          const pot = cost + pv;
          const edge = pot ? Math.abs(cost - pv) / pot : 1;
          if (edge > maxEdge) continue;
          deals.push({
            buyer, seller, player: { id: player.playerId, name: player.name,
              position: player.position, value: pv },
            picks: bundle.map(pk => ({ ...pk, band: bandFor(pk.from), value: priceOf(pk) })),
            pickValue: cost, buyerGain: Math.round(gain * 10) / 10,
            edge: Math.round(edge * 1000) / 10,
          });
          break;   // the cheapest fair bundle per player is the offer to make
        }
      }
    }
  }

  deals.sort((a, b) => b.buyerGain - a.buyerGain);
  const seen = new Set();
  const best = [];
  for (const d of deals) {
    const key = iAmBuying ? d.seller : d.buyer;
    if (seen.has(key)) continue;
    seen.add(key);
    best.push(d);
  }
  return { role: iAmBuying ? 'buying' : 'selling', rank: myRank, of: ranked.length, deals: best, all: deals };
}

const ordinalRound = r => ({ 1: '1st', 2: '2nd', 3: '3rd', 4: '4th' }[r] || `${r}th`);

module.exports = { findTrades, findPickTrades, pickInventory, lineupPoints };
