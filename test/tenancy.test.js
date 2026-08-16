#!/usr/bin/env node
/**
 * Tenant isolation.
 *
 * Unlike the other suites this one needs a real database, because the property
 * under test IS the SQL. It skips cleanly without DATABASE_URL rather than
 * failing, so the pure suites still run anywhere.
 *
 * The failure this guards against is silent: a handler that forgets its scope
 * returns another commissioner's league and looks completely normal doing it.
 */
const assert = require('assert');

if (!process.env.DATABASE_URL) {
  require('dotenv').config();
}
if (!process.env.DATABASE_URL) {
  console.log('tenant isolation\n  SKIPPED — no DATABASE_URL\n\n0 passing');
  process.exit(0);
}

const db = require('../src/db');
let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

const A = 'tenancy-test-a@example.invalid';
const B = 'tenancy-test-b@example.invalid';

(async () => {
  console.log('tenant isolation');

  const a = await db.upsertAccount({ email: A, displayName: 'Tenant A' });
  const b = await db.upsertAccount({ email: B, displayName: 'Tenant B' });

  const mk = async (accountId, name) => (await db.query(
    `insert into leagues (name, account_id, provider, sleeper_league_id, onboarding_state)
     values ($1,$2,'sendblue',$3,'live') returning *`,
    [name, accountId, 'test-' + Math.random().toString(36).slice(2)]
  )).rows[0];

  const la = await mk(a.id, 'A League');
  const lb = await mk(b.id, 'B League');

  await it('an account sees only its own leagues', async () => {
    const names = (await db.leaguesForAccount(a.id)).map(l => l.name);
    assert.deepStrictEqual(names, ['A League']);
  });

  await it('and not the other account\'s', async () => {
    const names = (await db.leaguesForAccount(b.id)).map(l => l.name);
    assert.ok(!names.includes('A League'));
  });

  await it('fetching another account\'s league by id returns nothing', async () => {
    assert.strictEqual(await db.leagueForAccount(b.id, la.id), null);
  });

  await it('fetching your own league by id works', async () => {
    assert.strictEqual((await db.leagueForAccount(a.id, la.id)).name, 'A League');
  });

  await it('a bogus account id cannot reach any league', async () => {
    const nobody = '00000000-0000-0000-0000-000000000000';
    assert.strictEqual(await db.leagueForAccount(nobody, la.id), null);
    assert.deepStrictEqual(await db.leaguesForAccount(nobody), []);
  });

  await it('the worker still sees across tenants, deliberately', async () => {
    const all = (await db.activeLeagues()).map(l => l.name);
    assert.ok(all.includes('A League') && all.includes('B League'),
      'activeLeagues is the worker path and must stay global');
  });

  console.log('\nbilling is per league, not per account');

  await it('two leagues on one account bill separately', async () => {
    const second = await mk(a.id, 'A Second League');
    await db.upsertSubscription({ leagueId: la.id, accountId: a.id, status: 'active' });
    await db.upsertSubscription({ leagueId: second.id, accountId: a.id, status: 'trialing' });
    const rows = await db.leaguesForAccount(a.id);
    const byName = Object.fromEntries(rows.map(r => [r.name, r.subscription_status]));
    assert.strictEqual(byName['A League'], 'active');
    assert.strictEqual(byName['A Second League'], 'trialing',
      'one league lapsing must not affect the other');
  });

  console.log('\nonboarding state machine');

  await it('a new league is not live until the chat is confirmed', async () => {
    const l = await mk(a.id, 'A Onboarding');
    await db.setOnboardingState(l.id, 'awaiting_chat');
    const waiting = (await db.leaguesAwaitingChat()).map(x => x.id);
    assert.ok(waiting.includes(l.id), 'should be parked awaiting proof of the group chat');
    const live = await db.setOnboardingState(l.id, 'live', { chatId: 'grp_x' });
    assert.strictEqual(live.onboarding_state, 'live');
    assert.ok(live.chat_linked_at, 'going live stamps when receipt was confirmed');
    assert.strictEqual(live.chat_id, 'grp_x');
  });

  await it('deleting an account takes its leagues with it', async () => {
    await db.query('delete from accounts where lower(email) = lower($1)', [B]);
    assert.strictEqual(await db.leagueForAccount(b.id, lb.id), null);
  });

  // Cleanup
  await db.query('delete from accounts where lower(email) in (lower($1), lower($2))', [A, B]);

  console.log(`\n${pass} passing`);
  await db.pool.end();
})();
