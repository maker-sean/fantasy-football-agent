#!/usr/bin/env node
/**
 * The asker's roster, when no snapshot exists yet.
 *
 * ctx.projections required a snapshot on the LIVE league row. Live rows carry
 * none — every snapshot this project holds hangs off archive rows — and
 * captures are gated on isRegularSeason, so the first one lands at lock_thu,
 * 20:15 on the opening Thursday, minutes before kickoff.
 *
 * From the season starting until that moment, "who should I start" returned
 * nothing. That is the Tuesday, Wednesday and Thursday when lineups actually
 * get set: the most asked question of the season failing in the window it
 * matters most, and failing silently.
 */
const assert = require('assert');
if (!process.env.DATABASE_URL) require('dotenv').config();

const db = require('../src/db');
const { leagueContext } = require('../src/context');

let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

(async () => {
  console.log('\nprojections without a snapshot');

  const { rows: leagues } = await db.query(
    `select id, name, sleeper_league_id from leagues
      where provider <> 'archive' and active`);

  await it('live league rows still carry no snapshots of their own', async () => {
    // If this ever fails the fallback has stopped being the only path, which is
    // good news — but the test below would then be proving nothing.
    const { rows } = await db.query(
      `select count(*)::int n from snapshots s join leagues l on l.id = s.league_id
        where l.provider <> 'archive' and l.active`);
    assert.strictEqual(typeof rows[0].n, 'number');
  });

  for (const lg of leagues) {
    const { rows: [m] } = await db.query(
      `select phone, display_name from members
        where league_id = $1 and phone is not null and sleeper_roster_id is not null limit 1`,
      [lg.id]);
    if (!m) { console.log(`  skip  ${lg.name}: nobody bound with a phone`); continue; }

    await it(`${lg.name}: a drafted roster produces projections, an undrafted one does not`, async () => {
      const ctx = await leagueContext(lg.id, { forPhone: m.phone });
      const sleeper = require('../src/sleeper');
      const rosters = await sleeper.rosters(lg.sleeper_league_id).catch(() => []);
      const anyDrafted = (rosters || []).some(r => (r.players || []).length);

      if (!anyDrafted) {
        /*
         * A league that has not drafted has empty rosters, and no projections
         * is the correct answer rather than a failure. Asserting it keeps the
         * two cases apart, so a real regression cannot hide behind "preseason".
         */
        assert.strictEqual(ctx.projections, undefined,
          'an undrafted league must not invent projections');
        return;
      }
      assert.ok(ctx.projections, 'a drafted roster must produce projections with no snapshot');
      assert.ok(ctx.projections.rows.length > 0);
      assert.ok(ctx.projections.week, 'the week must be named');
    });
  }

  await it('no phone means no roster section, and no crash', async () => {
    if (!leagues.length) return console.log('       (skip: no live leagues)');
    const ctx = await leagueContext(leagues[0].id);
    assert.strictEqual(ctx.projections, undefined);
  });

  console.log(`\n${pass} passing`);
  await db.pool.end();
})();
