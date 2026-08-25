#!/usr/bin/env node
/**
 * Who is on a roster, and what we are allowed to call them.
 *
 * Two bugs live here historically. The nightly members:sync wrote the TEAM name
 * into display_name, so a commissioner typed "Marcus" and the bot called him
 * "Big Yardage" by morning. And a roster could only hold one person, so a
 * co-managed team had a second human whose texts the reply gate silently
 * dropped — bound in the dashboard, invisible to the bot.
 */
require('dotenv').config();
if (!process.env.DATABASE_URL) {
  console.log('roster\n  SKIPPED — no DATABASE_URL\n\n0 passing');
  process.exit(0);
}

// Set, never deleted: web/server.js re-runs dotenv.config() when required, and
// dotenv only skips vars that are already set, so a deleted one comes back.
process.env.DEV_AUTH = 'true';
process.env.DEV_AUTH_EMAIL = 'rostertest@example.invalid';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const db = require('../src/db');
const sleeper = require('../src/sleeper');
const { app } = require('../web/server');

let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, {
      method, headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };

  const account = await db.upsertAccount({ email: 'rostertest@example.invalid' });
  /*
   * A DISTINCT sleeper id for the local row.
   *
   * This used to insert the real league's id, which collides with
   * leagues_one_live_per_sleeper_idx the moment that league actually exists —
   * and it has since 2026-08-22. The insert threw before a single assertion
   * ran, and because the runner counts "FAIL" lines a test that dies on its
   * first statement is indistinguishable from one that passes. It reported
   * nothing at all for days.
   *
   * A COMPLETED SEASON's id, not a made-up one. The roster route reads
   * league.sleeper_league_id to fetch labels from Sleeper, so the fixture has
   * to be a league that really exists — a placeholder makes those two tests
   * fail on a 404 instead. A past season is real, fetchable, and its only row
   * here is provider = 'archive', which the live-uniqueness index ignores.
   */
  const FIXTURE_LEAGUE = '1400000000000000002';   // Halcyon Kings, 2025
  await db.query(
    "delete from leagues where sleeper_league_id = $1 and provider <> 'archive'", [FIXTURE_LEAGUE]);
  const { rows: [league] } = await db.query(
    `insert into leagues (name, provider, account_id, sleeper_league_id)
     values ('Roster Test','sendblue',$1,$2) returning *`, [account.id, FIXTURE_LEAGUE]);

  try {
    console.log('three names, three owners');

    await it('rosterOwners keeps the username and the team name apart', async () => {
      const snap = await sleeper.weekSnapshot(FIXTURE_LEAGUE, 1);
      const o = sleeper.rosterOwners(snap).find(x => x.username);
      assert.ok(o.username, 'a username');
      assert.notStrictEqual(o.username, o.teamName, 'and it is not the team name');
    });

    await it('automation may refresh Sleeper labels but NEVER the human name', async () => {
      // The exact bug: members:sync passing the team name as displayName.
      await db.bindMember(league.id, {
        phone: '+15559900001', sleeperUserId: 'u1', sleeperRosterId: 1,
        displayName: 'Marcus', boundVia: 'onboarding', force: true,
      });
      await db.bindMember(league.id, {
        phone: '+15559900001', sleeperUserId: 'u1', sleeperRosterId: 1,
        displayName: 'Big Yardage', username: 'marc99', teamName: 'Big Yardage',
        boundVia: 'legacy', force: true,
      });
      const { rows: [m] } = await db.query(
        'select * from members where league_id=$1 and phone=$2', [league.id, '+15559900001']);
      assert.strictEqual(m.display_name, 'Marcus', 'the human name survived the sync');
      assert.strictEqual(m.team_name, 'Big Yardage', 'the team name landed in its own column');
      assert.strictEqual(m.sleeper_username, 'marc99');
    });

    await it('a person CAN set the human name', async () => {
      await db.bindMember(league.id, {
        phone: '+15559900001', sleeperUserId: 'u1', sleeperRosterId: 1,
        displayName: 'Marc', boundVia: 'onboarding', force: true,
      });
      const { rows: [m] } = await db.query(
        'select display_name from members where league_id=$1 and phone=$2', [league.id, '+15559900001']);
      assert.strictEqual(m.display_name, 'Marc');
    });

    console.log('\na roster can hold more than one person');

    await it('a co-owner is saved alongside the primary', async () => {
      const r = await call('POST', `/api/leagues/${league.id}/members`, { members: [
        { sleeperUserId: 'u2', sleeperRosterId: 2, humanName: 'Marek', phone: '9415550201' },
        { sleeperUserId: null, sleeperRosterId: 2, humanName: 'Sam',  phone: '9415550202' },
      ]});
      assert.strictEqual(r.status, 200);
      const { rows } = await db.query(
        'select * from members where league_id=$1 and sleeper_roster_id=2', [league.id]);
      assert.strictEqual(rows.length, 2, 'both are on roster 2');
      assert.strictEqual(rows.filter(m => m.sleeper_user_id).length, 1, 'exactly one primary');
    });

    await it('the reply gate lets a co-owner speak', async () => {
      // The silent failure this replaces: bound, listed in the dashboard, and
      // ignored by the bot because the gate keyed on sleeper_user_id.
      const bound = await db.boundPhones(league.id);
      assert.ok(bound.has('+19415550202'), 'the co-owner is in the allowlist');
      assert.ok(bound.has('+19415550201'), 'and so is the primary');
    });

    await it('a co-owner without a number is refused, not dropped in silence', async () => {
      const r = await call('POST', `/api/leagues/${league.id}/members`, { members: [
        { sleeperUserId: null, sleeperRosterId: 3, humanName: 'Ghost', phone: null },
      ]});
      assert.strictEqual(r.body.results[0].outcome, 'phone_required');
      const { rows } = await db.query(
        'select * from members where league_id=$1 and sleeper_roster_id=3', [league.id]);
      assert.strictEqual(rows.length, 0, 'nothing was written');
    });

    await it('both owners of a team carry the same Sleeper labels', async () => {
      const { rows } = await db.query(
        'select team_name from members where league_id=$1 and sleeper_roster_id=2', [league.id]);
      assert.strictEqual(new Set(rows.map(r => r.team_name)).size, 1,
        'the label describes the roster, not the person');
    });

    console.log('\nremoving one');

    await it('removedMemberIds deletes a co-owner', async () => {
      const { rows: [co] } = await db.query(
        'select id from members where league_id=$1 and sleeper_roster_id=2 and sleeper_user_id is null',
        [league.id]);
      const r = await call('POST', `/api/leagues/${league.id}/members`,
        { members: [], removedMemberIds: [co.id] });
      assert.strictEqual(r.body.removed, 1);
      const { rows } = await db.query(
        'select * from members where league_id=$1 and sleeper_roster_id=2', [league.id]);
      assert.strictEqual(rows.length, 1, 'the primary is still there');
    });

    await it('it CANNOT delete the primary, even if asked directly', async () => {
      // The payload is client-supplied. A bug in it must not be able to unbind
      // the person Sleeper says owns the roster.
      const { rows: [primary] } = await db.query(
        'select id from members where league_id=$1 and sleeper_roster_id=2', [league.id]);
      const r = await call('POST', `/api/leagues/${league.id}/members`,
        { members: [], removedMemberIds: [primary.id] });
      assert.strictEqual(r.body.removed, 0);
      const { rows } = await db.query('select * from members where id=$1', [primary.id]);
      assert.strictEqual(rows.length, 1, 'still bound');
    });

    await it('it cannot reach into another league', async () => {
      const { rows: [other] } = await db.query(
        `insert into leagues (name, provider) values ('Someone Else','sendblue') returning *`);
      const { rows: [victim] } = await db.query(
        `insert into members (league_id, phone, sleeper_roster_id) values ($1,'+15559900099',9) returning *`,
        [other.id]);
      await call('POST', `/api/leagues/${league.id}/members`,
        { members: [], removedMemberIds: [victim.id] });
      const { rows } = await db.query('select * from members where id=$1', [victim.id]);
      assert.strictEqual(rows.length, 1, 'untouched');
      await db.query('delete from leagues where id=$1', [other.id]);
    });

    console.log('\nwhat the form is told');

    await it('rosters come back grouped, primary first, with both labels', async () => {
      const r = await call('GET', `/api/leagues/${league.id}/roster`);
      assert.strictEqual(r.status, 200);
      const one = r.body.rosters.find(x => x.sleeperRosterId === 1);
      assert.ok(one.username, 'a username');
      assert.ok(one.teamName, 'and a team name');
      assert.ok(Array.isArray(one.owners), 'owners is a list');
      if (one.owners.length > 1) {
        assert.strictEqual(one.owners[0].isPrimary, true, 'primary sorts first');
      }
    });

    await it('a stored number is never echoed back', async () => {
      const r = await call('GET', `/api/leagues/${league.id}/roster`);
      const blob = JSON.stringify(r.body);
      assert.ok(!blob.includes('9415550201'), 'no phone in the payload');
      assert.ok(!blob.includes('+1555990'), 'not in any shape');
      const withPhone = r.body.rosters.flatMap(x => x.owners).find(o => o.hasPhone);
      assert.ok(withPhone, 'but the form is told one exists');
    });

  } catch (e) {
    console.error('ERR', e.message);
    process.exitCode = 1;
  } finally {
    await db.query('delete from leagues where id = $1', [league.id]);
    await db.query(`delete from accounts where email = 'rostertest@example.invalid'`);
    console.log(`\n${pass} passing`);
    server.close();
    await db.pool.end();
  }
});
