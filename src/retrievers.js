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
        `select t.season, t.week, t.verdict
           from trades t join leagues l on l.id = t.league_id
          where l.sleeper_league_id = any($1::text[]) and t.verdict is not null
            and ($2::text is null or t.season = $2)`,
        [ctx.chainIds || [], args.season || null]);

      let items = rows
        .filter(r => r.verdict?.sides?.length === 2)
        .map(r => ({
          season: r.season, week: r.week, v: r.verdict,
          who: r.verdict.sides.map(s2 => nameFor(ctx, s2.rosterId)),
        }));

      if (args.manager) {
        const want = String(args.manager).toLowerCase();
        items = items.filter(i => i.who.some(n => n.toLowerCase().includes(want)));
        if (!items.length) {
          return `No settled trade on record involves anyone matching "${args.manager}".`;
        }
      }
      if (!items.length) return 'No settled trades match that.';

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
      for (const i of top) {
        const [w2, l2] = i.v.sides;
        L.push(`  ${i.season} week ${i.week}: ${nameFor(ctx, w2.rosterId)} outscored `
             + `${nameFor(ctx, l2.rosterId)} by ${i.v.margin}`
             + (i.v.vorpMargin != null ? `, value gap ${Math.abs(i.v.vorpMargin)}` : ''));
      }

      /*
       * The tie, stated. At the even end several trades share a value gap of
       * zero, and a list that just happens to print one of them first reads as
       * a ranking it is not.
       */
      if (order === 'lopsided') {
        const byPoints = top[0];
        const priced = items.filter(i => i.v.vorpMargin != null);
        const byValue = priced.sort((a, b) => Math.abs(b.v.vorpMargin) - Math.abs(a.v.vorpMargin))[0];
        L.push(`  MOST LOPSIDED BY POINTS: ${byPoints.season} week ${byPoints.week}, ${byPoints.v.margin}.`);
        if (byValue) {
          const same = byValue.season === byPoints.season && byValue.week === byPoints.week;
          L.push(same
            ? '  BY VALUE it is the same trade, so both measures agree and you can call it outright.'
            : `  MOST LOPSIDED BY VALUE: ${byValue.season} week ${byValue.week}, gap`
              + ` ${Math.abs(byValue.v.vorpMargin)}. The two measures DISAGREE — name which one you mean,`
              + ' or give both. Do not present either as the single worst.');
        }
      }

      if (order === 'even') {
        const zero = items.filter(i => i.v.vorpMargin === 0);
        if (zero.length > 1) {
          L.push(`  BY VALUE these ${zero.length} are exactly tied at a gap of 0, so none of them`
               + ' is "the" most even on that measure: '
               + zero.map(i => `${i.season} wk${i.week}`).join(', ') + '.');
        }
        L.push(`  By raw points the closest is ${top[0].season} week ${top[0].week}`
             + ` at ${top[0].v.margin}. Say which measure you mean if they disagree.`);
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
