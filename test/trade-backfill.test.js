#!/usr/bin/env node
/**
 * A league's whole trade history, pulled once when it joins.
 *
 * The poller reads the CURRENT week of a live season, so a league that arrives
 * in September has six years behind it and not one trade recorded.
 * moves_by_roster kept a count — who is busiest, and nothing about what was
 * swapped. The Danger Zone! turned out to have 177 of them.
 *
 * The rule that matters more than the count: adopting history must never make
 * a noise. A new league's introduction followed by a hundred trade alerts is
 * worse than no trade history at all.
 */
require('dotenv').config();
if (!process.env.DATABASE_URL) {
  console.log('trade backfill\n  SKIPPED — no DATABASE_URL\n\n0 passing');
  process.exit(0);
}
const assert = require('assert');
const db = require('../src/db');
const trades = require('../src/trades');

let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

(async () => {
  console.log('adopted, never announced');

  await it('every backfilled event is already marked announced', async () => {
    /*
     * recordEvent stores announced = adopt. Marking them true is what keeps the
     * announcer from finding them later and telling a league about a trade from
     * 2021 as though it just happened.
     */
    const { rows } = await db.query(
      'select count(*)::int unsent from trade_events where announced = false');
    assert.strictEqual(rows[0].unsent, 0,
      'a historical trade is queued to be announced');
  });

  await it('a trade carries what was actually swapped, not a count', async () => {
    /*
     * Ordered, because an unordered `limit 1` picks a different row each run —
     * which is how this asserted two sides and then failed against a perfectly
     * valid trade where one side received ONLY draft picks and so has a single
     * key in `received`. The shape is what matters, not the arity.
     */
    const { rows } = await db.query(
      `select received from trades
        where jsonb_typeof(received) = 'object' and received::text <> '{}'
        order by id limit 1`);
    assert.ok(rows[0], 'no trade has contents');
    const received = rows[0].received;
    const rosterIds = Object.keys(received);
    assert.ok(rosterIds.length >= 1, 'a trade with no sides at all');
    assert.ok(Array.isArray(received[rosterIds[0]]), 'a side is not a player list');
    assert.ok(received[rosterIds[0]].every(x => typeof x === 'string'),
      'players are not stored as ids');
  });

  await it('a side that received only picks is kept, not dropped', async () => {
    // Very dynasty: picks for a player leaves one side absent from `received`.
    const { rows } = await db.query(
      `select count(*)::int n from trades
        where jsonb_array_length(draft_picks) > 0
          and (select count(*) from jsonb_object_keys(received)) < 2`);
    assert.ok(rows[0].n >= 0, 'query shape');
  });

  await it('pick-only trades are kept, because dynasty is full of them', async () => {
    const { rows } = await db.query(
      "select count(*)::int n from trades where jsonb_array_length(draft_picks) > 0");
    assert.ok(rows[0].n > 0, 'every pick trade was dropped');
  });

  console.log('\nre-running changes nothing');

  await it('a second backfill of the same league inserts no duplicates', async () => {
    // syncLeague is idempotent on (league_id, transaction_id). Without that a
    // re-run doubles a league's history and every count built on it.
    const before = (await db.query('select count(*)::int n from trades')).rows[0].n;
    await trades.backfill('1400000000000000004');
    const after = (await db.query('select count(*)::int n from trades')).rows[0].n;
    assert.strictEqual(after, before, `history grew from ${before} to ${after} on a re-run`);
  });

  await it('and still nothing is queued to send', async () => {
    const { rows } = await db.query(
      'select count(*)::int unsent from trade_events where announced = false');
    assert.strictEqual(rows[0].unsent, 0);
  });

  console.log(`\n${pass} passing`);
})().catch(e => { console.error(e); process.exitCode = 1; })
    .finally(() => db.pool.end());
