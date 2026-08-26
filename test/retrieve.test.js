#!/usr/bin/env node
/**
 * Routing a question to the context it needs, and running the lookups.
 *
 * Two things here can go wrong quietly, and both have a precedent in this repo.
 *
 *   1. FAILING CLOSED. A router that errors, times out, or answers with junk
 *      must load everything, because a missing section does not announce
 *      itself — it comes back as a confident "there is nothing on record" for
 *      a league with a hundred trades. Slow and expensive is recoverable; a
 *      denial of real data is not.
 *
 *   2. TAKING THE MODEL'S ARGUMENTS ON TRUST. The router names a query and its
 *      arguments. The query is fixed and lives in code; the arguments are
 *      checked against an enum first. Anything else would be letting the model
 *      compose the lookup, which is the deriving it cannot do reliably.
 *
 * The router client is injected rather than stubbed at the module, because the
 * last two times a double sat next to the code path instead of on it the tests
 * passed against nothing. These drive the real parse.
 */
const assert = require('assert');
if (!process.env.DATABASE_URL) require('dotenv').config();

const { route, NAMES } = require('../src/retrieve');
const retrievers = require('../src/retrievers');

/*
 * A LIST ROW, as distinct from a verdict line.
 *
 * Both say "X outscored Y by N" now — deliberately, since a verdict line that
 * needed the rows above for its names got them backwards once. Only the rows
 * are the ordered list, so only they can be checked for ordering, and matching
 * on "outscored" alone quietly pulled the verdicts in and made the ordering
 * assertions fail against correct output.
 */
const rowsOf = out => out.split('\n').filter(l => /^\s{2,}\d{4} week \d+: /.test(l));
const marginOf = line => Number(line.match(/ by ([\d.]+)/)[1]);

let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

// A client that returns whatever the router is supposed to have said.
const says = text => ({
  messages: { create: async () => ({ content: [{ type: 'text', text }], model: 'test', usage: {} }) },
});
const dies = msg => ({ messages: { create: async () => { throw new Error(msg); } } });

(async () => {
  console.log('\nthe router picks sections');

  await it('a named section is taken', async () => {
    const r = await route('q', { client: says('sections: trades\nlookup: none') });
    assert.deepStrictEqual(r.sections, ['trades']);
    assert.strictEqual(r.lookup, null);
  });

  await it('several sections come back in order, deduped', async () => {
    const r = await route('q', { client: says('sections: history, trades, history') });
    assert.deepStrictEqual(r.sections, ['history', 'trades']);
  });

  await it('"none" is a real answer and loads only the core', async () => {
    const r = await route('q', { client: says('sections: none\nlookup: none') });
    assert.deepStrictEqual(r.sections, []);
  });

  await it('a section that does not exist is dropped, not passed through', async () => {
    const r = await route('q', { client: says('sections: trades, salaries') });
    assert.deepStrictEqual(r.sections, ['trades']);
  });

  console.log('\nit fails OPEN, never closed');

  await it('an error loads every section', async () => {
    const r = await route('q', { client: dies('overloaded') });
    assert.deepStrictEqual(r.sections, NAMES);
    assert.strictEqual(r.meta.fellBack, 'error');
  });

  await it('an unparseable answer loads every section', async () => {
    const r = await route('q', { client: says('I think probably the trade stuff?') });
    assert.deepStrictEqual(r.sections, NAMES);
    assert.strictEqual(r.meta.fellBack, 'unparsed');
  });

  await it('junk that mentions no real section still loads everything', async () => {
    const r = await route('q', { client: says('sections: banana') });
    assert.deepStrictEqual(r.sections, NAMES);
  });

  console.log('\nlookup arguments are validated, not trusted');

  await it('a lookup and its arguments survive', async () => {
    const r = await route('q', { client: says('sections: none\nlookup: trade_extremes order=even manager=Brennan') });
    assert.strictEqual(r.lookup.name, 'trade_extremes');
    assert.deepStrictEqual(r.lookup.args, { order: 'even', manager: 'Brennan' });
  });

  await it('an enum argument outside its enum is dropped', async () => {
    const r = await route('q', { client: says('sections: none\nlookup: trade_extremes order=sideways') });
    assert.deepStrictEqual(r.lookup.args, {}, 'order=sideways must not reach the query');
  });

  await it('an unknown argument name is dropped', async () => {
    const r = await route('q', { client: says('sections: none\nlookup: trade_extremes order=even limit=999') });
    assert.deepStrictEqual(r.lookup.args, { order: 'even' });
  });

  await it('an unknown lookup name yields no lookup at all', async () => {
    const r = await route('q', { client: says('sections: none\nlookup: drop_table_trades') });
    assert.strictEqual(r.lookup, null);
  });

  await it('a lookup this registry does not have cannot be run', async () => {
    assert.strictEqual(await retrievers.run({}, { name: 'nope', args: {} }), null);
  });

  console.log('\nthe trade lookup, against real rows');

  const db = require('../src/db');
  const { rows: [lg] } = await db.query(
    `select id from leagues where name = 'Halcyon Kings' limit 1`);

  if (!lg) {
    console.log('  skip  no Halcyon Kings league in this database');
  } else {
    const { leagueContext } = require('../src/context');
    const ctx = await leagueContext(lg.id);

    await it('the closest trade is the smallest margin, not merely an early row', async () => {
      const out = await retrievers.run(ctx, { name: 'trade_extremes', args: { order: 'even' } });
      const nums = rowsOf(out).map(marginOf);
      assert.ok(nums.length > 1, 'expected several rows');
      assert.deepStrictEqual(nums, [...nums].sort((a, b) => a - b), 'rows must ascend by margin');
    });

    await it('the lopsided end descends by margin', async () => {
      const out = await retrievers.run(ctx, { name: 'trade_extremes', args: { order: 'lopsided' } });
      const nums = rowsOf(out).map(marginOf);
      assert.deepStrictEqual(nums, [...nums].sort((a, b) => b - a));
    });

    await it('when points and value disagree, BOTH leaders are named', async () => {
      /*
       * The regression this exists for: the block used to print a value gap
       * beside each row and assert the top row was the answer. Asked for the
       * worst trade the model returned the second row, whose gap was larger.
       * It was reading the block correctly; the block was making a claim it
       * had not earned.
       */
      const out = await retrievers.run(ctx, { name: 'trade_extremes', args: { order: 'lopsided' } });
      assert.ok(/MOST LOPSIDED BY POINTS:/.test(out), 'points leader must be named');
      assert.ok(/MOST LOPSIDED BY VALUE:|both measures agree/.test(out),
        'value leader must be named, or the agreement stated');
    });

    await it('a tie at the even end is called a tie rather than ordered', async () => {
      const out = await retrievers.run(ctx, { name: 'trade_extremes', args: { order: 'even' } });
      if (/exactly tied/.test(out)) {
        assert.ok(/none of them is "the" most even/.test(out));
      }
    });

    await it('every verdict line names both managers, so none needs the list above', async () => {
      /*
       * The regression: verdict lines used to read "CLOSEST BY VALUE: 2022 week
       * 9, gap 0" and leave the names to the rows above. Asked for Brennan's
       * most even trade the reply said "Marlow outscored Brennan" when the row
       * said the opposite — it went back for the names and flipped them.
       */
      for (const args of [{ order: 'even' }, { order: 'lopsided' }, { order: 'even', manager: 'Brennan' }]) {
        const out = await retrievers.run(ctx, { name: 'trade_extremes', args });
        const verdicts = out.split('\n').filter(l => /BY POINTS:|BY VALUE:/.test(l));
        assert.ok(verdicts.length, `no verdict line for ${JSON.stringify(args)}`);
        for (const line of verdicts) {
          assert.ok(/outscored/.test(line), `verdict line lacks its own names: ${line}`);
          assert.ok(/\d{4} week \d+/.test(line), `verdict line lacks its own date: ${line}`);
        }
      }
    });

    await it('the league name is not mistaken for a manager', async () => {
      /*
       * "The most even trade in Halcyon history" routed to manager=Halcyon,
       * matched nobody, and answered that no trade involves anyone by that
       * name. True, and useless: it is the league.
       */
      const out = await retrievers.run(ctx, { name: 'trade_extremes', args: { order: 'even', manager: 'Halcyon' } });
      assert.ok(!/No settled trade on record/.test(out),
        'the league name must be dropped as a filter, not filtered on');
      assert.ok(/outscored/.test(out), out);
    });

    await it('a manager filter only returns trades that manager was in', async () => {
      const out = await retrievers.run(ctx, { name: 'trade_extremes', args: { order: 'even', manager: 'Brennan' } });
      for (const line of rowsOf(out)) {
        assert.ok(/Brennan/.test(line), `Brennan absent from: ${line}`);
      }
    });

    await it('a manager nobody matches says so instead of returning the league', async () => {
      const out = await retrievers.run(ctx, { name: 'trade_extremes', args: { order: 'even', manager: 'Nobodyhere' } });
      assert.ok(/No settled trade on record/.test(out), out);
    });

    await it('a season filter does not leak other seasons', async () => {
      const out = await retrievers.run(ctx, { name: 'trade_extremes', args: { order: 'even', season: '2022' } });
      for (const line of out.split('\n')) {
        for (const [, year] of line.matchAll(/(\d{4}) week /g)) {
          assert.strictEqual(year, '2022', `leaked a non-2022 season: ${line}`);
        }
      }
    });
  }

  console.log(`\n${pass} passing`);
  await db.pool.end();
})();
