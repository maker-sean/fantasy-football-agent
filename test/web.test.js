#!/usr/bin/env node
/**
 * The commissioner web app, end to end against a real database.
 *
 * Walks the whole onboarding flow the way a commissioner does, because the
 * things worth testing here are sequencing and scope — that a league cannot go
 * live before its chat is confirmed, that another account cannot reach it, and
 * that a typed phone number never comes back out.
 */
require('dotenv').config();
if (!process.env.DATABASE_URL) {
  console.log('web app\n  SKIPPED — no DATABASE_URL\n\n0 passing');
  process.exit(0);
}

process.env.DEV_AUTH = 'true';
process.env.DEV_AUTH_EMAIL = 'webtest@example.invalid';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const { app } = require('../web/server');
const db = require('../src/db');
const chatlink = require('../src/chatlink');

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

  try {
    console.log('health and account bootstrap');

    await it('health reports a live database', async () => {
      const r = await call('GET', '/health');
      assert.strictEqual(r.status, 200);
      assert.ok(r.body.db);
    });

    await it('first request creates the account', async () => {
      const r = await call('GET', '/api/me');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.account.email, 'webtest@example.invalid');
      assert.strictEqual(r.body.account.needsTerms, true, 'a new account has not accepted terms');
    });

    await it('accepting terms records the version, not just a boolean', async () => {
      await call('POST', '/api/me/terms');
      const r = await call('GET', '/api/me');
      assert.strictEqual(r.body.account.needsTerms, false);
      assert.ok(r.body.account.termsVersion, 'which terms they accepted is recorded');
    });

    console.log('\nstep 4 — find and link a Sleeper league');

    await it('a real username returns real leagues', async () => {
      const r = await call('GET', '/api/sleeper/leagues?username=smeadows');
      assert.strictEqual(r.status, 200);
      assert.ok(r.body.leagues.length > 0, 'found ' + r.body.leagues.length);
    });

    await it('an unknown username 404s rather than hanging', async () => {
      const r = await call('GET', '/api/sleeper/leagues?username=definitelynotarealuser99xyz');
      assert.strictEqual(r.status, 404);
    });

    await it('a malformed league id is rejected before hitting Sleeper', async () => {
      assert.strictEqual((await call('POST', '/api/leagues', { sleeperLeagueId: 'abc' })).status, 400);
    });

    /*
     * A league nobody has onboarded.
     *
     * This used the live Halcyon Kings id, and passed only because the
     * endpoint was scoped to the account: every run quietly inserted a SECOND
     * live row for a league that already had one. The test was demonstrating
     * the duplicate bug rather than guarding against it. This id is real in
     * Sleeper and exists here only as an archive row, which the unique index
     * deliberately does not count.
     */
    const UNCLAIMED = '600000000000000001';

    let leagueId;
    await it('linking a league puts it in league_linked, not live', async () => {
      const r = await call('POST', '/api/leagues', { sleeperLeagueId: UNCLAIMED });
      assert.strictEqual(r.status, 201);
      assert.strictEqual(r.body.league.onboarding_state, 'league_linked');
      leagueId = r.body.league.id;
    });

    await it('linking the same league twice resumes instead of duplicating', async () => {
      const r = await call('POST', '/api/leagues', { sleeperLeagueId: UNCLAIMED });
      assert.strictEqual(r.body.resumed, true);
      assert.strictEqual(r.body.league.id, leagueId);
    });

    await it('a league somebody else already onboarded is refused, not duplicated', async () => {
      // The live league belongs to a different account. Twelve people can text
      // the code; the eleven who are not the commissioner must not each get
      // their own copy of it.
      const r = await call('POST', '/api/leagues', { sleeperLeagueId: '1400000000000000001' });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.body.error, 'league_already_onboarded');
      assert.ok(r.body.message, 'no message for the UI to show');
    });

    console.log('\nstep 5 — name and number per roster');

    let rosters;
    await it('rosters come back with team names from Sleeper', async () => {
      const r = await call('GET', `/api/leagues/${leagueId}/roster`);
      rosters = r.body.rosters;
      assert.ok(rosters.length >= 2, rosters.length + ' rosters');
      // Each roster now carries an owners LIST — a team can be co-managed, and
      // the second person on it has no Sleeper account to key on.
      assert.ok(rosters.every(x => Array.isArray(x.owners)), 'owners is a list');
      assert.ok(rosters.every(x => 'username' in x && 'teamName' in x),
        'the username and the team name are separate facts');
    });

    await it('binding two members advances the state', async () => {
      const members = rosters.slice(0, 2).map((x, i) => ({
        sleeperUserId: x.sleeperUserId, sleeperRosterId: x.sleeperRosterId,
        humanName: ['Dave', 'Mike'][i], phone: ['555-010-1111', '5550102222'][i],
      }));
      const r = await call('POST', `/api/leagues/${leagueId}/members`, { members });
      assert.strictEqual(r.status, 200);
      const after = await call('GET', `/api/leagues/${leagueId}/roster`);
      const withPhone = after.body.rosters.filter(x => x.owners.some(o => o.hasPhone));
      assert.strictEqual(withPhone.length, 2);
      assert.strictEqual(after.body.league.state, 'members_bound');
    });

    await it('a malformed phone is reported, not stored', async () => {
      const r = await call('POST', `/api/leagues/${leagueId}/members`,
        { members: [{ sleeperUserId: rosters[2].sleeperUserId, phone: '12' }] });
      assert.strictEqual(r.body.results[0].outcome, 'bad_phone');
    });

    await it('a stored phone number is never echoed back to the browser', async () => {
      const r = await call('GET', `/api/leagues/${leagueId}/roster`);
      assert.ok(!JSON.stringify(r.body).includes('5550101111'),
        'the roster response must not contain the number the commissioner typed');
    });

    console.log('\nstep 6 — the screen holds until the chat is confirmed');

    await it('await-chat parks the league and returns the number to add', async () => {
      const r = await call('POST', `/api/leagues/${leagueId}/await-chat`);
      assert.strictEqual(r.body.state, 'awaiting_chat');
    });

    await it('it is NOT live just because the commissioner said so', async () => {
      const r = await call('GET', `/api/leagues/${leagueId}/chat-status`);
      assert.strictEqual(r.body.live, false);
    });

    await it('a message from a bound member confirms it and flips it live', async () => {
      const linked = await chatlink.tryLink({ chatId: 'grp_onboard_test', senderId: '+15550101111', isGroup: true });
      assert.ok(linked, 'chatlink should match the pending league');
      const r = await call('GET', `/api/leagues/${leagueId}/chat-status`);
      assert.strictEqual(r.body.live, true);
      assert.ok(r.body.chatLinkedAt, 'records when receipt was confirmed');
    });

    await it('a message from an unrelated number confirms nothing', async () => {
      await db.setOnboardingState(leagueId, 'awaiting_chat');
      const linked = await chatlink.tryLink({ chatId: 'grp_stranger', senderId: '+19998887777', isGroup: true });
      assert.strictEqual(linked, null);
      assert.strictEqual((await call('GET', `/api/leagues/${leagueId}/chat-status`)).body.live, false);
    });

    await it('await-chat cannot drag a live league back to waiting', async () => {
      await chatlink.tryLink({ chatId: 'grp_regress_test', senderId: '+15550101111', isGroup: true });
      assert.strictEqual((await call('GET', `/api/leagues/${leagueId}/chat-status`)).body.live, true);
      // A stale tab re-rendering the waiting screen must not un-confirm it.
      await call('POST', `/api/leagues/${leagueId}/await-chat`);
      assert.strictEqual((await call('GET', `/api/leagues/${leagueId}/chat-status`)).body.live, true);
    });

    console.log('\ndashboard config is an allowlist');

    await it('known keys apply', async () => {
      const r = await call('PATCH', `/api/leagues/${leagueId}/config`, { config: { spice: 2, botNames: ['jarvis'] } });
      assert.deepStrictEqual(r.body.applied.sort(), ['botNames', 'spice']);
    });

    await it('unknown keys are dropped — config drives the safety rails', async () => {
      const r = await call('PATCH', `/api/leagues/${leagueId}/config`,
        { config: { evilBackdoor: true, maxBotStreak: 999, maxPerDayAddressed: 9999 } });
      assert.deepStrictEqual(r.body.applied, []);
      const { rows } = await db.query('select config from leagues where id = $1', [leagueId]);
      assert.ok(!('maxBotStreak' in rows[0].config), 'the runaway guard must not be settable from a browser');
    });

    console.log('\ntenancy holds through the HTTP layer');

    await it('another account gets 404, not 403 — it cannot even learn the id exists', async () => {
      const other = await db.upsertAccount({ email: 'webtest-other@example.invalid' });
      assert.strictEqual(await db.leagueForAccount(other.id, leagueId), null);
    });

    await it('an unknown league id is a 404', async () => {
      assert.strictEqual((await call('GET', '/api/leagues/00000000-0000-0000-0000-000000000000/roster')).status, 404);
    });

    // The league created above is owned by the test account; drop it explicitly
    // so a failed run cannot leave a live row holding a real Sleeper id.
    await db.query(
      `delete from leagues where sleeper_league_id = $1 and provider <> 'archive'`,
      ['600000000000000001']);
    await db.query('delete from accounts where email like $1', ['webtest%@example.invalid']);
    console.log(`\n${pass} passing`);
  } catch (e) {
    console.error('ERR', e.message);
    process.exitCode = 1;
  } finally {
    server.close();
    await db.pool.end();
  }
});
