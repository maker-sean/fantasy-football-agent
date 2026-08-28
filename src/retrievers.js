/**
 * Lookups the router can ask for by name, run at question time.
 *
 * Sections (src/retrieve.js) decide which precomputed blocks to send. This is
 * the other half: questions whose answer was never precomputed and could not
 * reasonably be. "What was the most even trade" is the case that forced it —
 * the trades section carries the five most LOPSIDED, computed and ordered, and
 * the most even one is at the other end of a list that is not printed. Asked
 * anyway, the model scanned sixteen index rows for a minimum and returned the
 * fourth smallest. Which is the whole reason rankings are computed here: it
 * looked at the right rows and still got it wrong.
 *
 * Precomputing both ends would fix that one question and not the next. There
 * is no bottom to it — most even, most even in 2022, most even Brennan ever
 * made, biggest for a single manager — and every one of them is a different
 * ORDER BY over the same table.
 *
 * So the model names a query and its arguments, and the SQL lives here. That
 * boundary is deliberate: the model chooses from a fixed menu and supplies
 * values that are checked against an enum before anything runs. It never
 * composes the query. A model that wrote its own ORDER BY would be right back
 * to deriving the ranking, which is the thing it demonstrably cannot do.
 */

const db = require('./db');

const nameFor = (ctx, rid) => {
  const m = (ctx.members || []).find(x => Number(x.rosterId) === Number(rid));
  return m?.name || `roster ${rid}`;
};

const QUERIES = {

  /*
   * One slice of league history, instead of all nine.
   *
   * The history section is 2,550 tokens and is nine precomputed rankings, each
   * carrying the prose that explains how to read it — that "highest average
   * finish" means the lowest number, that busier is not better, that the 2025
   * bracket came out reversed from the table. None of that is padding; every
   * sentence is there because the model got that exact thing wrong once. But
   * all of it shipped on every reply that touched history, to answer a question
   * that wanted one ranking.
   *
   * These call the SAME builders src/context.js calls. Nothing is recomputed
   * here and no ranking is reimplemented: rewriting nine working rankings to
   * save tokens would be trading a solved problem for an unsolved one. The only
   * thing that changes is how many of them ship.
   */
  career_extremes: {
    describe: 'One area of league history, computed. metric=records for career win-loss '
            + 'and the best and worst of them; scoring for points per season; '
            + 'average_finish for mean place; luck for record against scoring; '
            + 'championships or toilet_bowls for the brackets; activity for adds and '
            + 'drops; game_records for highest and lowest scores, blowouts and closest '
            + 'games; benched for the worst lineup calls; drafting for draft picks.',
    args: {
      metric: ['records', 'scoring', 'average_finish', 'luck', 'championships',
               'toilet_bowls', 'activity', 'game_records', 'benched', 'drafting'],
    },
    async run(ctx, args) {
      const H = require('./history');
      const names = new Map((ctx.members || [])
        .filter(m => m.sleeperUserId && m.name)
        .map(m => [m.sleeperUserId, m.name]));

      const career = ctx.career || [];
      const BY = {
        records: () => [H.careerBlock(career, names), H.careerExtremes(career, names)],
        scoring: () => [H.scoringBlock(career, names)],
        average_finish: () => [H.averageFinishBlock(career, names)],
        luck: () => [H.luckBlock(career, names)],
        championships: () => [H.championBlock(career, names)],
        toilet_bowls: () => [H.toiletBlock(career, names)],
        activity: () => [H.activityBlock(career, names)],
        // Guarded exactly as src/context.js guards it. gameRecords is an OBJECT
        // of computed extremes, not an array, so a .length check here silently
        // reported "nothing computed" for a league with 582 games on record —
        // a false absence, which is the one failure mode this must never have.
        game_records: () => [ctx.gameRecords ? H.gameRecordsBlock(ctx.gameRecords, names) : null],
        benched: () => [ctx.benchMistakes?.length ? H.benchBlock(ctx.benchMistakes, names) : null],
        drafting: () => [ctx.draft ? require('./draftiq').draftBlock(ctx.draft, names) : null],
      };

      const pick = BY[args.metric];
      if (!pick) return null;
      const parts = pick().filter(Boolean);
      if (!parts.length) {
        /*
         * Nothing computed is NOT nothing on record. Said plainly, because the
         * alternative reads to the model as an absence and comes back to the
         * chat as "we have never done that".
         */
        return `Nothing is computed for ${args.metric} in this league — the underlying`
             + ' seasons may not be captured. Say you cannot pull it up, not that it did'
             + ' not happen.';
      }
      return `LEAGUE HISTORY LOOKUP (${args.metric}), computed for this question. Any`
           + ' superlative stated inside it is safe to quote as fact:\n' + parts.join('\n');
    },
  },
  /*
   * Trades at either end of the fairness scale, optionally for one manager or
   * one season.
   *
   * "Even" is reported on BOTH measures because they disagree and the tie at
   * the even end is real: three trades sit at VORP 0. Printing one of them as
   * "the most even" would be picking a winner out of a tie, which the persona
   * is told never to do and could not detect from a single printed line.
   */
  trade_extremes: {
    describe: 'The fairest or the most lopsided trades, optionally limited to one '
            + 'manager or one season. Use for "most even trade", "closest trade", '
            + '"fairest deal", "biggest fleecing", "worst trade ever".',
    args: {
      order: ['even', 'lopsided'],
      manager: 'string, a manager name, or omit for the whole league',
      season: 'string, a year like 2022, or omit for all seasons',
    },
    async run(ctx, args) {
      const order = args.order === 'even' ? 'even' : 'lopsided';
      const { rows } = await db.query(
        `select t.season, t.week, t.verdict, t.draft_picks
           from trades t join leagues l on l.id = t.league_id
          where l.sleeper_league_id = any($1::text[]) and t.verdict is not null
            and ($2::text is null or t.season = $2)
          order by t.season, t.week`,
        [ctx.chainIds || [], args.season || null]);

      let items = rows
        .filter(r => r.verdict?.sides?.length === 2)
        .map(r => ({
          season: r.season, week: r.week, v: r.verdict,
          picks: (r.draft_picks || []).length,
          who: r.verdict.sides.map(s2 => nameFor(ctx, s2.rosterId)),
        }));

      /*
       * A "manager" that is really the league name is not a filter.
       *
       * The router is told the difference, but it is a small model and this is
       * the failure that costs most: filtering to a person who does not exist
       * returns nothing, and nothing reads as "no such trades" rather than
       * "bad filter". Dropping it here means the worst case is a league-wide
       * answer to a league-wide question.
       */
      const leagueWords = String(ctx.leagueName || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
      if (args.manager && leagueWords.includes(String(args.manager).toLowerCase())) {
        delete args.manager;
      }

      if (args.manager) {
        const want = String(args.manager).toLowerCase();
        items = items.filter(i => i.who.some(n => n.toLowerCase().includes(want)));
        if (!items.length) {
          return `No settled trade on record involves anyone matching "${args.manager}".`;
        }
      }
      if (!items.length) {
        /*
         * "No settled trades" is true here and reads as "no trades", which is
         * the same false absence the context block just stopped producing. A
         * dynasty league HAS trades and has no verdicts, on purpose, and those
         * are different sentences.
         */
        const { rows: [u] } = await db.query(
          `select count(*)::int n from trades t join leagues l on l.id = t.league_id
            where l.sleeper_league_id = any($1::text[]) and t.status = 'complete'`,
          [ctx.chainIds || []]);
        if (u?.n) {
          return `This league has ${u.n} completed trades on record but NONE of them are graded,`
               + ' so there is no fairest or most lopsided to give. That is deliberate: in a'
               + ' keeper or dynasty league a trade keeps resolving for years and a frozen'
               + ' verdict would be a stale opinion. Say the trades exist and that you do not'
               + ' rate them here. Do NOT say there are no trades.';
        }
        return 'No completed trades are on record for this league at all.';
      }

      const by = (a, b) => order === 'even'
        ? Math.abs(a.v.margin) - Math.abs(b.v.margin)
        : Math.abs(b.v.margin) - Math.abs(a.v.margin);
      const ranked = [...items].sort(by);

      /*
       * Show them all, until "all" stops being a sensible thing to print.
       *
       * The ranking has always covered every qualifying trade — it sorts the
       * full set and the count is stated — but this used to print only the top
       * five, which is a rule inherited from the standing context block, where
       * five was what the token budget allowed on EVERY reply. A lookup runs
       * only when somebody asks, so that budget is not the constraint here and
       * sixteen lines cost nothing worth saving.
       *
       * The cap survives for the leagues that need it: one in this database has
       * 177 trades on record. Past a couple of dozen the list stops being
       * evidence and starts being a wall, so it truncates and says so.
       */
      const CAP = 25;
      const top = ranked.slice(0, CAP);

      /*
       * WHO GOT WHOM, not just who won.
       *
       * A trade named as "2020 week 2, Vosberg outscored Brennan by 7.3" is a
       * scoreline, not a trade — and it is the shape that let the bot describe
       * a deal and then invent the players in it, because nothing on the line
       * said what actually changed hands. Every mention of a trade names the
       * players on both sides.
       *
       * Draft picks are counted, never described: the verdict sides carry
       * players only, so the picks are known to have moved and not known to
       * whom. Saying "plus 2 draft picks" is the honest version. Silence would
       * present a partial swap as the whole one.
       */
      const side = s2 => {
        const got = (s2.players || []).map(pl => pl.name);
        return `${nameFor(ctx, s2.rosterId)} got ${got.length ? got.join(', ') : 'no players'}`
             + ` (${s2.startedPoints})`;
      };
      const swap = i => i.v.sides.map(side).join(', ')
        + (i.picks ? `, plus ${i.picks} draft pick${i.picks === 1 ? '' : 's'} that also moved` : '');

      const full = i => `${i.season} week ${i.week}: ${swap(i)}.`
        + ` ${nameFor(ctx, i.v.sides[0].rosterId)} outscored`
        + ` ${nameFor(ctx, i.v.sides[1].rosterId)} by ${i.v.margin}`
        + (i.v.vorpMargin != null ? `, value gap ${Math.abs(i.v.vorpMargin)}` : '');

      const scope = [args.manager && `involving ${args.manager}`, args.season && `in ${args.season}`]
        .filter(Boolean).join(' ');
      const L = [];
      /*
       * Ordered by points, and SAYING SO.
       *
       * The first cut of this printed a value gap next to each row and claimed
       * the top line was the answer. Asked for the worst trade ever the model
       * skipped to the second row, whose value gap was larger — re-ranking by
       * the column it was told to ignore, which is what anyone would do with
       * two numbers and no stated tiebreak. It was not being disobedient; the
       * block was wrong. Two measures that disagree need both leaders named,
       * not one of them asserted.
       */
      L.push(`TRADE LOOKUP — the ${order === 'even' ? 'CLOSEST' : 'most LOPSIDED'} settled trades`
           + `${scope ? ' ' + scope : ''}, of ${items.length} that qualify.`
           + ' Ordered by RAW POINTS. The value gap beside each is a different measure'
           + ' and orders them differently, so read the verdict lines under the list'
           + ' rather than ranking these yourself:');
      if (ranked.length > CAP) {
        L.push(`  The ranking covered all ${items.length}. Only the ${CAP} most extreme are`
             + ' listed, so this list is not the full record and a count taken off it would'
             + ' be wrong.');
      } else {
        L.push(`  This is ALL ${items.length} of them, so counting across this list is safe.`);
      }
      for (const i of top) L.push(`  ${full(i)}`);

      /*
       * The tie, stated. At the even end several trades share a value gap of
       * zero, and a list that just happens to print one of them first reads as
       * a ranking it is not.
       */
      /*
       * A verdict line carries its own names.
       *
       * These used to read "CLOSEST BY VALUE: 2022 week 9, gap 0" and leave the
       * who to the list above. Asked for Brennan's most even trade the reply
       * came back "Marlow outscored Brennan by 17" when the row plainly says
       * Brennan outscored Marlow — the model went back for the names and flipped
       * them. Quoting one line is reliable, welding two together is not, so
       * every line that could be quoted alone now says everything it means.
       */

      if (order === 'lopsided') {
        const byPoints = top[0];
        const priced = items.filter(i => i.v.vorpMargin != null);
        const byValue = priced.sort((a, b) => Math.abs(b.v.vorpMargin) - Math.abs(a.v.vorpMargin))[0];
        L.push(`  MOST LOPSIDED BY POINTS: ${full(byPoints)}.`);
        if (byValue) {
          const same = byValue.season === byPoints.season && byValue.week === byPoints.week;
          L.push(same
            ? '  BY VALUE it is the same trade, so both measures agree and you can call it outright.'
            : `  MOST LOPSIDED BY VALUE: ${full(byValue)}. The two measures DISAGREE — name`
              + ' which one you mean, or give both. Do not present either as the single worst.');
        }
      }

      if (order === 'even') {
        const zero = items.filter(i => i.v.vorpMargin === 0);
        if (zero.length > 1) {
          L.push(`  BY VALUE these ${zero.length} are exactly tied at a gap of 0, so none of them`
               + ' is "the" most even on that measure:');
          for (const i of zero) L.push(`    ${full(i)}`);
        }
        L.push(`  CLOSEST BY POINTS: ${full(top[0])}.`);
        /*
         * The value leader, named. Without it the even branch stated one
         * measure and gestured at the other, and the reply came back as "value
         * gap says otherwise though" — which tells nobody anything. If the two
         * agree that is worth saying outright too.
         */
        const priced = items.filter(i => i.v.vorpMargin != null);
        if (priced.length && zero.length <= 1) {
          const byValue = priced.sort((a, b) => Math.abs(a.v.vorpMargin) - Math.abs(b.v.vorpMargin))[0];
          const same = byValue.season === top[0].season && byValue.week === top[0].week;
          L.push(same
            ? '  BY VALUE it is the same trade, so both measures agree and you can call it outright.'
            : `  CLOSEST BY VALUE: ${full(byValue)}. The measures DISAGREE — give both, or`
              + ' say which you mean.');
        }
      }
      return L.join('\n');
    },
  },
};

const NAMES = Object.keys(QUERIES);

/** Run one requested lookup. Never throws — a failed lookup returns null and
 *  the reply proceeds without it, same as a section that was not loaded. */
async function run(ctx, { name, args = {} }) {
  const q = QUERIES[name];
  if (!q) return null;
  try {
    return await q.run(ctx, args);
  } catch (err) {
    console.error(`[retrievers] ${name} failed:`, err.message);
    return null;
  }
}

module.exports = { QUERIES, NAMES, run };
