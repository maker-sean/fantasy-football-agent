#!/usr/bin/env node
/**
 * Sending somebody their setup link.
 *
 * Three paths now decide to invite — the script, a text reply, and a dashboard
 * button — and today the welcome, the mute and the operator alert each broke
 * because a second path skipped the first path's rules. So the rules live in
 * one module and these pin them there.
 *
 * The case Sean asked about is the one that matters: two signups landing close
 * together makes a bare INVITE ambiguous, and inviting the wrong league is not
 * recoverable, because the link signs whoever holds it into an account.
 */
require('dotenv').config();
if (!process.env.DATABASE_URL) {
  console.log('invites\n  SKIPPED — no DATABASE_URL\n\n0 passing');
  process.exit(0);
}
const assert = require('assert');
const db = require('../src/db');
const invites = require('../src/invites');

let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

const A = '+15558801111';
const B = '+15558802222';
const C = '+15559991111';   // shares A's last four, on purpose

/*
 * invites.send() is gated on a passing onboarding pre-flight, so anything here
 * that expects a send to happen has to say the check passed. Stamped directly
 * rather than run: these tests are about the localhost refusal and the
 * invited_at bookkeeping, and a real run walks the Sleeper chain and spends
 * seven model calls. The gate itself is pinned in preflight.test.js.
 */
async function preflightPassed(signupId) {
  await db.query('delete from preflight_runs where signup_id = $1', [signupId]);
  await db.query(
    `insert into preflight_runs (signup_id, status, seasons_found, seasons_captured,
                                 context_chars, finished_at)
     values ($1, 'passed', 6, 6, 4200, now())`, [signupId]);
}

(async () => {
  await db.query('delete from signups where phone = any($1)', [[A, B, C]]);
  await db.query(
    `insert into signups (phone, sleeper_league_id, league_name, total_rosters, source, status)
     values ($1,'901','ZZ Alpha',12,'sms','new')`, [A]);

  console.log('resolving which one');

  // Supplied rather than queried: real signups live in this database and a
  // fixture competing with them makes "exactly one is waiting" untrue for
  // reasons that have nothing to do with the code.
  const one = [{ id: 'a', phone: A, league_name: 'ZZ Alpha', ref: '1111' }];
  const two = [...one, { id: 'b', phone: B, league_name: 'ZZ Beta', ref: '2222' }];

  await it('a bare invite works when exactly one is waiting', async () => {
    const r = await invites.resolve(null, { waiting: one });
    assert.ok(r.signup, r.error);
    assert.strictEqual(r.signup.league_name, 'ZZ Alpha');
  });

  await it('the ref is the last four of their number', async () => {
    const [only] = (await invites.pending()).filter(s => s.league_name === 'ZZ Alpha');
    assert.strictEqual(only.ref, '1111');
  });

  await db.query(
    `insert into signups (phone, sleeper_league_id, league_name, total_rosters, source, status)
     values ($1,'902','ZZ Beta',10,'sms','new')`, [B]);

  await it('a bare invite is REFUSED once two are waiting, not guessed', async () => {
    // The whole question: reply INVITE with two pending and it must not pick.
    const r = await invites.resolve(null, { waiting: two });
    assert.strictEqual(r.signup, undefined);
    assert.strictEqual(r.error, 'ambiguous');
    assert.ok(r.waiting.length >= 2);
  });

  await it('the ref disambiguates', async () => {
    const r = await invites.resolve('2222', { waiting: two });
    assert.ok(r.signup, r.error);
    assert.strictEqual(r.signup.league_name, 'ZZ Beta');
  });

  await it('a ref matching nothing fails loudly', async () => {
    assert.strictEqual((await invites.resolve('4321', { waiting: two })).error, 'no_match');
  });

  await it('two pending numbers ending the same way fail rather than pick one', async () => {
    const clash = [...one, { id: 'c', phone: C, league_name: 'ZZ Clash', ref: '1111' }];
    assert.strictEqual((await invites.resolve('1111', { waiting: clash })).error, 'ambiguous');
  });

  await it('an already invited signup drops out of pending', async () => {
    await db.query(`update signups set status='invited' where phone=$1`, [B]);
    const refs = (await invites.pending()).map(s => s.ref);
    assert.ok(!refs.includes('2222'), 'an invited league was still offered');
  });

  console.log('\nsending');

  await it('a localhost base url is refused rather than texted', async () => {
    // By the time anybody notices, it is already on somebody's phone.
    const prev = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = 'http://localhost:3000';
    try {
      const { rows: [s] } = await db.query('select id from signups where phone=$1', [A]);
      const out = await invites.send(s.id, { provider: { send: async () => {} } });
      assert.strictEqual(out.sent, false);
      assert.strictEqual(out.error, 'localhost_base_url');
    } finally {
      if (prev === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = prev;
    }
  });

  await it('a successful send stamps invited_at, not just status', async () => {
    const prev = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = 'https://example.invalid';
    try {
      const { rows: [s] } = await db.query('select id from signups where phone=$1', [A]);
      await preflightPassed(s.id);
      const out = await invites.send(s.id, { provider: { send: async () => {} } });
      assert.strictEqual(out.sent, true, out.error);
      const { rows: [after] } = await db.query(
        'select status, invited_at from signups where id=$1', [s.id]);
      assert.strictEqual(after.status, 'invited');
      assert.ok(after.invited_at, 'invited_at is still null, the funnel stage will freeze');
    } finally {
      if (prev === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = prev;
    }
  });

  await it('a failed send does NOT mark them invited', async () => {
    const prev = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = 'https://example.invalid';
    await db.query(`update signups set status='new', invited_at=null where phone=$1`, [B]);
    try {
      const { rows: [s] } = await db.query('select id from signups where phone=$1', [B]);
      await preflightPassed(s.id);
      const out = await invites.send(s.id, {
        provider: { send: async () => { throw new Error('sendblue down'); } } });
      assert.strictEqual(out.sent, false);
      const { rows: [after] } = await db.query('select status from signups where id=$1', [s.id]);
      assert.strictEqual(after.status, 'new', 'marked invited on a send that never landed');
    } finally {
      if (prev === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = prev;
    }
  });

  await db.query('delete from signups where phone = any($1)', [[A, B]]);
  console.log(`\n${pass} passing`);
  await db.pool.end();
})();
