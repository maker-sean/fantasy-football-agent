#!/usr/bin/env node
/**
 * What the waiver wire bought, and what it threw away.
 *
 * STARTED points only. A pickup who scored ninety on a bench won nobody
 * anything, and counting bench production would flatter every panic add in the
 * league — the same rule the trade grades follow, for the same reason.
 *
 * NOT EVERY LEAGUE USES FAAB. One of the two live leagues runs fifty claims a
 * season with no bids at all, so anything keyed on money would be dead there.
 */
const assert = require('assert');
if (!process.env.DATABASE_URL) require('dotenv').config();

const wv = require('../src/waivervalue');
const db = require('../src/db');

let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

// Two rosters, three weeks. Player "hit" is started; "benched" is not.
const payload = { games: [
  { w: 1, lineups: { 1: { s: ['hit'], pp: { hit: 10, benched: 99 } }, 2: { s: [], pp: {} } } },
  { w: 2, lineups: { 1: { s: ['hit'], pp: { hit: 20, benched: 99 } }, 2: { s: ['moved'], pp: { moved: 30 } } } },
  { w: 3, lineups: { 1: { s: [], pp: { hit: 5 } }, 2: { s: ['moved'], pp: { moved: 40 } } } },
] };

(async () => {
  console.log('\nreading a season out of the snapshot');

  await it('the index carries starters and points per week', async () => {
    const idx = wv.indexSeason(payload);
    assert.strictEqual(idx.size, 3);
    assert.ok(idx.get(1).get(1).started.has('hit'));
    assert.strictEqual(idx.get(2).get(1).points.hit, 20);
  });

  await it('only STARTED points count, and bench production is ignored', async () => {
    /*
     * The whole discipline. A ninety point week on somebody's bench changed
     * nothing, and counting it would make every panic add look shrewd.
     */
    const idx = wv.indexSeason(payload);
    const got = wv.pointsAfter(idx, 1, 'hit', 0, 3);
    assert.strictEqual(got.points, 30, 'weeks 1 and 2 started; week 3 benched');
    assert.strictEqual(got.started, 2);
    assert.strictEqual(got.held, 3, 'held all three weeks even though started twice');

    const bench = wv.pointsAfter(idx, 1, 'benched', 0, 3);
    assert.strictEqual(bench.points, 0, '99 a week on a bench is worth nothing');
    assert.ok(bench.held > 0, 'but they were still on the roster');
  });

  await it('a dropped player is followed onto whoever picked them up', async () => {
    const idx = wv.indexSeason(payload);
    const gone = wv.pointsAnywhere(idx, 'moved', 1, 3);
    assert.strictEqual(gone.points, 70, 'scored for their new roster after the drop');
    assert.strictEqual(gone.landedOn, 2);
  });

  await it('points before the move are not counted against it', async () => {
    const idx = wv.indexSeason(payload);
    const late = wv.pointsAfter(idx, 1, 'hit', 2, 3);
    assert.strictEqual(late.points, 0, 'picked up in week 2, only week 3 counts, and he sat');
  });

  console.log('\nwhat gets called out');

  const base = { lastWeek: 3, season: '2025' };

  await it('a dollar spent on nothing is not the worst claim in the league', async () => {
    /*
     * Ranked by ratio, a $1 bust is infinitely bad and leads the list. Nobody
     * tells that story. Money burned is the measure.
     */
    const h = wv.highlights({ ...base, faab: true, drops: [], adds: [
      { rosterId: 1, playerId: 'a', bid: 1, week: 1, points: 0, started: 0, held: 1 },
      { rosterId: 2, playerId: 'b', bid: 60, week: 1, points: 2, started: 1, held: 5 },
    ] });
    assert.strictEqual(h.wasted[0].bid, 60, 'the $60 mistake leads, not the $1 one');
    assert.ok(!h.wasted.some(w => w.bid === 1), 'a $1 claim is below the floor entirely');
  });

  await it('best pickups rank on points, so a paid steal is not buried', async () => {
    /*
     * Per-dollar sounds right and hides the story: every free pickup divides by
     * one, so the list came back as five $0 claims and the $30 bid that
     * returned 144 points never appeared.
     */
    const h = wv.highlights({ ...base, faab: true, drops: [], adds: [
      { rosterId: 1, playerId: 'free', bid: 0, week: 1, points: 50, started: 3, held: 3 },
      { rosterId: 2, playerId: 'paid', bid: 30, week: 1, points: 144, started: 9, held: 9 },
    ] });
    assert.strictEqual(h.steals[0].playerId, 'paid', 'the biggest return leads');
  });

  await it('a churned player is one regret, not five', async () => {
    const h = wv.highlights({ ...base, faab: false, adds: [], drops: [
      { rosterId: 1, playerId: 'churn', week: 1, points: 168, started: 9, landedOn: 2 },
      { rosterId: 2, playerId: 'churn', week: 5, points: 129, started: 6, landedOn: 3 },
      { rosterId: 3, playerId: 'churn', week: 8, points: 90, started: 4, landedOn: 1 },
    ] });
    assert.strictEqual(h.regrets.length, 1, 'one entry per player');
    assert.strictEqual(h.regrets[0].points, 168, 'the drop that cost the most');
  });

  await it('dropping and re-adding your own player is not a regret', async () => {
    const h = wv.highlights({ ...base, faab: false, adds: [], drops: [
      { rosterId: 1, playerId: 'x', week: 1, points: 200, started: 9, landedOn: 1 },
    ] });
    assert.strictEqual(h.regrets.length, 0, 'they got the points themselves');
  });

  await it('a league with no FAAB never reports money wasted', async () => {
    const h = wv.highlights({ ...base, faab: false, drops: [], adds: [
      { rosterId: 1, playerId: 'a', bid: 0, week: 1, points: 0, started: 0, held: 6 },
    ] });
    assert.deepStrictEqual(h.wasted, [], 'there is no budget to waste');
    assert.strictEqual(h.faab, false);
  });

  console.log('\ncomputed once, not per question');

  await it('a finished season is stored and then costs no Sleeper calls', async () => {
    const { rows: [lg] } = await db.query(
      `select l.sleeper_league_id, s.season from snapshots s join leagues l on l.id = s.league_id
        where s.kind = 'final' order by s.season desc limit 1`);
    if (!lg) return console.log('       (skip: no completed season captured)');
    await db.query('delete from waiver_analysis where sleeper_league_id = $1 and season = $2',
      [lg.sleeper_league_id, lg.season]);

    let n = 0;
    const fetchTx = wk => { n++; return fetch(
      `https://api.sleeper.app/v1/league/${lg.sleeper_league_id}/transactions/${wk}`)
      .then(r => r.json()); };

    const cold = await wv.cached(lg.sleeper_league_id, { season: lg.season, transactionsFor: fetchTx });
    if (!cold) return console.log('       (skip: nothing to analyse)');
    assert.ok(n > 0, 'the first pass has to ask');

    const warm = await wv.cached(lg.sleeper_league_id, {
      season: lg.season,
      transactionsFor: () => { throw new Error('a stored season must not be refetched'); },
    });
    assert.strictEqual(warm.adds.length, cold.adds.length, 'and it comes back whole');
  });

  console.log(`\n${pass} passing`);
  await db.pool.end();
})();
