#!/usr/bin/env node
/**
 * Weekly history, and thinning what the daily pull leaves behind.
 *
 * The sheet carries a row a day back to 2020-04-01. Ingested daily that is
 * 1.62M rows and roughly 633MB against a 27MB database, past the tier ceiling
 * on one table; weekly is 231k rows and about 90MB. The accuracy given up is
 * small enough to be the second reason rather than the first: these values
 * answer "what was this worth around the time of that trade", so the nearest
 * capture lands within three days and dynasty values drift a percent or two a
 * week absent injury news.
 *
 * thin() DELETES, which is why the tests below care most about what it leaves
 * alone: anything inside the window, and the first capture of every week.
 */
const assert = require('assert');
if (!process.env.DATABASE_URL) require('dotenv').config();

const pv = require('../src/playervalues');
const db = require('../src/db');

let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

const SRC = 'zz_test_thin';
const put = (day, name, value) => db.query(
  `insert into player_values (source, captured_on, sleeper_id, name, position, team, superflex, tep, value)
   values ($1,$2,null,$3,'WR',null,false,'none',$4)`, [SRC, day, name, value]);
const ago = n => {
  const d = new Date(Date.now() - n * 864e5);
  return d.toISOString().slice(0, 10);
};

(async () => {
  console.log('\nweeks, counted the same way for every asset');

  await it('days in the same ISO week share a key, and Monday starts a new one', async () => {
    assert.strictEqual(pv.weekKey('2026-08-25'), pv.weekKey('2026-08-27'));
    assert.notStrictEqual(pv.weekKey('2026-08-23'), pv.weekKey('2026-08-24'));
  });

  console.log('\nthinning leaves the recent window alone');

  await db.query('delete from player_values where source = $1', [SRC]);
  // Three consecutive days well outside the window, plus one inside it.
  for (const d of [ago(200), ago(199), ago(198), ago(5)]) await put(d, 'Test Asset', 100);

  await it('a dry run reports what would go without going', async () => {
    const before = await db.query('select count(*)::int n from player_values where source = $1', [SRC]);
    const out = await pv.thin({ days: 90, dryRun: true });
    assert.ok(out.wouldDelete >= 2, `expected at least 2 doomed, got ${out.wouldDelete}`);
    const after = await db.query('select count(*)::int n from player_values where source = $1', [SRC]);
    assert.strictEqual(after.rows[0].n, before.rows[0].n, 'a dry run must not delete anything');
  });

  await it('inside the window nothing is touched, and each old week keeps its first day', async () => {
    await pv.thin({ days: 90 });
    const { rows } = await db.query(
      'select captured_on from player_values where source = $1 order by captured_on', [SRC]);
    const kept = rows.map(r => r.captured_on.toISOString().slice(0, 10));
    assert.ok(kept.includes(ago(5)), 'the recent capture must survive');
    // The three old days are one or two ISO weeks; either way the earliest of
    // each surviving week must be the one kept.
    const olds = kept.filter(d => d !== ago(5));
    assert.ok(olds.length >= 1 && olds.length < 3, `expected old days collapsed, kept ${olds.join(',')}`);
    assert.ok(olds.includes(ago(200)), 'the first day of the oldest week must be the survivor');
  });

  await it('running it twice removes nothing further', async () => {
    const first = await db.query('select count(*)::int n from player_values where source = $1', [SRC]);
    await pv.thin({ days: 90 });
    const second = await db.query('select count(*)::int n from player_values where source = $1', [SRC]);
    assert.strictEqual(second.rows[0].n, first.rows[0].n, 'thinning must be idempotent');
  });

  await db.query('delete from player_values where source = $1', [SRC]);
  console.log(`\n${pass} passing`);
  await db.pool.end();
})();
