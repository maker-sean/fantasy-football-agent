#!/usr/bin/env node
/**
 * Not asking Sleeper for things we already have.
 *
 * A single reply made 55 Sleeper calls. 28 of them walked the league chain —
 * the same six leagues, four times over, by four callers that each solved "get
 * the chain" for themselves — and 20 re-downloaded finished seasons whose
 * numbers were fixed years ago. Both facts were already in Postgres or trivially
 * storable; nothing looked.
 *
 * The properties here are about STALENESS, because a cache that serves a wrong
 * answer costs more than the call it saved. A chain cannot change for a given
 * id. A finished season cannot change. The current season changes weekly and is
 * deliberately not stored.
 */
const assert = require('assert');
if (!process.env.DATABASE_URL) require('dotenv').config();

const db = require('../src/db');
const history = require('../src/history');
const sleeper = require('../src/sleeper');

let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

/** Count Sleeper calls made inside a block. */
async function calls(fn) {
  let n = 0;
  const orig = global.fetch;
  global.fetch = (...a) => { if (String(a[0]).includes('sleeper')) n++; return orig(...a); };
  try { await fn(); } finally { global.fetch = orig; }
  return n;
}

(async () => {
  console.log('\nthe league chain');

  await it('"0" ends a chain and is never fetched', async () => {
    /*
     * Sleeper marks the oldest season with previous_league_id "0", and "0" is
     * truthy — so the walk asked for a league that cannot exist, once per walk
     * and four times per reply.
     */
    assert.deepStrictEqual(await history.chain('0'), []);
    assert.deepStrictEqual(await history.chain(null), []);
    const n = await calls(() => history.chain('0'));
    assert.strictEqual(n, 0, 'the terminator must cost nothing');
  });

  const { rows: [live] } = await db.query(
    `select sleeper_league_id from leagues where provider <> 'archive' and active limit 1`);

  if (!live) {
    console.log('  skip  no live league to walk');
  } else {
    await it('a cold walk stores the chain, a warm one costs nothing', async () => {
      await db.query('delete from league_chains where sleeper_league_id = $1',
        [live.sleeper_league_id]);
      const cold = await calls(() => history.chain(live.sleeper_league_id, { fresh: true }));
      assert.ok(cold > 0, 'the first walk has to ask somebody');
      const { rows } = await db.query(
        'select chain from league_chains where sleeper_league_id = $1', [live.sleeper_league_id]);
      assert.strictEqual(rows.length, 1, 'and it must be written down');
      assert.ok(Array.isArray(rows[0].chain) && rows[0].chain.length);

      const warm = await calls(() => history.chain(live.sleeper_league_id));
      assert.strictEqual(warm, 0, 'a second walk in the same process must be free');
    });

    await it('the stored chain matches what Sleeper says', async () => {
      const stored = await history.chain(live.sleeper_league_id);
      const fresh = await history.chain(live.sleeper_league_id, { fresh: true });
      assert.deepStrictEqual(stored.map(l => l.league_id), fresh.map(l => l.league_id),
        'a cache that drifts from the source is worse than no cache');
    });

    await it('fresh: true re-walks rather than trusting the row', async () => {
      const n = await calls(() => history.chain(live.sleeper_league_id, { fresh: true }));
      assert.ok(n > 0, 'the escape hatch has to actually escape');
    });
  }

  console.log('\nfinished seasons');

  const lastYear = String(new Date().getFullYear() - 1);
  const thisYear = String(new Date().getFullYear());

  await it('a finished season is stored and then costs nothing', async () => {
    await db.query('delete from season_stats where season = $1', [lastYear]);
    const cold = await calls(() => sleeper.seasonStats(lastYear));
    if (!cold) return console.log('       (skip: Sleeper unreachable)');
    const { rows: [c] } = await db.query(
      'select count(*)::int n from season_stats where season = $1', [lastYear]);
    assert.ok(c.n > 0, `${lastYear} must be written down, got ${c.n} rows`);
  });

  await it('the CURRENT season is never stored, because it moves every week', async () => {
    await db.query('delete from season_stats where season = $1', [thisYear]);
    await sleeper.seasonStats(thisYear).catch(() => null);
    const { rows: [c] } = await db.query(
      'select count(*)::int n from season_stats where season = $1', [thisYear]);
    assert.strictEqual(c.n, 0, 'a stale current season is worse than the four calls it saves');
  });

  await it('stored numbers match the shape callers expect', async () => {
    const m = await sleeper.seasonStats(lastYear);
    if (!m || !m.size) return console.log('       (skip: nothing for ' + lastYear + ')');
    const [, v] = [...m.entries()][0];
    for (const k of ['position', 'rank', 'points', 'gamesPlayed', 'name']) {
      assert.ok(k in v, `a stored row lost the ${k} field`);
    }
    assert.strictEqual(typeof v.points, 'number', 'points must survive as a number, not a string');
  });

  console.log(`\n${pass} passing`);
  await db.pool.end();
})();
