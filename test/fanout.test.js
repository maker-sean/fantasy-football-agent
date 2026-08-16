#!/usr/bin/env node
/**
 * Fan-out across leagues.
 *
 * Two properties matter and neither is throughput: one bad league must not
 * abort the rest, and the work must not all land in the same instant.
 */
const assert = require('assert');
const { mapLimit, jitterFor, forEachLeague } = require('../src/fanout');

let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('bounded concurrency');

  await it('never exceeds the limit', async () => {
    let live = 0, peak = 0;
    await mapLimit([...Array(30).keys()], async () => {
      peak = Math.max(peak, ++live);
      await sleep(5);
      live--;
    }, { limit: 4 });
    assert.strictEqual(peak, 4, `peaked at ${peak}`);
  });

  await it('actually runs concurrently, not serially', async () => {
    const t = Date.now();
    await mapLimit([...Array(12).keys()], () => sleep(20), { limit: 6 });
    const ms = Date.now() - t;
    assert.ok(ms < 120, `took ${ms}ms — serial would be ~240ms`);
  });

  await it('runs every item exactly once', async () => {
    const seen = [];
    await mapLimit([...Array(50).keys()], async i => { seen.push(i); }, { limit: 7 });
    assert.deepStrictEqual(seen.sort((a, b) => a - b), [...Array(50).keys()]);
  });

  console.log('\none bad league must not take down the run');

  await it('a thrown handler is captured, not propagated', async () => {
    const out = await mapLimit([1, 2, 3], async n => {
      if (n === 2) throw new Error('sleeper 500');
      return n * 10;
    }, { limit: 2 });
    assert.strictEqual(out[0].value, 10);
    assert.strictEqual(out[1].ok, false);
    assert.strictEqual(out[1].error.message, 'sleeper 500');
    assert.strictEqual(out[2].value, 30, 'the league after the failure still ran');
  });

  await it('results stay in input order regardless of finish order', async () => {
    const out = await mapLimit([30, 5, 1], async ms => { await sleep(ms); return ms; }, { limit: 3 });
    assert.deepStrictEqual(out.map(r => r.value), [30, 5, 1]);
  });

  await it('an empty list is not an error', async () => {
    assert.deepStrictEqual(await mapLimit([], async () => 1), []);
  });

  console.log('\njitter — spreading sends so they do not look like a burst');

  await it('stays inside the window', () => {
    for (let i = 0; i < 500; i++) {
      const j = jitterFor('league-' + i, 60000);
      assert.ok(j >= 0 && j < 60000, `${j} out of range`);
    }
  });

  await it('is stable for a league across runs', () => {
    assert.strictEqual(jitterFor('abc', 60000), jitterFor('abc', 60000));
  });

  await it('actually spreads — not everyone in one slot', () => {
    const buckets = new Set();
    for (let i = 0; i < 100; i++) buckets.add(Math.floor(jitterFor('league-' + i, 60000) / 6000));
    assert.ok(buckets.size >= 8, `only ${buckets.size} of 10 buckets used`);
  });

  await it('a zero spread disables it, for deadline work', () => {
    assert.strictEqual(jitterFor('abc', 0), 0);
  });

  await it('forEachLeague with no spread does not delay', async () => {
    const t = Date.now();
    await forEachLeague([{ id: 'a' }, { id: 'b' }], async () => {}, { spreadMs: 0 });
    assert.ok(Date.now() - t < 50);
  });

  console.log(`\n${pass} passing`);
})();
