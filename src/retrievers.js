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
   * What a dynasty trade was worth, and what the price could not see.
   *
   * The redraft path grades on points actually scored weeks later, which is
   * ground truth. Dynasty gets none of that — a trade made in 2021 is still
   * resolving — so this answers the question the chat actually argues about:
   * was it fair when it was made.
   *
   * Market values already carry age, team control and breakout odds, so this
   * looks them up rather than modelling them. The judgement it adds is the
   * roster: a second round pick spent on the backup to a starter carrying a
   * knee injury is an overpay by price and a handcuff by roster, and only the
   * second explains why somebody paid it.
   */
  trade_value: {
    describe: 'What a trade was worth at market prices, for leagues whose trades are '
            + 'not graded on points — dynasty and keeper. Use for "was that trade fair", '
            + '"did I win that trade", "how did my trade with X look", "what did I give up". '
            + 'Arguments: manager=<name> (optional), season=<year> (optional).',
    args: {
      manager: 'string, a manager name, or omit for the whole league',
      season: 'string, a year like 2026, or omit for the most recent trades',
    },
    async run(ctx, args) {
      const dv = require('./dynastyvalue');

      const leagueWords = String(ctx.leagueName || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
      if (args.manager && leagueWords.includes(String(args.manager).toLowerCase())) delete args.manager;

      const { rows } = await db.query(
        `select t.season, t.week, t.received, t.roster_ids, t.draft_picks, t.status_updated_at
           from trades t join leagues l on l.id = t.league_id
          where l.sleeper_league_id = any($1::text[]) and t.status = 'complete'
            and ($2::text is null or t.season = $2)
          order by t.season desc, t.week desc limit 40`,
        [ctx.chainIds || [], args.season || null]);
      if (!rows.length) return 'No completed trades are on record for this league.';

      const nameOf = rid => {
        const m = (ctx.members || []).find(x => Number(x.rosterId) === Number(rid));
        return m?.name || `roster ${rid}`;
      };

      let items = rows;
      let ambiguous = null;
      if (args.manager) {
        const want = String(args.manager).toLowerCase();
        items = rows.filter(t => (t.roster_ids || []).some(r => nameOf(r).toLowerCase().includes(want)));
        if (!items.length) return `No trade on record involves anyone matching "${args.manager}".`;
        /*
         * TWO PEOPLE, ONE FILTER.
         *
         * This league has a Sean M. and a Sean C. Asked to grade "my last
         * trade", the reply handed Sean M. a deal Sean C. had made — every line
         * named the right person and the model merged them anyway, because a
         * filter on "Sean" returns one list and a list reads as one person.
         *
         * Every match is named here so the collision is a stated fact rather
         * than something to be noticed.
         */
        const hits = [...new Set((ctx.members || [])
          .map(m => m.name).filter(n => n && n.toLowerCase().includes(want)))];
        if (hits.length > 1) ambiguous = hits;
      }
      /*
       * THE TRUNCATION, SAID OUT LOUD.
       *
       * Pricing every trade is too many tokens, so this shows the most recent
       * few. Asked whether Sean had ever traded with Brennan, the answer came
       * back "they haven't" — the deal was 2024 and the list stopped at four,
       * and a list that stops without saying so is read as the whole record.
       * This repo has now paid for that exact mistake three times: five graded
       * trades of sixteen, twenty-five ungraded of fifty-five, and here.
       */
      const matched = items.length;
      const SHOW = 4;
      items = items.slice(0, SHOW);

      const superflex = Boolean(ctx.valueVariant?.superflex);
      const teams = ctx.draftSchedule?.teams || 12;
      const slotMap = await require('./sleeper').draftSlots(ctx.draftSchedule?.draftId).catch(() => null);
      const slots = slotMap ? dv.slotsFromDraft(slotMap) : new Map();

      /*
       * Rosters are TODAY'S, so the handcuff check runs only on this season's
       * trades. Asking whether two men are teammates in 2026 answers nothing
       * about a 2021 deal, and a confidently wrong handcuff is worse than none.
       */
      const thisSeason = String(ctx.season || new Date().getFullYear());
      let rosters = null;

      const L = [`TRADE VALUE, ${superflex ? 'superflex' : '1QB'} market prices AS AT THE DATE OF EACH`
               + ' TRADE, not today. So these say what the two sides were agreeing to at the time,'
               + ' which is a different question from how it turned out — a player can be worth'
               + ' twice now what he was worth then.',
        '',
        '  LEAD WITH THE GRADE. What people want is the letter and who came off worse, not the'
        + ' arithmetic behind it. Give the pieces that moved and the grades, and stop there.',
        '  The point totals, the margin and the percentage are all WORKING, not the answer. Keep'
        + ' them back unless somebody asks how you got to the grade, or disputes it — then you'
        + ' have the numbers and can show them. Do not volunteer a value in an opening reply.'];
      if (ambiguous) {
        L.push(`  CAREFUL: "${args.manager}" matches ${ambiguous.length} different managers —`
             + ` ${ambiguous.join(' and ')}. They are DIFFERENT PEOPLE and this list mixes their`
             + ' trades. Every line below names whose trade it is; go by that name and never'
             + ' attribute one of them a deal made by the other. If the question meant one of'
             + ' them and you cannot tell which, ask.');
      }
      if (matched > items.length) {
        L.push(`  THESE ARE THE ${items.length} MOST RECENT OF ${matched}`
             + `${args.manager ? ` involving ${args.manager}` : ''}${args.season ? ` in ${args.season}` : ''}.`
             + ' Older ones exist and are not priced here, so do NOT say a pairing has never'
             + ' traded, and do not count from this list. Ask for a season to see further back.');
      }

      for (const t of items) {
        /*
         * Priced at the date of the TRADE, not today.
         *
         * "Was it fair" is a question about the moment it was made, and today's
         * market answers a different one. A 2024 deal priced at 2026 values had
         * Nico Collins at 6304 because that is what he is worth now, which says
         * nothing about what anybody was agreeing to two years ago. Six years of
         * weekly history exist for exactly this.
         */
        const priced = await dv.priceTrade(t, {
          superflex, teams, slots,
          slotSeason: ctx.draftSchedule?.season,
          asOf: t.status_updated_at || null,
        });
        if (!priced) { L.push(`  ${t.season} week ${t.week}: no market values available.`); continue; }

        L.push('');
        L.push(`  ${t.season} week ${t.week}, priced as at`
             + ` ${String(priced.capturedOn).slice(0, 10)}:`);
        /*
         * BOTH HALVES, AGAIN.
         *
         * Listing only what each side RECEIVED was enough to invert a whole
         * trade: "you flipped your Early 2nd to Renshaw for his Mid 2nd" off a
         * block that says the opposite, in a sentence that then contradicted
         * its own margin. The redraft path learned this and states both halves;
         * with two sides, what one gave is exactly what the other got, so there
         * is no excuse for leaving it to inference.
         */
        const assetsOf = side => [
          ...side.players.map(pl => `${pl.name} (${pl.value})`),
          ...side.picks.map(pk => `${pk.label || `${pk.season} round ${pk.round}`}`
            + (pk.value != null
                ? ` (${pk.value}${pk.assumedFrom ? ', assumed' : ''}${pk.slotUnknown ? ', slot unknown so priced mid-round' : ''})`
                : ' (no price)')),
        ];
        for (const side of priced.sides) {
          const other = priced.sides.find(x => x.rosterId !== side.rosterId);
          const got = assetsOf(side);
          const gave = other ? assetsOf(other) : [];
          L.push(`    ${nameOf(side.rosterId)} GOT ${got.join(', ') || 'nothing'} = ${side.value}`
               + `, and GAVE UP ${gave.join(', ') || 'nothing'}`);
        }
        /*
         * THE SENTENCE, WRITTEN OUT, because composing it keeps going wrong.
         *
         * Both halves are already stated per side and correct, and the reply
         * still said "you gave up your Early 2nd" when the block says he
         * received it — twice, in a sentence that then contradicted its own
         * margin. The pull is a story: a D grade means you gave away the good
         * piece, so the good piece gets moved to the losing side.
         *
         * Naming which side the single best asset went to is the one fact that
         * cannot be reconciled with the inverted story, and a pre-written line
         * is quotable rather than derivable.
         */
        const best = priced.sides
          .flatMap(sd => [...sd.players, ...sd.picks].map(a => ({ ...a, to: sd.rosterId })))
          .filter(a => a.value != null)
          .sort((a, b) => b.value - a.value)[0];
        if (best) {
          L.push(`    DIRECTION: the most valuable single asset here is`
               + ` ${best.name || best.label} (${best.value}), and it went TO`
               + ` ${nameOf(best.to)}.`);
        }

        /*
         * A SENTENCE TO QUOTE, not one to build.
         *
         * Both halves stated per side did not stop it. Naming which side the
         * best asset went to did not stop it. Across five runs the reply kept
         * saying "you gave up your Early 2nd" about a block that says he
         * received it, because a D grade tells a story and the story wants the
         * good piece leaving. Composing this sentence is the step that fails,
         * so the sentence is written here and the model is asked only to repeat
         * it. Quoting one line is the operation this model does reliably.
         */
        const [w2, l2] = priced.sides;
        const names = sd => [...sd.players.map(x => x.name), ...sd.picks.map(x => x.label)]
          .filter(Boolean).join(' and ');
        L.push(`    SAY IT THIS WAY, word for word: "${nameOf(l2.rosterId)} sent`
             + ` ${nameOf(w2.rosterId)} ${names(w2)} for ${names(l2)}."`
             + ' Do not rearrange who sent what. If you describe this trade any other way you'
             + ' will get the direction backwards, which has happened every time so far.');

        if (priced.margin != null) {
          const g = priced.grade;
          L.push(`    WORKING, do not volunteer: ${nameOf(priced.sides[0].rosterId)} ahead by`
               + ` ${priced.margin}` + (g ? `, ${g.edge}% of everything in the deal — ${g.say}.` : '.'));
          if (g) {
            /*
             * The letters, computed, with the instruction to quote rather than
             * re-derive. This is the number two people will argue over, so it
             * must mean the same thing every time it is asked.
             */
            L.push(`    GRADE, this is the headline: ${nameOf(priced.sides[0].rosterId)} ${g.won},`
                 + ` ${nameOf(priced.sides[priced.sides.length - 1].rosterId)} ${g.lost}.`
                 + ' Computed from the share of value, not judged. Quote the letters, do not'
                 + ' invent your own or adjust them.');
          }
        } else {
          L.push(`    NO MARGIN AND NO GRADE: ${priced.unpricedReason}. Say that rather than`
               + ' guessing either.');
        }
        for (const a of priced.assumptions) {
          L.push(`    ASSUMED: ${a.label} priced as ${a.from}, because the market does not quote it`
               + ' yet. Future picks normally trade at a DISCOUNT, so this reads generously for'
               + ' whoever gave it up.');
        }

        if (t.season === thisSeason) {
          if (rosters === null) {
            rosters = await fetch(`https://api.sleeper.app/v1/league/${ctx.sleeperLeagueId}/rosters`)
              .then(r => r.json()).catch(() => []);
          }
          for (const side of priced.sides) {
            const own = (rosters || []).find(r => Number(r.roster_id) === side.rosterId);
            const flags = await dv.rosterFlags(side.players.map(pl => pl.playerId), own?.players || [])
              .catch(() => []);
            for (const f of flags) {
              L.push(`    ROSTER: ${f.name} is the handcuff to ${f.handcuffOf} on ${nameOf(side.rosterId)}'s`
                   + ` own roster (both ${f.team} ${f.position})`
                   + (f.starterInjury ? `, and ${f.handcuffOf} is ${f.starterInjury}`
                       + `${f.starterBodyPart ? ` with a ${String(f.starterBodyPart).toLowerCase()}` : ''}`
                       + '. That is a premium somebody chose to pay, not only an overpay.' : '.'));
            }
          }
        }
      }
      return L.join('\n');
    },
  },

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
