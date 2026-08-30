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

/**
 * A sentence or two about what a team actually DID, not how it scored.
 *
 * The grade says a letter and a weak position. That is the verdict and it is
 * the same shape for everybody, which is exactly why nobody argues with it —
 * "Cole D, thin at QB/RB/TE" is a fact about a spreadsheet. What people argue
 * about is the DECISION: taking a fourth receiver before a second back, going
 * three rounds without a quarterback, the pick everyone in the chat questioned
 * at the time.
 *
 * WRITTEN HERE, NOT BY THE MODEL. Every observation below is derived from pick
 * order and the resulting lineup and comes out as a finished sentence. The
 * model is asked to quote it. This codebase has learned the same lesson in
 * four other places — it quotes reliably and fuses unreliably — and a draft
 * recap that invents "he reached on a quarterback" about a team that did not
 * is worse than one that says nothing.
 *
 * TWO AT MOST, and they are ranked. A paragraph per team is a wall nobody
 * reads on a phone, and the second-best observation about a normal draft is
 * usually "they took some players".
 *
 * @param picks   this team's picks IN ORDER: [{ position, name, round }]
 * @param need    draftNeeds().need — the empty slot, or the weakest starter
 * @param weaknesses  what the grade already calls thin, so a skipped position is
 *                    only mentioned when it actually cost them
 */
function draftColour({ picks = [], need = null, holes = [], weaknesses = [] } = {}) {
  // Positions the grade already calls thin, plus slots nothing can fill.
  const weak = [...new Set([...(weaknesses || []).map(w => w.pos || w), ...holes])];
  const notes = [];
  const seq = picks.filter(p => p && p.position);
  if (!seq.length) return notes;

  // Where each position was taken, in order: { RB: [0, 4, 7], WR: [1, 2, 3] }
  const at = {};
  seq.forEach((p, i) => { (at[p.position] ||= []).push(i); });
  const nth = (pos, n) => (at[pos] || [])[n - 1];
  const ord = n => ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'][n - 1] || `${n}th`;

  /*
   * THE STACKING CALL. Taking your fourth receiver before your second back is
   * a real decision with a real consequence, and it is the thing the chat
   * actually needles somebody about.
   *
   * Only reported when the gap is at least two — a fourth WR one pick before a
   * second RB is a coincidence of board position, not a philosophy — and only
   * for pairs where the later position is one the lineup genuinely needs.
   */
  const STARTING = ['RB', 'WR', 'TE', 'QB'];
  let boldest = null;
  for (const heavy of STARTING) {
    for (const light of STARTING) {
      if (heavy === light) continue;
      const second = nth(light, 2);
      if (second == null) continue;
      /*
       * THE DEEPEST ONE, not the first that qualifies.
       *
       * This looked for the smallest n with a gap of two or more picks, which
       * reported "a third WR" for a team that took FOUR before its second
       * back — the fourth was one pick closer and got filtered out by the gap
       * rule, so the milder version of the same story won. The deepest is the
       * headline and it implies every shallower one.
       */
      for (let n = (at[heavy] || []).length; n >= 3; n--) {
        const a = nth(heavy, n);
        if (a == null || a >= second) continue;
        if (!boldest || n > boldest.n) boldest = { heavy, light, n, gap: second - a };
        break;
      }
    }
  }
  if (boldest) {
    // The gap only earns a mention when it is wide enough to be a decision
    // rather than the board falling that way.
    notes.push(`Took a ${ord(boldest.n)} ${boldest.heavy} before a second ${boldest.light}`
      + (boldest.gap >= 3 ? `, ${boldest.gap} picks earlier` : '')
      + ', which is a choice.');
  }

  /*
   * THE POSITION THEY NEVER GOT TO. A round number is more use than "thin at
   * QB": it says how long they were willing to wait, which is the decision.
   */
  for (const pos of ['QB', 'TE']) {
    const first = (at[pos] || [])[0];
    if (first == null) continue;
    const round = seq[first].round;
    if (round != null && round >= 8 && notes.length < 2) {
      notes.push(`Waited until round ${round} for a ${pos} and still got one — `
        + 'that either looks clever in December or it does not.');
    }
  }

  /*
   * WHAT IT MEANS EVERY WEEK. The grade already names the weak position; this
   * names the human who has to start there, which is the version people
   * remember. An empty slot is worse than a weak one and outranks it.
   */
  if (notes.length < 2) {
    if (holes.length) {
      notes.push(`Nobody to put at ${holes.join(' or ')} — that is a waiver problem `
        + 'in week one, not a draft-day one.');
    } else if (need && !need.empty && need.name && need.overReplacement < 0) {
      /*
       * ONLY WHEN THEY ARE ACTUALLY BELOW REPLACEMENT.
       *
       * draftNeeds().need is the weakest starter by over-replacement, and that
       * number is NOT comparable across positions: a twelve team league starts
       * twelve quarterbacks and forty-odd receivers, so QB1 sits eleven above
       * his replacement while WR10 sits thirty above his. The weakest slot is
       * therefore almost always QB, whoever is in it — the first run of this
       * told a team with the A+ grade it would be "starting Josh Allen every
       * week until somebody better turns up".
       *
       * Negative means genuinely below the last startable player at that
       * position, which is the only case where the sentence is true.
       */
      notes.push(`Starting ${need.name} at ${need.slot} every week until somebody `
        + 'better turns up. We will see.');
    }
  }

  /*
   * THE SHAPE OF THE DRAFT, when nothing sharper presented itself.
   *
   * The pick-order rule only fires on a genuinely odd draft — one team in
   * twelve on a six round board — and the below-replacement line only fires on
   * a bad roster. A good, normal draft would otherwise get a bare letter,
   * which is the thing this was added to fix.
   *
   * So: what they came away with, when it is lopsided enough to be a decision.
   * Always computable, never invented, and specific enough to argue with.
   */
  if (!notes.length) {
    const counts = Object.entries(at)
      .filter(([pos]) => STARTING.includes(pos))
      .map(([pos, list]) => [pos, list.length])
      .sort((a, b) => b[1] - a[1]);
    const most = counts[0];
    // Three or more of one position, and at least two more than the next, is a
    // plan. Anything flatter is just a draft.
    if (most && most[1] >= 3 && (!counts[1] || most[1] - counts[1][1] >= 2)) {
      /*
       * A POSITION THEY SKIPPED ONLY COUNTS IF IT HURT.
       *
       * Listing every position absent from the draft says nothing true. A
       * three round rookie draft has three picks in it, so "not a single RB or
       * TE or QB" describes the format rather than a decision — and on a team
       * graded "strongest at QB" it read as a flat contradiction, because the
       * quarterback was already on the roster.
       *
       * Weak spots and unfilled slots are the ones where skipping a position
       * actually cost something, so those are the only ones named.
       */
      const hurt = STARTING.filter(pos => !at[pos] && weak.includes(pos));
      notes.push(`Came away with ${most[1]} ${most[0]}s`
        + (hurt.length ? ` and no ${hurt.join(' or ')} at all` : '')
        + ', so the plan is at least a plan.');
    }
  }

  return notes.slice(0, 2);
}


module.exports = { gradeDraft, lineupImpact, draftColour, gradeFor, BANDS };
