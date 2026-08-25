#!/usr/bin/env node
/**
 * A member row must be findable again, or it must not exist.
 *
 * bindMember matches on `phone = $2 or sleeper_user_id = $3`. With both null
 * that is two NULL comparisons, never true — so it matched nothing and fell
 * through to an insert. Sleeper genuinely returns UNOWNED rosters, and this
 * league genuinely has one, so members:sync created a fresh nameless row for
 * roster 5 every night: three had accumulated before anybody looked, one per
 * run, and it would have kept going.
 */
require('dotenv').config();
if (!process.env.DATABASE_URL) {
  console.log('member identity\n  SKIPPED — no DATABASE_URL\n\n0 passing');
  process.exit(0);
}
const assert = require('assert');
const db = require('../src/db');

let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

const SID = 'zz-bind-identity';
const count = async id => (await db.query(
  'select count(*)::int n from members where league_id = $1', [id])).rows[0].n;

(async () => {
  await db.query('delete from leagues where sleeper_league_id = $1', [SID]);
  const { rows: [lg] } = await db.query(
    `insert into leagues (name, sleeper_league_id, provider, active)
     values ('ZZ Bind', $1, 'sendblue', true) returning *`, [SID]);

  console.log('an unowned roster');

  await it('a bind with no phone and no sleeper user creates nothing', async () => {
    const before = await count(lg.id);
    const r = await db.bindMember(lg.id, { sleeperRosterId: 5, boundVia: 'sync' });
    assert.strictEqual(r.outcome, 'no_identity');
    assert.strictEqual(r.member, null);
    assert.strictEqual(await count(lg.id), before, 'an unreachable row was inserted');
  });

  await it('running the sync every night still creates nothing', async () => {
    // The actual failure: it was not one bad row, it was one per run forever.
    const before = await count(lg.id);
    for (let day = 0; day < 5; day++) {
      await db.bindMember(lg.id, { sleeperRosterId: 5, boundVia: 'sync' });
    }
    assert.strictEqual(await count(lg.id), before, 'five nights produced rows');
  });

  console.log('\na roster somebody owns');

  await it('a sleeper user with no phone is still a real member', async () => {
    const r = await db.bindMember(lg.id, {
      sleeperUserId: 'zz-user-1', sleeperRosterId: 6, boundVia: 'sync' });
    assert.ok(r.member, 'an owned roster was refused');
    assert.strictEqual(r.member.sleeper_user_id, 'zz-user-1');
  });

  await it('the same owner on the next sync does not duplicate', async () => {
    const before = await count(lg.id);
    await db.bindMember(lg.id, {
      sleeperUserId: 'zz-user-1', sleeperRosterId: 6, boundVia: 'sync' });
    assert.strictEqual(await count(lg.id), before);
  });

  await it('a phone with no sleeper user is still a real member', async () => {
    // How Ivers exists: claimed by text, roster never resolved to a user.
    const r = await db.bindMember(lg.id, {
      phone: '+15558840001', sleeperRosterId: 7, displayName: 'Ivers', boundVia: 'manual' });
    assert.ok(r.member, 'a claimed phone was refused');
  });

  await db.query('delete from leagues where sleeper_league_id = $1', [SID]);
  console.log(`\n${pass} passing`);
})().catch(e => { console.error(e); process.exitCode = 1; })
    .finally(() => db.pool.end());
