/**
 * Grade every team's draft, rank them, and say what each roster is good and bad at.
 *
 * WHAT IS BEING GRADED depends on what the draft was for. A redraft league's
 * draft IS the team, so the grade is the team. A dynasty rookie draft is four
 * picks bolted onto a roster built over years, and grading the whole roster
 * there would grade the wrong thing entirely — so those are measured on what
 * the market says the roster is worth rather than on a season projection.
 *
 * THE MEASURE IS THE STARTING LINEUP, not the roster. A bench full of good
 * running backs scores nothing, and a team can lead the league in total
 * projected points while starting a hole at tight end. fillLineup is already
 * the honest version of this — it is what the draft-needs block uses — so the
 * grade is built on the same lineup the bot reasons about everywhere else.
 *
 * EVERY RANKING IS COMPUTED. Grades, ranks, strengths and weaknesses all come
 * out of this file rather than out of a paragraph, for the reason the rest of
 * this codebase does the same: a model handed twelve rosters will rank them and
 * state the result as fact, and nothing downstream can check it.
 */

const { draftNeeds } = require('./context');

/*
 * Bands on distance from the league mean, not on raw points.
 *
 * Draft outcomes cluster far more tightly than trades do — twelve teams drawing
 * from one pool end up within a few percent of each other — so the bands are
 * narrower than the trade ones. Anything past 12% either way is a real outlier
 * in a snake draft.
 */
const BANDS = [
  { over: 0.12, grade: 'A+', say: 'far ahead of the field' },
  { over: 0.06, grade: 'A', say: 'clearly one of the best' },
  { over: 0.02, grade: 'B+', say: 'above average' },
  { over: -0.02, grade: 'B', say: 'right about average' },
  { over: -0.06, grade: 'C+', say: 'a little short' },
  { over: -0.12, grade: 'C', say: 'behind the field' },
  { over: -Infinity, grade: 'D', say: 'well behind' },
];

const gradeFor = over => (BANDS.find(b => over > b.over) || BANDS[BANDS.length - 1]);

/**
 * @param o.rosters          Sleeper rosters for the league
 * @param o.rosterPositions  the league's slot list
 * @param o.proj             Map of playerId -> { name, position, points }
 * @param o.nameOf           rosterId -> manager name
 * @param o.basis            'projection' (redraft) or 'market' (dynasty)
 */
function gradeDraft({ rosters, rosterPositions, proj, nameOf, values = null, rookies = null,
                      basis = 'projection' }) {
  const teams = [];

  for (const r of rosters || []) {
    const needs = draftNeeds(rosters, proj, r.roster_id, { rosterPositions });
    if (!needs) continue;

    const starters = (needs.lineup || []).filter(s => s.player);
    const total = starters.reduce((a, s) => a + (s.player.points || 0), 0);

    /*
     * An empty slot is not zero points, it is a hole somebody has to fill from
     * waivers, and it is the single most useful thing to say about a roster.
     */
    const holes = (needs.lineup || []).filter(s => !s.player).map(s => s.slot);

    const byPos = {};
    for (const s of starters) {
      const p = s.player.position;
      if (!p) continue;
      byPos[p] = (byPos[p] || 0) + (s.player.points || 0);
    }

    /*
     * MARKET VALUE OF THE WHOLE ROSTER, when values are supplied.
     *
     * A season projection is the wrong lens on a dynasty roster and gets the
     * answer backwards on the team that just drafted best. A rookie taken in
     * the second round projects near nothing this year — that is the entire
     * point of the pick, you are betting he becomes a top-ten back in a few
     * seasons — so grading him on this year's points marks a team DOWN for the
     * asset it just acquired.
     *
     * Dynasty market values already carry that bet: age, years of control and
     * breakout odds are what they price. So dynasty gets both numbers and they
     * are kept apart, because "who wins this season" and "who owns the most" are
     * different questions and answering one with the other is the mistake.
     *
     * The WHOLE roster, not the lineup, because a rookie on the bench is still
     * an asset and can still be traded. Coverage is partial — the source lists a
     * few hundred assets, not every rostered player — so what could not be
     * priced is counted and reported rather than silently treated as zero.
     */
    let market = null;
    let priced = 0;
    let unpriced = 0;
    let rookieValue = 0;
    let rookieCount = 0;
    if (values) {
      market = 0;
      for (const id of r.players || []) {
        const v = values.get(String(id));
        if (v == null) {
          unpriced++;
          // Counted separately: an unpriced VETERAN is a deep-bench body the
          // source skipped, while an unpriced ROOKIE is an asset a team just
          // spent a pick on. Same absence, very different consequence.
          if (rookies && rookies.has(String(id))) rookieCount++;
          continue;
        }
        market += v;
        priced++;
        // Tracked, not discounted. Dynasty prices DO project future production
        // — that is what they are for — but a rookie has no NFL snaps behind
        // his, only college tape and draft capital. A grade resting mostly on
        // rookies rests on the least certain prices in the source, and the
        // honest move is to say so rather than to second-guess the market.
        if (rookies && rookies.has(String(id))) rookieValue += v;
      }
    }

    teams.push({
      rosterId: Number(r.roster_id),
      name: nameOf ? nameOf(r.roster_id) : `roster ${r.roster_id}`,
      total: Math.round(total * 10) / 10,
      market,
      priced,
      unpriced,
      rookieValue: values ? rookieValue : null,
      rookieCount: values ? rookieCount : null,
      rookieShare: values && market ? Math.round((rookieValue / market) * 1000) / 10 : null,
      starters: starters.length,
      holes,
      byPos,
      bench: (r.players || []).length - starters.length,
    });
  }

  if (!teams.length) return null;

  /*
   * WHICH NUMBER THE GRADE IS BUILT ON. Market where it exists, because a
   * dynasty roster is an asset base and that is what the market prices;
   * projections otherwise.
   */
  const useMarket = basis === 'market' && teams.some(t => t.market);
  const scoreOf = t => (useMarket ? t.market : t.total);

  const mean = teams.reduce((a, t) => a + scoreOf(t), 0) / teams.length;
  teams.sort((a, b) => scoreOf(b) - scoreOf(a));
  teams.forEach((t, i) => {
    t.rank = i + 1;
    // Distance from the league mean, which is the only comparison that means
    // anything: a 1,400 point lineup is strong or weak entirely by company.
    t.over = mean ? (scoreOf(t) - mean) / mean : 0;
    const band = gradeFor(t.over);
    t.grade = band.grade;
    t.say = band.say;
    t.pctOver = Math.round(t.over * 1000) / 10;
  });

  /*
   * The other ranking, kept so both can be stated. A dynasty team can own the
   * most and still start the worst lineup this year, and that gap IS the
   * answer to "should I be worried" — collapsing it to one number loses it.
   */
  const byLineup = [...teams].sort((a, b) => b.total - a.total);
  byLineup.forEach((t, i) => { t.lineupRank = i + 1; });

  /*
   * Strengths and weaknesses, positional and RELATIVE.
   *
   * "Strong at running back" only means anything against the other eleven
   * teams, so each position is ranked across the league and the top and bottom
   * thirds are named. Absolute totals would call every team in a deep league
   * strong at quarterback.
   */
  const positions = [...new Set(teams.flatMap(t => Object.keys(t.byPos)))];
  for (const pos of positions) {
    const ranked = [...teams].sort((a, b) => (b.byPos[pos] || 0) - (a.byPos[pos] || 0));
    const cut = Math.max(1, Math.round(ranked.length / 4));
    ranked.forEach((t, i) => {
      t.strengths = t.strengths || [];
      t.weaknesses = t.weaknesses || [];
      if (i < cut) t.strengths.push({ pos, rank: i + 1, points: Math.round((t.byPos[pos] || 0) * 10) / 10 });
      else if (i >= ranked.length - cut) {
        t.weaknesses.push({ pos, rank: i + 1, points: Math.round((t.byPos[pos] || 0) * 10) / 10 });
      }
    });
  }

  return {
    basis: useMarket ? 'market' : 'projection',
    mean: Math.round(mean * 10) / 10,
    lineupMean: Math.round((teams.reduce((a, t) => a + t.total, 0) / teams.length) * 10) / 10,
    teams,
  };
}


/**
 * What a trade did to each side's STARTING LINEUP.
 *
 * Market value is zero-sum: whatever one side gained the other lost, which is
 * why the value grade mirrors. Roster fit is not. Four good receivers and no
 * tight end, against three tight ends and no receiver, swapped at identical
 * value, leaves BOTH lineups better — and a grade that can only name a winner
 * calls one of those two a loser for making the best trade available to them.
 *
 * Measured the only honest way: build the best legal lineup before the trade
 * and after it, and take the difference. Both numbers can be positive, and when
 * they are, that is the finding.
 *
 * CURRENT SEASON ONLY. Rosters are today's, so rewinding one trade off them is
 * sound while rewinding three years of moves is not. Asked about an old trade
 * this returns nothing rather than a confident number about a roster that no
 * longer exists — the same rule the handcuff check follows.
 */
function lineupImpact(trade, { rosters, rosterPositions, proj }) {
  if (!trade?.received || !rosters?.length) return null;

  const points = (playerIds, rosterId) => {
    const swapped = rosters.map(r =>
      Number(r.roster_id) === Number(rosterId) ? { ...r, players: playerIds } : r);
    const needs = draftNeeds(swapped, proj, rosterId, { rosterPositions });
    if (!needs) return null;
    return needs.lineup
      .filter(s => s.player)
      .reduce((a, s) => a + (s.player.points || 0), 0);
  };

  const sides = [];
  for (const [rid, got] of Object.entries(trade.received)) {
    const other = (trade.roster_ids || []).find(x => Number(x) !== Number(rid));
    const gave = trade.received[String(other)] || [];
    const current = (rosters.find(r => Number(r.roster_id) === Number(rid)) || {}).players || [];
    if (!current.length) continue;

    // Rewind: take back what they received, restore what they sent away.
    const before = current.filter(p => !got.includes(p)).concat(gave);
    const a = points(before, rid);
    const b = points(current, rid);
    if (a == null || b == null) continue;
    sides.push({
      rosterId: Number(rid),
      before: Math.round(a * 10) / 10,
      after: Math.round(b * 10) / 10,
      delta: Math.round((b - a) * 10) / 10,
    });
  }
  if (sides.length !== 2) return null;

  /*
   * "Both better" needs a threshold. A tenth of a point is noise in a
   * projection and calling it a mutual win would make almost every trade one.
   */
  const MEANINGFUL = 5;
  const bothUp = sides.every(s => s.delta >= MEANINGFUL);
  const bothDown = sides.every(s => s.delta <= -MEANINGFUL);
  return { sides, bothUp, bothDown, meaningful: MEANINGFUL };
}

module.exports = { gradeDraft, lineupImpact, gradeFor, BANDS };
