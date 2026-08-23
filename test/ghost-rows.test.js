#!/usr/bin/env node
/**
 * A claim moves a binding. It used to only do half of one.
 *
 * bindMember stripped the Sleeper identity off the old row and inserted a new
 * one, leaving behind a row holding a team name and a username and nothing that
 * identifies anybody. Two of those are in the live league, one each for Sean
 * and Danner, and the introduction counted them as real people: thirteen people
 * were told "3 more rosters" were unaccounted for above a menu offering one.
 *
 * It happens whenever somebody exists as two half rows, which is the normal
 * state before a claim — onboarding writes the phone, the nightly sync writes
 * the id and roster, and the claim brings them together. So every league
 * accumulates one per member who claims that way.
 *
 * The guard is the part worth testing: a row still holding anything must
 * survive, because deleting a row you just emptied is a different act from
 * deleting data.
 */
require('dotenv').config();
if (!process.env.DATABASE_URL) {
  console.log('ghost-rows\n  SKIPPED — no DATABASE_URL\n\n0 passing');
  process.exit(0);
}
const assert = require('assert');
const db = require('../src/db');

let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

const PHONE = '+15558877001';
const USER = 'zz-test-sleeper-user';
let leagueId;

const rows = () => db.query(
  'select phone, sleeper_user_id, sleeper_roster_id, display_name from members where league_id = $1 order by phone nulls last',
  [leagueId]).then(r => r.rows);

(async () => {
  const { rows: [lg] } = await db.query(
    `insert into leagues (name, provider, season, onboarding_state)
     values ('ZZ Ghost Test', 'sendblue', '2026', 'live') returning id`);
  leagueId = lg.id;

  console.log('the split-row case, which is the normal one');

  await it('a claim leaves ONE row, not two', async () => {
    // Onboarding wrote the phone; the nightly sync wrote the id and roster.
    await db.query(
      `insert into members (league_id, phone, display_name) values ($1,$2,'Danner')`, [leagueId, PHONE]);
    await db.query(
      `insert into members (league_id, sleeper_user_id, sleeper_roster_id, display_name, team_name, sleeper_username)
       values ($1,$2,1,'Danner','Tank for Tyler','gowreckers42')`, [leagueId, USER]);
    assert.strictEqual((await rows()).length, 2, 'setup');

    await db.bindMember(leagueId, {
      phone: PHONE, sleeperUserId: USER, sleeperRosterId: 1,
      displayName: 'Danner', teamName: 'Tank for Tyler', username: 'gowreckers42',
      boundVia: 'chat', force: true,
    });

    const after = await rows();
    assert.strictEqual(after.length, 1, `left ${after.length} rows: ${JSON.stringify(after)}`);
  });

  await it('the surviving row carries all three identifiers', async () => {
    const [only] = await rows();
    assert.strictEqual(only.phone, PHONE);
    assert.strictEqual(only.sleeper_user_id, USER);
    assert.strictEqual(only.sleeper_roster_id, 1);
  });

  console.log('\nand it only removes what it emptied');

  await it('a row still holding a phone is never deleted', async () => {
    // Somebody else's row that happens to hold the same Sleeper id: stripping
    // it is one thing, deleting a row with a live phone on it is another.
    const OTHER = '+15558877002';
    await db.query('delete from members where league_id = $1', [leagueId]);
    await db.query(
      `insert into members (league_id, phone, sleeper_user_id, sleeper_roster_id, display_name)
       values ($1,$2,$3,4,'Someone Else')`, [leagueId, OTHER, USER]);

    await db.bindMember(leagueId, {
      phone: PHONE, sleeperUserId: USER, sleeperRosterId: 4,
      displayName: 'Danner', boundVia: 'chat', force: true,
    });

    const after = await rows();
    const kept = after.find(r => r.phone === OTHER);
    assert.ok(kept, 'a row with a live phone was deleted');
    assert.strictEqual(kept.sleeper_user_id, null, 'the identity should still have moved off it');
  });

  await db.query('delete from members where league_id = $1', [leagueId]);
  await db.query('delete from leagues where id = $1', [leagueId]);
  console.log(`\n${pass} passing`);
  await db.pool.end();
})();
