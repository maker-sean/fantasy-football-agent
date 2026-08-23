#!/usr/bin/env node
/**
 * A Sleeper league can be onboarded once.
 *
 * The hole was quiet rather than loud. POST /api/leagues checked
 * leaguesForAccount, so the same person re-adding a league resumed correctly
 * and a DIFFERENT person onboarding the same league got a second row. In a
 * twelve person league that is not a rare accident, it is whoever else followed
 * the link. Two live rows means two sets of members, two chat links racing for
 * one thread, and recaps computed twice from the same snapshots, none of which
 * throws.
 */
require('dotenv').config();
if (!process.env.DATABASE_URL) {
  console.log('one-league-once\n  SKIPPED — no DATABASE_URL\n\n0 passing');
  process.exit(0);
}
const assert = require('assert');
const db = require('../src/db');
const signup = require('../src/signup');

let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

const FAKE = '999999999999999901';
const FAKE_PREV = '999999999999999900';

(async () => {
  console.log('the database refuses a second live row');

  await db.query(
    `insert into leagues (name, sleeper_league_id, provider, season, previous_sleeper_league_id, onboarding_state)
     values ('ZZ Test One Once', $1, 'sendblue', '2026', $2, 'live')`, [FAKE, FAKE_PREV]);

  await it('a duplicate insert is rejected by the index, not by luck', async () => {
    let threw = null;
    try {
      await db.query(
        `insert into leagues (name, sleeper_league_id, provider, season, onboarding_state)
         values ('ZZ Test Duplicate', $1, 'sendblue', '2026', 'live')`, [FAKE]);
    } catch (e) { threw = e; }
    assert.ok(threw, 'a second live row for the same Sleeper league was allowed');
    assert.match(String(threw.message), /leagues_one_live_per_sleeper_idx|duplicate key/i);
  });

  await it('an archive row for the same id is still allowed', async () => {
    // history.js writes one per past season and they share the id space by
    // design, so the index has to draw the line at provider, not at the id.
    await db.query(
      `insert into leagues (name, sleeper_league_id, provider, season, active, onboarding_state)
       values ('ZZ Test Archive', $1, 'archive', '2025', false, 'live')`, [FAKE]);
    const { rows } = await db.query(
      `select count(*)::int n from leagues where sleeper_league_id = $1`, [FAKE]);
    assert.strictEqual(rows[0].n, 2, 'the archive row should coexist with the live one');
  });

  console.log('\nand the signup path says so instead of queueing');

  await it('a league already live is reported as claimed', async () => {
    const hit = await signup.alreadyOnboarded(FAKE);
    assert.ok(hit, 'a live league was not detected as onboarded');
    assert.strictEqual(hit.name, 'ZZ Test One Once');
  });

  await it('the PREVIOUS season id resolves to the same league', async () => {
    // Sleeper gives every season its own league_id, so somebody pasting last
    // year's link holds a different id for the same league. Telling them it is
    // unclaimed would be true of the id and wrong about the league.
    const hit = await signup.alreadyOnboarded(FAKE_PREV);
    assert.ok(hit, "last season id did not resolve to the live league");
    assert.strictEqual(hit.name, 'ZZ Test One Once');
  });

  await it('an unrelated league is still free', async () => {
    assert.strictEqual(await signup.alreadyOnboarded('111111111111111111'), null);
  });

  await it('no league id at all is not treated as claimed', async () => {
    assert.strictEqual(await signup.alreadyOnboarded(null), null);
  });

  await db.query(`delete from leagues where sleeper_league_id = $1`, [FAKE]);

  console.log(`\n${pass} passing`);
  await db.pool.end();
})();
