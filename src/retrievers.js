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
   * Who to trade with, and for whom.
   *
   * A trade is zero-sum in value and NOT zero-sum in lineup: a starting-calibre
   * quarterback on the bench of a one-quarterback league is worth nothing to
   * his owner and plenty to somebody else. The match is found by simulating
   * every one-for-one swap and keeping the ones where both lineups improve AND
   * the two sides are close enough in value that the other manager might say
   * yes — without that second test the search proposes a bench receiver for a
   * first round back, which both lineups do prefer and no human accepts.
   */
  trade_targets: {
    describe: 'Suggests specific trades: who to trade with and which players, where BOTH '
            + 'rosters improve and the values are close enough to be accepted. Use for '
            + '"who should I trade with", "should I make a trade", "how do I fix my roster", '
            + '"who needs what I have", "any trades I should make". Argument: manager=<name>.',
    args: { manager: 'string, whose roster to find trades for' },
    async run(ctx, args) {
      const sleeper = require('./sleeper');
      const mm = require('./matchmaker');

      const hits = args.manager
        ? (ctx.members || []).filter(x => (x.name || '').toLowerCase()
            .includes(String(args.manager).toLowerCase()))
        : [];
      if (!args.manager) {
        return 'Trade suggestions are for one roster at a time. Ask whose — this needs a'
             + ' manager name before it can look.';
      }
      if (!hits.length) return `No manager matching "${args.manager}" is in this league.`;
      if (hits.length > 1) {
        return `"${args.manager}" matches ${hits.length} managers — `
             + `${hits.map(h => h.name).join(' and ')}. Different rosters; ask which.`;
      }
      const me = hits[0];

      const [lg, rosters, proj] = await Promise.all([
        sleeper.leagueSettings(ctx.sleeperLeagueId).catch(() => null),
        sleeper.rosters(ctx.sleeperLeagueId).catch(() => null),
        sleeper.seasonProjections(ctx.season).catch(() => null),
      ]);
      if (!lg || !rosters || !proj) return 'Could not read the league from Sleeper right now.';
      if (!rosters.some(r => (r.players || []).length)) {
        return 'Nobody has drafted yet, so there are no rosters to trade between.';
      }

      /*
       * Dynasty prices from the market; redraft has no market and season points
       * are the currency there, which findTrades falls back to on its own.
       */
      let values = null;
      if (ctx.valueVariant?.dynasty) {
        const { rows } = await db.query(
          `select sleeper_id, value from player_values
            where source = 'ktc' and superflex = $1 and sleeper_id is not null
              and captured_on = (select max(captured_on) from player_values)`,
          [Boolean(ctx.valueVariant?.superflex)]);
        if (rows.length) values = new Map(rows.map(r => [String(r.sleeper_id), r.value]));
      }

      const out = mm.findTrades({
        rosters, rosterPositions: lg.roster_positions, proj, values,
        rosterId: me.rosterId,
      });
      if (!out) return `Could not build a lineup for ${me.name}.`;

      const nameOf = rid => {
        const x = (ctx.members || []).find(y => Number(y.rosterId) === Number(rid));
        return x?.name || `roster ${rid}`;
      };

      const L = [`TRADE TARGETS for ${me.name}. Every one-for-one swap in the league was`
               + ' simulated; these are the ones where BOTH starting lineups get better and the'
               + ' two sides are close enough in value to be worth proposing.'];

      if (!out.best.length) {
        /*
         * No fit is a real answer and a useful one — it means the roster has no
         * surplus anybody else needs at a price they would take, which is worth
         * saying rather than padding with a proposal that fails one of the two
         * tests.
         */
        return L[0] + '\n  NONE found. Nobody in this league both wants what is spare here and'
             + ' has something this roster needs at a fair price. That is a real answer: say'
             + ' there is no clean one-for-one right now rather than inventing one.';
      }

      L.push('  These are SUGGESTIONS, not deals. Nobody has agreed to anything.');
      for (const t of out.best.slice(0, 4)) {
        L.push(`    With ${nameOf(t.rosterId)}: send ${t.give.name} (${t.give.position}),`
             + ` get ${t.get.name} (${t.get.position}).`
             + ` ${me.name} +${t.myGain} projected lineup points, ${nameOf(t.rosterId)}`
             + ` +${t.theirGain}. Values are ${t.edge}% apart`
             + `${t.favours === 'neither' ? ', dead level' : `, tilting to ${t.favours === 'you' ? me.name : nameOf(t.rosterId)}`}.`);
      }
      L.push('  Both sides improving is the whole point — say so. A swap that only helps one'
           + ' roster is not in this list, because it would not get accepted.');

      /*
       * PLAYERS FOR PICKS, which the swap search cannot express.
       *
       * It keeps trades where both LINEUPS improve, and a pick improves nobody's
       * lineup this year — so every contender-and-rebuilder trade fails that
       * test by construction. That is not a gap in the search, it is a different
       * kind of trade: one side is buying now and the other is selling now, and
       * each is measured on the axis it cares about.
       *
       * Dynasty only, and not because of a setting — in redraft a future pick is
       * not an asset and the whole shape is meaningless.
       */
      if (ctx.valueVariant?.dynasty && values) {
        const { rows: pv } = await db.query(
          `select name, value from player_values
            where position = 'PICK' and superflex = $1
              and captured_on = (select max(captured_on) from player_values)`,
          [Boolean(ctx.valueVariant?.superflex)]);
        const pickValues = new Map(pv.map(r => [r.name, r.value]));
        const traded = await fetch(
          `https://api.sleeper.app/v1/league/${ctx.sleeperLeagueId}/traded_picks`)
          .then(r => r.json()).catch(() => []);
        const seasons = [String(Number(ctx.season) + 1), String(Number(ctx.season) + 2)];
        const inventory = mm.pickInventory({
          rosters, tradedPicks: traded, seasons, rounds: lg.settings?.rounds || 4 });

        const pk = mm.findPickTrades({
          rosters, rosterPositions: lg.roster_positions, proj, values, pickValues,
          inventory, rosterId: me.rosterId,
        });
        if (pk) {
          const ord = r => ({ 1: '1st', 2: '2nd', 3: '3rd', 4: '4th' }[r] || `${r}th`);
          L.push('');
          if (pk.role === 'middle') {
            /*
             * A team in the middle is told it is in the middle, rather than
             * pushed to commit to a direction its own standing does not support.
             */
            L.push(`  PLAYERS FOR PICKS: ${me.name} sits ${pk.rank} of ${pk.of} on projected`
                 + ' lineup — neither buying nor selling. Say they are in the middle and that'
                 + ' this only makes sense once they pick a direction.');
          } else if (!pk.deals.length) {
            L.push(`  PLAYERS FOR PICKS: ${me.name} is ${pk.rank} of ${pk.of}, so a`
                 + ` ${pk.role === 'buying' ? 'buyer' : 'seller'} — but no fair player-for-picks`
                 + ' deal is available right now. Say that plainly.');
          } else {
            L.push(`  PLAYERS FOR PICKS. ${me.name} is ${pk.rank} of ${pk.of} on projected`
                 + ` lineup, so ${pk.role === 'buying'
                   ? 'a BUYER: spend picks on somebody who starts now'
                   : 'a SELLER: turn players who will not win you this year into picks'}.`);
            for (const d of pk.deals.slice(0, 3)) {
              const picks = d.picks.map(x => `${x.season} ${x.band.toLowerCase()} ${ord(x.round)}`
                + ` (originally ${nameOf(x.from)}'s)`).join(' and ');
              L.push(`    ${nameOf(d.seller)} sends ${d.player.name} to ${nameOf(d.buyer)}`
                   + ` for ${picks}. ${nameOf(d.buyer)} +${d.buyerGain} projected lineup points;`
                   + ` values ${d.edge}% apart.`);
            }
            L.push('    A future pick is priced by whose it is — a contender\'s own first lands'
                 + ' late and is worth less. That is a guess about next year\'s standings, so'
                 + ' call these fair rather than exact.');
          }
        }
      }
      return L.join('\n');
    },
  },

  /*
   * Who has gained and lost value in trades, at the time and in hindsight.
   *
   * TOP AND BOTTOM ONLY. A league can have hundreds of trades and a dozen
   * managers, and a full table is a wall nobody reads and a lot of tokens. The
   * ends are the argument; the middle is available by asking for a name.
   */
  trade_ledger: {
    describe: 'Who has gained or lost the most value in trades, both AT THE TIME of each '
            + 'trade and AS THINGS STAND NOW. Use for "who wins the most trades", "who is '
            + 'the best trader", "who helped their team most", "has my trading been any '
            + 'good", "who got better this offseason". Argument: manager=<name> (optional) '
            + 'to see one manager wherever they place.',
    args: { manager: 'string, a manager name, or omit for the top and bottom of the league' },
    async run(ctx, args) {
      const dv = require('./dynastyvalue');
      const sleeper = require('./sleeper');

      const { rows: trades } = await db.query(
        `select t.* from trades t join leagues l on l.id = t.league_id
          where l.sleeper_league_id = any($1::text[]) and t.status = 'complete'`,
        [ctx.chainIds || []]);
      if (!trades.length) return 'No completed trades are on record for this league.';

      const superflex = Boolean(ctx.valueVariant?.superflex);
      const book = await dv.loadValueBook({
        dates: [...trades.map(t => t.status_updated_at), null], superflex });
      if (!book) return 'No market values are loaded, so trades cannot be valued.';

      const slotMap = await sleeper.draftSlots(ctx.draftSchedule?.draftId).catch(() => null);
      const nameOf = rid => {
        const m = (ctx.members || []).find(x => Number(x.rosterId) === Number(rid));
        return m?.name || `roster ${rid}`;
      };
      const out = await dv.tradeLedger({
        trades, book, slots: slotMap ? dv.slotsFromDraft(slotMap) : new Map(),
        teams: ctx.draftSchedule?.teams || 12,
        slotSeason: ctx.draftSchedule?.season, nameOf,
      });
      if (!out.rows.length) return 'No trade could be valued for this league.';

      const c = out.coverage;
      const L = ['TRADE LEDGER. Lead with the GRADE and the PICK EQUIVALENT — "up about an early'
        + ' 1st" is something a person can feel, and the raw number is not. The bracketed'
        + ' figures are working: keep them back unless somebody asks how, or argues.',
        '  Two different questions, kept apart:',
        '  AT THE TIME — did the market agree with you the day you made the deal.',
        '  NOW — has it worked out since. A manager who buys players the market later'
        + ' re-rates looks bad on the first and good on the second, and that gap is the story.',
        `  Values compared over the ${c.bothPriced} trades that price at BOTH dates, of ${c.total}`
        + ` on record. ${c.thenOnly} price only at the time and ${c.unpriced} not at all — older`
        + ' players drop out of the value source entirely, so this leans recent. Say that if you'
        + ' quote a total.'];

      const N = Math.min(4, Math.max(1, Math.floor(out.rows.length / 3)));
      const show = args.manager
        ? out.rows.filter(r => r.name.toLowerCase().includes(String(args.manager).toLowerCase()))
        : null;

      if (args.manager && !show.length) {
        return `Nobody matching "${args.manager}" has a trade on record here.`;
      }

      /*
       * SAID IN PICKS, GRADED BY RANK — because "+7,492" is a number off a value
       * sheet and nobody in a group chat has a feel for it. Everybody knows
       * roughly what a first is worth. The raw totals stay, marked as working,
       * for the follow-up where somebody disputes it.
       */
      const { rows: pickRows } = await db.query(
        `select name, value from player_values
          where position = 'PICK' and superflex = $1
            and captured_on = (select max(captured_on) from player_values)`, [superflex]);
      const ladder = dv.pickLadder(pickRows);
      const say = v => dv.inPicks(v, ladder) || `${v}`;

      const line = r => {
        const g = dv.traderGrade(out.rows.indexOf(r) + 1, out.rows.length);
        /*
         * Near enough to zero that "up" or "down" overstates it. Somebody who
         * has traded to a standstill should be told that, not told they are up
         * an amount too small to name.
         */
        const tiny = Math.abs(r.now) < (ladder[ladder.length - 1]?.value || 0) * 0.6;
        const dir = tiny ? 'level, having traded to a standstill —' : (r.now >= 0 ? 'up' : 'down');
        // they/them: nobody has told us these managers' pronouns.
        const moved = Math.abs(r.swing) > Math.abs(r.now) * 0.25
          ? (r.swing > 0 ? ' It has moved their way since the deals were made.'
                         : ' It has moved against them since the deals were made.')
          : ' Roughly where it stood when the deals were made.';
        return `    ${r.name}: ${g.grade}, ${tiny ? dir : `${dir} ${say(r.now)}`}, ${g.say}.${moved}`
             + `  [working, do not volunteer: now ${r.now}, at the time ${r.thenMatched},`
             + ` swing ${r.swing}, ${r.wonThen}-${r.lostThen} on the day]`;
      };

      if (show) {
        L.push('');
        for (const r of show) {
          const at = out.rows.indexOf(r) + 1;
          L.push(`  ${r.name} is ${at} of ${out.rows.length}:`);
          L.push(line(r));
        }
        return L.join('\n');
      }

      L.push('');
      L.push(`  BEST ${N}, as things stand:`);
      for (const r of out.rows.slice(0, N)) L.push(line(r));
      L.push(`  WORST ${N}:`);
      for (const r of out.rows.slice(-N).reverse()) L.push(line(r));
      const middle = out.rows.length - 2 * N;
      if (middle > 0) {
        L.push(`  The other ${middle} are in the middle and NOT listed. Do not say they have no`
             + ' record or rank them — offer to pull up a name.');
      }
      return L.join('\n');
    },
  },

  /*
   * Every team's draft, graded and ranked, with what each roster is good at.
   *
   * THE MEASURE IS THE STARTING LINEUP, not the roster. A bench stacked with
   * running backs scores nothing, and a team can lead the league in total
   * projected points while starting a hole at tight end.
   *
   * SEASON projections, never weekly. The first cut used the current week's and
   * every team came back with an identical wall of empty slots and a total of
   * about 21 — one quarterback — because a preseason week projects almost
   * nobody. Grading a draft on one week would be wrong even if it worked.
   *
   * Ranks, grades and the positional strengths are all computed in
   * src/draftgrade.js. Handing a model twelve rosters and asking which drafted
   * best is asking for a ranking nothing downstream can check.
   */
  draft_grades: {
    describe: 'Grades and ranks every team in the league on the roster they drafted, with '
            + 'each team\'s strongest and weakest positions. Use for "grade my draft", '
            + '"who drafted best", "how did my team do", "rank the rosters", "who is the '
            + 'best team", "am I any good this year". Argument: manager=<name> (optional) '
            + 'to focus on one team; the full ranking comes either way.',
    args: { manager: 'string, a manager name to detail, or omit for the whole league' },
    async run(ctx, args) {
      const sleeper = require('./sleeper');
      const dg = require('./draftgrade');

      const [lg, rosters, proj] = await Promise.all([
        sleeper.leagueSettings(ctx.sleeperLeagueId).catch(() => null),
        sleeper.rosters(ctx.sleeperLeagueId).catch(() => null),
        sleeper.seasonProjections(ctx.season).catch(() => null),
      ]);
      if (!lg || !rosters || !proj) return 'Could not read the league from Sleeper right now.';

      const drafted = (rosters || []).reduce((a, r) => a + (r.players || []).length, 0);
      if (!drafted) {
        /*
         * Empty rosters mean the draft has not happened, which is a different
         * sentence from "everybody is terrible" — and the grades would happily
         * render as twelve identical zeroes without this.
         */
        return 'Nobody has drafted yet in this league — every roster is empty, so there is'
             + ' nothing to grade. Say the draft has not happened.';
      }

      const nameOf = rid => {
        const m = (ctx.members || []).find(x => Number(x.rosterId) === Number(rid));
        return m?.name || `roster ${rid}`;
      };

      /*
       * Dynasty is graded on the MARKET, not on this season's points.
       *
       * A rookie taken in the second round projects near nothing this year —
       * which is the point of the pick, you are betting he becomes a top-ten
       * back in a few seasons. Grading on season projections marks a team DOWN
       * for the asset it just drafted, so it gets exactly backwards the thing a
       * draft grade is for. Market values already price that bet.
       */
      const dynasty = Boolean(ctx.valueVariant?.dynasty);
      let values = null;
      if (dynasty) {
        const { rows } = await db.query(
          `select sleeper_id, value from player_values
            where source = 'ktc' and superflex = $1 and sleeper_id is not null
              and captured_on = (select max(captured_on) from player_values)`,
          [Boolean(ctx.valueVariant?.superflex)]);
        if (rows.length) values = new Map(rows.map(r => [String(r.sleeper_id), r.value]));
      }

      /*
       * Which of those are rookies, so a grade can say how much of it rests on
       * the market's least certain prices.
       */
      let rookies = null;
      if (values) {
        const { rows } = await db.query(
          `select player_id from players where years_exp = 0 and team is not null`);
        if (rows.length) rookies = new Set(rows.map(r => String(r.player_id)));
      }

      const out = dg.gradeDraft({
        rosters, rosterPositions: lg.roster_positions, proj, nameOf,
        values, rookies, basis: dynasty ? 'market' : 'projection',
      });
      if (!out) return 'Could not build lineups for this league.';
      const market = out.basis === 'market';
      const L = [market
        ? 'ROSTER GRADES, by DYNASTY MARKET VALUE of the whole roster. Ranks and letters are'
          + ' computed, so quote them and do not re-rank.'
        : 'DRAFT GRADES. Every team ranked on the STARTING LINEUP it can field, by'
          + ` Sleeper's ${ctx.season} season projections. Ranks and letters are computed,`
          + ' so quote them and do not re-rank.'];
      if (market) {
        L.push('  Market value, NOT this season\'s points, and that is deliberate. A rookie just'
             + ' drafted projects near nothing this year — that is the point of the pick, the bet'
             + ' is that he becomes a top-ten player in a few seasons — so grading dynasty on'
             + ' season projections marks a team DOWN for the asset it just acquired. Market'
             + ' values already price age and future upside.');
        L.push('  This is a keeper or dynasty league, so a roster is years of accumulation rather'
             + ' than one draft. Call it a roster ranking, not a draft grade.');
        L.push(`  League average roster value: ${out.mean}.`
             + ` Average projected starting lineup, a DIFFERENT question: ${out.lineupMean} points.`);
      } else {
        L.push(`  League average starting lineup: ${out.mean} projected points.`);
      }
      L.push('');
      /*
       * EVERY line carries its own strengths and weaknesses.
       *
       * The detail block only covered the team asked about, or the top and
       * bottom when nobody was named — so "what are my weaknesses" came back
       * "no weaknesses flagged, clean roster" to a manager sitting 11th at
       * running back and 12th at tight end. The asker's identity is not always
       * known here, and an absent line reads as an absence of the thing.
       *
       * Twelve short lines is a few hundred tokens and removes the whole class.
       */
      for (const t of out.teams) {
        const up = (t.strengths || []).map(x => x.pos).join('/');
        const down = (t.weaknesses || []).map(x => x.pos).join('/');
        const score = market
          ? `${t.market} in market value (${t.priced} players priced`
            + `${t.unpriced ? `, ${t.unpriced} the market does not cover` : ''})`
          : `${t.total} projected`;
        L.push(`  ${String(t.rank).padStart(2)}. ${t.name}: ${t.grade}, ${score}`
             + ` (${t.pctOver > 0 ? '+' : ''}${t.pctOver}% vs average, ${t.say})`
             + (market ? `. THIS SEASON they are ${t.lineupRank} of ${out.teams.length} on`
                       + ` projected lineup (${t.total})` : '')
             + (market && t.rookieShare >= 20
                 ? `. ${t.rookieShare}% of that value is ROOKIES, the least certain prices in the`
                   + ' market — the value is real but hold the grade more loosely'
                 : '')
             + (market && t.rookieCount
                 ? `. ${t.rookieCount} rookie${t.rookieCount === 1 ? '' : 's'} on this roster count`
                   + ' for NOTHING here, see the coverage note'
                 : '')
             + `. Strong: ${up || 'nothing stands out'}. Weak: ${down || 'nothing glaring'}`
             + (t.holes.length ? `. Cannot fill: ${t.holes.join(', ')}` : ''));
      }

      const focus = args.manager
        ? out.teams.filter(t => t.name.toLowerCase().includes(String(args.manager).toLowerCase()))
        : [out.teams[0], out.teams[out.teams.length - 1]];
      if (args.manager && !focus.length) {
        L.push('');
        L.push(`  Nobody matching "${args.manager}" is in this league, so no team is detailed.`);
        return L.join('\n');
      }
      if (args.manager && focus.length > 1) {
        L.push('');
        L.push(`  "${args.manager}" matches ${focus.length} managers — `
             + `${focus.map(f => f.name).join(' and ')}. Different people; ask which.`);
      }

      L.push('');
      L.push('  DETAIL — strengths and weaknesses are that position ranked ACROSS THE LEAGUE,'
           + ' not against some absolute bar:');
      for (const t of focus.slice(0, 3)) {
        const up = (t.strengths || []).map(x => `${x.pos} ${x.rank}${x.rank === 1 ? 'st' : x.rank === 2 ? 'nd' : x.rank === 3 ? 'rd' : 'th'} in the league (${x.points})`);
        const down = (t.weaknesses || []).map(x => `${x.pos} ${x.rank}${x.rank === 1 ? 'st' : 'th'} of ${out.teams.length} (${x.points})`);
        L.push(`    ${t.name} — ${t.grade}, ${t.rank} of ${out.teams.length}.`);
        L.push(`      Best at: ${up.join('; ') || 'nothing stands out'}`);
        L.push(`      Worst at: ${down.join('; ') || 'no glaring weakness'}`);
        if (t.holes.length) {
          L.push(`      CANNOT FILL: ${t.holes.join(', ')} — no projected player for those slots.`);
        }
      }
      if (market) {
        const uncovered = out.teams.reduce((a, t) => a + t.unpriced, 0);
        const rookiesHeld = out.teams.reduce((a, t) => a + (t.rookieCount || 0), 0);
        L.push('');
        L.push(`  COVERAGE: the value source prices a few hundred assets, not every player, so`
             + ` ${uncovered} rostered players across the league carry no value here and are`
             + ' excluded from every total above. Mostly deep-bench veterans.');
        if (rookiesHeld) {
          /*
           * The one that would quietly get a draft grade backwards. Not a
           * single rookie in the source carries a price, so a team that just
           * drafted well is counted at zero for exactly the assets it drafted —
           * the same failure as grading dynasty on season projections, arriving
           * by a different route.
           */
          L.push(`  AND ${rookiesHeld} of those are ROOKIES, who this source does not price at all.`
               + ' A team that just drafted well is therefore UNDERCOUNTED here, for precisely the'
               + ' assets it drafted. Say that plainly if a recently drafted team grades badly;'
               + ' do not present the grade as the whole story.');
        }
      }
      L.push('  Projections are Sleeper\'s, not yours. A grade here is what the roster projects'
           + ' to, not what it will do.');
      return L.join('\n');
    },
  },

  /*
   * Who is hurt, and how badly.
   *
   * The players table has carried injury_status for 718 men, refreshed every
   * morning, since long before this existed — and context.js mentioned injury
   * exactly nowhere, so the bot answered "is he playing?" with "check Sleeper"
   * about a row it already had. The most asked question in a fantasy group chat
   * and it was a plumbing gap.
   *
   * A LOOKUP rather than a standing section, because the full injury list is
   * hundreds of rows and any one question wants two of them.
   */
  injuries: {
    describe: 'Injury status for a named player, or for a manager\'s roster, or the whole '
            + 'league. Use for "is X playing", "is X hurt", "who is banged up on my team", '
            + '"any injuries I should know about". Arguments: player=<name> (optional), '
            + 'manager=<name> (optional). With neither, reports the notable injuries.',
    args: {
      player: 'string, a player name',
      manager: 'string, a manager name whose roster to check',
    },
    async run(ctx, args) {
      const L = [];
      const fmt = r => {
        const depth = r.depth_chart_order != null ? `, ${r.position}${r.depth_chart_order} on the depth chart` : '';
        const part = r.injury_body_part && r.injury_body_part !== 'Undisclosed'
          ? ` (${String(r.injury_body_part).toLowerCase()})` : '';
        const note = r.injury_notes ? ` — ${r.injury_notes}` : '';
        return `${r.full_name}, ${r.position} ${r.team || 'no team'}${depth}: `
             + `${r.injury_status || 'no injury designation'}${part}${note}`;
      };

      if (args.player) {
        const { rows } = await db.query(
          `select full_name, position, team, injury_status, injury_body_part, injury_notes,
                  depth_chart_order, player_status, updated_at
             from players where full_name ilike $1 order by
               case when team is not null then 0 else 1 end limit 4`,
          [`%${args.player}%`]);
        if (!rows.length) return `No player named "${args.player}" is on file.`;
        L.push(`INJURY LOOKUP for "${args.player}", as of the morning refresh`
             + ` (${String(rows[0].updated_at).slice(0, 10)}):`);
        for (const r of rows) L.push('  ' + fmt(r));
        /*
         * NO DESIGNATION IS NOT THE SAME AS HEALTHY, and the difference matters
         * in the offseason especially. Sleeper clears these between weeks.
         */
        if (rows.every(r => !r.injury_status)) {
          L.push('  Nobody there carries an injury designation right now. That means no listing,'
               + ' which is not quite the same as confirmed healthy — say it that way.');
        }
        return L.join('\n');
      }

      let rosterIds = null;
      if (args.manager) {
        const want = String(args.manager).toLowerCase();
        /*
         * Two Seans again. trade_value learned to announce a collision; taking
         * the first match here would silently report one man's injuries as
         * another's, which is worse than asking.
         */
        const hits = (ctx.members || []).filter(x => (x.name || '').toLowerCase().includes(want));
        if (!hits.length) return `No manager matching "${args.manager}" is in this league.`;
        if (hits.length > 1) {
          /*
           * Say what IS known, or the gap gets filled in. Told only that the
           * name was ambiguous, the reply added that injury reports were not
           * loaded for the season — untrue, and invented to explain an answer
           * it could not otherwise account for.
           */
          return `"${args.manager}" matches ${hits.length} managers — `
               + `${hits.map(h => h.name).join(' and ')}. They are different people with different`
               + ' rosters. Injury data IS available and current; the only thing missing is which'
               + ' of them you mean. Ask that, and do not say injuries are unavailable.';
        }
        const m = hits[0];
        const rs = await fetch(`https://api.sleeper.app/v1/league/${ctx.sleeperLeagueId}/rosters`)
          .then(r => r.json()).catch(() => []);
        const own = (rs || []).find(r => Number(r.roster_id) === Number(m.rosterId));
        if (!own) return `Could not read ${m.name}'s roster right now.`;
        rosterIds = own.players || [];
        L.push(`INJURY LOOKUP for ${m.name}'s roster:`);
      } else {
        L.push('INJURY LOOKUP, the notable ones across the NFL:');
      }

      const { rows } = await db.query(
        `select full_name, position, team, injury_status, injury_body_part, injury_notes,
                depth_chart_order, updated_at
           from players
          where injury_status is not null
            and ($1::text[] is null or player_id = any($1::text[]))
            and ($1::text[] is not null or depth_chart_order <= 2)
          order by case injury_status
                     when 'Out' then 1 when 'IR' then 2 when 'Doubtful' then 3
                     when 'PUP' then 4 else 5 end,
                   depth_chart_order nulls last, full_name
          limit 25`, [rosterIds]);

      if (!rows.length) {
        return (rosterIds
          ? 'Nobody on that roster carries an injury designation right now.'
          : 'No injury designations on file right now.')
          + ' That means no listing, which is not the same as confirmed healthy.';
      }
      for (const r of rows) L.push('  ' + fmt(r));
      L.push('  Statuses come from Sleeper and are refreshed each morning, so a designation set'
           + ' later today will not be here yet. Questionable usually plays; Out, IR and PUP do not.');
      return L.join('\n');
    },
  },

  /*
   * The league's own rules.
   *
   * Deliberately NOT a standing context section. Scoring and roster format are
   * static, asked about maybe once a season, and would be paid for on every
   * reply forever — the exact cost that made the whole retrieval layer worth
   * building. Standing context is for what shapes many answers; a lookup is for
   * what one question needs in full.
   */
  league_rules: {
    describe: 'This league\'s own settings: scoring, roster slots, playoff format, waiver type. '
            + 'Use for "what is our scoring", "how many teams make playoffs", "is this PPR", '
            + '"how many starters do we have", "what are our waiver rules".',
    args: {},
    async run(ctx) {
      const lg = await require('./sleeper').leagueSettings(ctx.sleeperLeagueId).catch(() => null);
      if (!lg) return 'Could not read this league\'s settings from Sleeper right now.';

      const L = ['LEAGUE RULES, read from Sleeper just now:'];
      const slots = lg.roster_positions || [];
      const starters = slots.filter(p => p !== 'BN' && p !== 'IR' && p !== 'TAXI');
      const counts = starters.reduce((a, p) => (a[p] = (a[p] || 0) + 1, a), {});
      L.push(`  ${lg.total_rosters || '?'} teams, ${starters.length} starters:`
           + ` ${Object.entries(counts).map(([k, v]) => `${v}x ${k}`).join(', ')}`);
      L.push(`  Bench ${slots.filter(p => p === 'BN').length}`
           + `, IR ${slots.filter(p => p === 'IR').length}`
           + `, taxi ${slots.filter(p => p === 'TAXI').length}.`);

      const sc = lg.scoring_settings || {};
      const rec = sc.rec ?? 0;
      L.push(`  Receptions are worth ${rec} each`
           + ` — ${rec === 1 ? 'full PPR' : rec === 0.5 ? 'half PPR' : rec === 0 ? 'standard, no PPR' : 'a custom rate'}.`);
      L.push(`  Passing TD ${sc.pass_td ?? '?'}, rushing TD ${sc.rush_td ?? '?'},`
           + ` receiving TD ${sc.rec_td ?? '?'}, interception ${sc.pass_int ?? '?'},`
           + ` fumble lost ${sc.fum_lost ?? '?'}.`);
      const st = lg.settings || {};
      L.push(`  Playoffs: ${st.playoff_teams ?? '?'} teams, starting week ${st.playoff_week_start ?? '?'}.`);
      const waiver = { 0: 'rolling waivers', 1: 'reverse standings', 2: 'FAAB' }[st.waiver_type];
      L.push(`  Waivers: ${waiver || `type ${st.waiver_type ?? 'unknown'}`}`
           + `${st.waiver_budget ? `, ${st.waiver_budget} FAAB budget` : ''}.`);
      L.push(`  Trade deadline: week ${st.trade_deadline ?? 'not set'}.`);
      L.push('  These are THIS league\'s settings, not defaults. Quote them; do not generalise'
           + ' from how fantasy leagues usually work.');
      return L.join('\n');
    },
  },

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
      order: ['lopsided', 'even', 'recent'],
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

      const superflex = Boolean(ctx.valueVariant?.superflex);
      const teams = ctx.draftSchedule?.teams || 12;
      const slotMap = await require('./sleeper').draftSlots(ctx.draftSchedule?.draftId).catch(() => null);
      const slots = slotMap ? dv.slotsFromDraft(slotMap) : new Map();

      /*
       * THE LEAGUE'S OWN SPREAD, so a letter means something at scale.
       *
       * Fixed bands handed A+ to 27% of this league's trades — at a few hundred
       * trades that is eighty A+ grades and a letter that says nothing. Graded
       * against the population instead, A+ is the most lopsided tenth.
       *
       * Pricing every trade to build that spread is affordable only because the
       * value book makes it one query: 112 pricings ran in 8ms behind it.
       */
      /*
       * The yardstick is EVERY trade the league has made, not the ones being
       * shown. Filtered to one season the population fell to four, dropped
       * below the threshold, silently reverted to fixed bands — and the text
       * still said "graded against the 4 trades", which was a sentence about a
       * scale that was not being used.
       */
      const { rows: allTrades } = await db.query(
        `select t.status_updated_at, t.received, t.roster_ids, t.draft_picks, t.season
           from trades t join leagues l on l.id = t.league_id
          where l.sleeper_league_id = any($1::text[]) and t.status = 'complete'`,
        [ctx.chainIds || []]);

      const book = await dv.loadValueBook({
        dates: [...allTrades.map(t => t.status_updated_at), null], superflex });
      const population = [];
      if (book) {
        for (const t of allTrades) {
          const p = await dv.priceTrade(t, {
            book, slots, teams, slotSeason: ctx.draftSchedule?.season, asOf: t.status_updated_at });
          if (!p || p.margin == null) continue;
          const pot = p.sides.reduce((a, sd) => a + sd.value, 0);
          if (pot) population.push(Math.abs(p.margin / pot));
        }
      }

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

      /*
       * MOST LOPSIDED, when that is what was asked.
       *
       * "What was the worst trade" used to reach trade_extremes, which reads
       * stored verdicts and therefore answers "none graded here" in every
       * dynasty league — while this lookup, which grades them on the market,
       * sat unused. Sorting needs every trade priced first, which the value
       * book already made cheap.
       */
      if (args.order === 'lopsided' || args.order === 'even') {
        const scored = [];
        for (const t of items) {
          const p = await dv.priceTrade(t, {
            book, slots, teams, population,
            slotSeason: ctx.draftSchedule?.season, asOf: t.status_updated_at });
          if (!p || p.margin == null) continue;
          const pot = p.sides.reduce((a, sd) => a + sd.value, 0);
          if (pot) scored.push({ t, edge: Math.abs(p.margin / pot) });
        }
        scored.sort((a, b) => (args.order === 'even' ? a.edge - b.edge : b.edge - a.edge));
        items = scored.map(x => x.t);
      }

      items = items.slice(0, SHOW);


      /*
       * Rosters are TODAY'S, so the handcuff check runs only on this season's
       * trades. Asking whether two men are teammates in 2026 answers nothing
       * about a 2021 deal, and a confidently wrong handcuff is worse than none.
       */
      const thisSeason = String(ctx.season || new Date().getFullYear());
      let rosters = null;
      let lgSettings;      // undefined until first needed, then null on failure
      let seasonProj;

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
        const how = args.order === 'lopsided' ? 'MOST LOPSIDED'
          : args.order === 'even' ? 'CLOSEST' : 'MOST RECENT';
        L.push(`  THESE ARE THE ${items.length} ${how} OF ${matched}`
             + `${args.manager ? ` involving ${args.manager}` : ''}${args.season ? ` in ${args.season}` : ''}.`
             + ' Older ones exist and are not priced here, so do NOT say a pairing has never'
             + ' traded, and do not count from this list. Ask for a season to see further back.');
        /*
         * A SORTED list has an answer at the top, and saying only "4 of 48"
         * made the reply refuse to name it — "can't crown a worst, I've only
         * got the 4 most lopsided" — while holding the most lopsided of all 48
         * on the first line. The truncation warning is about counting, not
         * about the ranking.
         */
        if (args.order === 'lopsided' || args.order === 'even') {
          L.push(`  All ${matched} were ranked to build this, so the FIRST one below IS the`
               + ` ${args.order === 'even' ? 'closest' : 'most lopsided'} of them. Name it`
               + ' outright. The cut only limits how many are shown, not what was compared.');
        }
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
          superflex, teams, slots, book, population,
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
                 + ` ${nameOf(priced.sides[priced.sides.length - 1].rosterId)} ${g.lost}`
                 + `${g.say ? ` — ${g.say}` : ''}.`
                 + (population.length >= dv.MIN_POPULATION
                     ? ` Graded against all ${population.length} trades this league has made, so`
                       + ' the letter is relative to THIS league.'
                     : ` This league has only ${population.length} priced trades, too few to rank`
                       + ' against, so this is a general scale rather than a league one. Say the'
                       + ' grade, but do not claim it is relative to this league.')
                 + ' Quote it; do not invent your own or adjust it.');
          }
        } else {
          L.push(`    NO MARGIN AND NO GRADE: ${priced.unpricedReason}. Say that rather than`
               + ' guessing either.');
        }
        for (const a of priced.assumptions) {
          L.push(`    ASSUMED: ${a.label} priced as ${a.from}, because no quote for it exists on`
               + ' that date. Which way that leans is NOT known — measured against a real price'
               + ' the moment one appeared, a 2027 second was worth MORE than the 2026 one, not'
               + ' less. Treat the margin as approximate and say so.');
        }

        if (t.season === thisSeason) {
          if (rosters === null) {
            rosters = await fetch(`https://api.sleeper.app/v1/league/${ctx.sleeperLeagueId}/rosters`)
              .then(r => r.json()).catch(() => []);
          }

          /*
           * THE OTHER AXIS, and it is not zero-sum.
           *
           * Market value is: whatever one side gained the other lost, which is
           * why the letters mirror. Roster FIT is not. Four good receivers and
           * no tight end against three tight ends and no receiver, swapped at
           * identical value, leaves both lineups better — and a grade that can
           * only name a winner calls one of those two a loser for making the
           * best trade available to them.
           */
          const dg = require('./draftgrade');
          if (lgSettings === undefined) {
            lgSettings = await require('./sleeper').leagueSettings(ctx.sleeperLeagueId).catch(() => null);
            seasonProj = await require('./sleeper').seasonProjections(ctx.season).catch(() => null);
          }
          if (lgSettings && seasonProj) {
            const im = dg.lineupImpact(t, {
              rosters, rosterPositions: lgSettings.roster_positions, proj: seasonProj });
            if (im) {
              L.push(`    LINEUP: ${im.sides.map(sd => `${nameOf(sd.rosterId)} `
                + `${sd.delta > 0 ? '+' : ''}${sd.delta}`).join(', ')} projected points to the`
                + ' starting lineup they can now field.');
              if (im.bothUp) {
                L.push('    BOTH ROSTERS GOT BETTER. Value is zero-sum and this is not: each side'
                     + ' traded from surplus into a hole. Do NOT call either of them the loser —'
                     + ' the value letters describe who got more, not who was hurt. Say it helped'
                     + ' them both, and that on paper one got more of the surplus.');
              } else if (im.bothDown) {
                L.push('    BOTH LINEUPS GOT WORSE this season, which usually means picks or'
                     + ' futures went out for nothing that starts. Worth saying.');
              }
            }
          }
          for (const side of priced.sides) {
            const own = (rosters || []).find(r => Number(r.roster_id) === side.rosterId);
            const flags = await dv.rosterFlags(side.players.map(pl => pl.playerId), own?.players || [])
              .catch(() => []);
            for (const f of flags) {
              const rank = f.depth != null
                ? `the ${f.position}${f.depth}${f.immediate ? ' directly behind' : ' behind'} `
                  + `${f.handcuffOf} (${f.position}${f.starterDepth})`
                : `a backup to ${f.handcuffOf}, depth chart rank unknown`;
              L.push(`    ROSTER: ${f.name} is ${rank} on ${nameOf(side.rosterId)}'s own roster`
                   + ` (both ${f.team})`
                   + (f.starterInjury
                       ? `, and ${f.handcuffOf} is ${f.starterInjury}`
                         + `${f.starterBodyPart ? ` with a ${String(f.starterBodyPart).toLowerCase()}` : ''}`
                         + `${f.starterNotes ? ` — ${f.starterNotes}` : ''}`
                         + '. Price alone cannot see that, so a deal that looks like an overpay may'
                         + ' be insurance somebody chose to buy. Say so; do not change the grade.'
                       : '.'));
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
