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

/**
 * What a draft was worth, measured against what was on the board.
 *
 * THE NUMBER THAT MATTERS IS NOT POINTS, IT IS POINTS OVER REPLACEMENT.
 * Measured on the real 2026 projections for a 12-team, 1QB/2RB/2WR/1TE/1FLEX
 * league: Josh Allen is the highest-projected player in football at 361.5, and
 * he is worth +65.8 over the twelfth quarterback. Jahmyr Gibbs projects thirty
 * points LOWER and is worth +183.5, because the thirty-sixth running back is
 * not remotely Gibbs while the twelfth quarterback is nearly Josh Allen.
 *
 * A grade built on raw points says take Allen first. Every experienced drafter
 * in the league knows that is wrong, and a grade that disagrees with them about
 * something so basic will not be believed about anything else.
 *
 * WHY NOT ADP. Average draft position measures what the market would have paid;
 * this measures what the points justify. For a grade the second is the better
 * question, and it needs no external source that can quietly go stale — the
 * projections are already pulled for the lineup grade.
 *
 * THE METHOD is a replay. Walk the picks in order, and at each one compare the
 * value of the player taken against the best value still on the board. A
 * manager who always took the best available scores 100%. Someone who opened
 * with the second-best quarterback left roughly 150 points sitting there, and
 * this says so to the point.
 *
 * @param picks   every pick in order: [{ pick_no, roster_id, player_id }]
 * @param proj    Map of playerId -> { points, position, name }
 * @param rosterPositions  the league's own slots, so replacement is its own
 */
function draftValue({ picks = [], proj, rosterPositions = [], teams = 12 } = {}) {
  if (!proj || !picks.length) return null;

  const slots = (rosterPositions || []).filter(sl => SLOT_ELIGIBILITY[sl]);
  if (!slots.length) return null;

  /*
   * Replacement is the last player at a position anybody would still start,
   * counted from THIS league's slots — dedicated plus every flex he is
   * eligible for. A league with a superflex has a completely different
   * quarterback replacement level, and using a league-average one would grade
   * it wrongly in the one place it is most distinctive.
   */
  const byPos = {};
  for (const v of proj.values()) {
    if (v && v.position && v.points != null) (byPos[v.position] ||= []).push(v);
  }
  for (const list of Object.values(byPos)) list.sort((a, b) => b.points - a.points);

  const replacement = {};
  for (const pos of Object.keys(byPos)) {
    const dedicated = slots.filter(sl => sl === pos).length;
    const flex = slots.filter(sl => sl !== pos && SLOT_ELIGIBILITY[sl].includes(pos)).length;
    const rank = teams * (dedicated + flex);
    // A position nobody starts has no replacement level and no value here.
    replacement[pos] = rank > 0 && byPos[pos].length >= rank
      ? byPos[pos][rank - 1].points : null;
  }

  const vorpOf = id => {
    const v = proj.get(String(id));
    if (!v || v.points == null || !v.position) return null;
    const base = replacement[v.position];
    return base == null ? null : { player: v, vorp: v.points - base };
  };

  /*
   * THE BOARD IS WHO WAS ACTUALLY DRAFTED, not every projected player.
   *
   * The first version built it from all 555 projections and produced nonsense
   * on a keeper league: the best draft in the league scored 22% and the worst
   * scored 0.2%, because in a six round rookie draft almost every good player
   * is already on somebody's roster and was never available. It reported a
   * pick-68 flier as a 230 point reach "instead of Bijan Robinson", who had
   * been rostered since 2024.
   *
   * Restricting it to players this draft actually produced is knowable and
   * close to true: anybody who went undrafted was, by twelve managers' revealed
   * preference, not worth a pick. It understates the board slightly when a good
   * player genuinely goes unclaimed, which is a bounded and honest error — and
   * it makes the comparison the one people actually care about, which is
   * against what their leaguemates did.
   */
  const draftable = new Set(picks.map(pk => String(pk.player_id)).filter(Boolean));
  const board = [];
  for (const id of draftable) {
    const got = vorpOf(id);
    if (got && got.vorp > 0) board.push({ id: String(id), ...got });
  }
  board.sort((a, b) => b.vorp - a.vorp);
  // Where each drafted player sat on that board, one-indexed.
  const boardRank = new Map(board.map((b, i) => [b.id, i + 1]));

  const taken = new Set();
  const teamsOut = new Map();
  const ordered = [...picks].sort((a, b) => (a.pick_no || 0) - (b.pick_no || 0));

  for (const pk of ordered) {
    const rid = Number(pk.roster_id);
    if (!teamsOut.has(rid)) {
      teamsOut.set(rid, { rosterId: rid, captured: 0, available: 0, picks: 0,
                          steal: null, reach: null });
    }
    const t = teamsOut.get(rid);

    // The best thing nobody had taken when this pick was made.
    const best = board.find(b => !taken.has(b.id));
    const got = vorpOf(pk.player_id);
    taken.add(String(pk.player_id));

    // A pick of somebody with no projection is not a reach, it is a flier on
    // a player the projections have never heard of. Counted as zero captured,
    // and not held against the available side either — see below.
    if (!best) continue;
    const mine = got && got.vorp > 0 ? got.vorp : 0;

    t.picks++;
    t.captured += mine;
    t.available += best.vorp;

    const left = best.vorp - mine;
    // The pick where the most was left on the table, and the one where they
    // took the best thing there by the widest margin over the next man gone.
    if (!t.reach || left > t.reach.left) {
      t.reach = { left: Math.round(left * 10) / 10, pick: pk.pick_no,
                  took: got?.player?.name || 'an unprojected player',
                  instead: best.player.name,
                  insteadPos: best.player.position };
    }
    /*
     * A STEAL IS REAL VALUE, TAKEN LATE.
     *
     * Two definitions failed before this one. Raw value named the first overall
     * pick — "Steal: Ja'Marr Chase at pick 1", which is not a steal, it is the
     * draft working. Board rank against pick number then named a steal for
     * eleven of twelve teams, because the board only ranks as many players as
     * were drafted: by pick 130 of 168 almost anyone left ranks better than
     * their pick number, so every late pick "gained" places for free.
     *
     * What is actually notable is a player worth starting, taken after the room
     * had stopped expecting one. So: the most valuable pick made in the back
     * two thirds of the draft, and only if he clears a real bar.
     */
    if (mine > 0 && pk.pick_no && pk.pick_no > ordered.length / 3) {
      if (!t.steal || mine > t.steal.vorp) {
        t.steal = { vorp: Math.round(mine * 10) / 10, pick: pk.pick_no,
                    round: pk.round, name: got.player.name, pos: got.player.position };
      }
    }
  }

  const out = [...teamsOut.values()].map(t => ({
    ...t,
    captured: Math.round(t.captured * 10) / 10,
    available: Math.round(t.available * 10) / 10,
    // Share of the value that was actually on the board when they picked.
    efficiency: t.available > 0 ? Math.round((t.captured / t.available) * 1000) / 10 : null,
  }));

  /*
   * GRADED AGAINST THIS LEAGUE, on the same scale as the lineup grade.
   *
   * An absolute band would need calibrating and would be wrong for the next
   * league along: a six round keeper draft ran 67% to 0.8% and a fourteen
   * round redraft of the same season ran 65.7% to 48.6%, so a fixed cutoff
   * would hand out As in one and Ds in the other for identical drafting.
   *
   * BANDS already expresses deviation from the league mean and is already
   * calibrated for the lineup grade. Reusing it means the two letters on a
   * team's line mean the same thing, which is the only way anybody can read
   * them together.
   */
  const scored = out.filter(t => t.efficiency != null);
  const mean = scored.length
    ? scored.reduce((a, t) => a + t.efficiency, 0) / scored.length : null;
  for (const t of out) {
    if (t.efficiency == null || !mean) { t.grade = null; continue; }
    const band = gradeFor((t.efficiency - mean) / mean);
    t.grade = band.grade;
    t.say = band.say;
  }

  out.sort((a, b) => (b.efficiency ?? -1) - (a.efficiency ?? -1));
  return { teams: out, replacement, mean: mean == null ? null : Math.round(mean * 10) / 10 };
}

/**
 * Slot codes as people say them.
 *
 * Sleeper's are SUPER_FLEX and REC_FLEX, which is fine in a payload and reads
 * as a variable name in a sentence — "starting Justin Fields at SUPER_FLEX
 * every week" is a line written by a database.
 */
const SLOT_ELIGIBILITY = {
  QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'],
  FLEX: ['RB', 'WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'],
  REC_FLEX: ['WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
};

const SLOT_WORDS = {
  SUPER_FLEX: 'superflex', REC_FLEX: 'the receiver flex', FLEX: 'flex',
  DEF: 'defence', K: 'kicker', QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE',
};
const slotWord = slot => SLOT_WORDS[String(slot || '').toUpperCase()] || String(slot || '').toLowerCase().replace(/_/g, ' ');

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
      /*
       * Varied, and for the same reason as the opener below: on a fourteen
       * round board half the league waits on a quarterback, so one phrasing
       * appeared six times in a single recap and stopped reading as a remark.
       * Keyed on the round so the same draft always produces the same recap.
       */
      const ways = [
        `Waited until round ${round} for a ${pos} and still got one — that either `
          + 'looks clever in December or it does not.',
        `Let ${pos} go until round ${round}, which is either patience or nerve.`,
        `No ${pos} until round ${round}. Bold, and now permanent.`,
      ];
      notes.push(ways[round % ways.length]);
    }
  }

  /*
   * WHAT IT MEANS EVERY WEEK. The grade already names the weak position; this
   * names the human who has to start there, which is the version people
   * remember. An empty slot is worse than a weak one and outranks it.
   */
  if (notes.length < 2) {
    if (holes.length) {
      notes.push(`Nobody to put at ${holes.map(slotWord).join(' or ')} — that is a waiver problem `
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
      notes.push(`Starting ${need.name} at ${slotWord(need.slot)} every week until somebody `
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

  /*
   * SOMETHING FOR EVERYBODY, because the recap now names every team.
   *
   * The rules above fire on odd drafts and bad rosters. A middling team that
   * drafted sensibly matched none of them and got a bare letter, which is the
   * thing this whole function exists to avoid — and in a twelve team recap that
   * is most of the list. Their first pick is always there and is always the
   * decision they thought hardest about.
   */
  if (!notes.length && seq[0]?.name) {
    /*
     * VARIED, because in a short draft this is most of the recap.
     *
     * A three round rookie draft gives the sharper rules nothing to find, so
     * this fired for six of twelve teams and the same eleven words six times
     * reads as a template rather than a remark. The phrasing is chosen by the
     * pick itself, so it is stable — the same draft always produces the same
     * recap — and it leans on the two facts always to hand: who they opened
     * with, and what they took last.
     */
    const first = seq[0];
    const last = seq[seq.length - 1];
    const variants = [
      `Opened with ${first.name} and built from there.`,
      `Started at ${first.position} with ${first.name}, which set the tone.`,
      `${first.name} first`
        + (last && last !== first ? `, ${last.name} last` : '')
        + ' — make of that what you will.',
      `Went ${first.position} early with ${first.name} and did not look back.`,
    ];
    notes.push(variants[first.name.length % variants.length]);
  }

  return notes.slice(0, 2);
}


module.exports = { gradeDraft, lineupImpact, draftColour, draftValue, gradeFor, BANDS };
