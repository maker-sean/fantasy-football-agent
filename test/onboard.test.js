#!/usr/bin/env node
/**
 * The texted setup link — the thing that replaces the magic-link email.
 *
 * This is an auth surface, so the tests are mostly about what it REFUSES. A
 * link that signs somebody in is the highest-value token this system mints, and
 * the failure that matters is not "it did not work" — it is "it worked for the
 * wrong person".
 */
require('dotenv').config();

// DEV_AUTH short-circuits requireAccount entirely and is on in .env for local
// onboarding. Leaving it set would make every assertion below pass without the
// invite path running at all — the worst kind of green.
//
// Set to 'false' rather than deleted. web/server.js calls dotenv.config() when
// it is required, and dotenv only skips vars that are ALREADY SET — so a
// deleted one gets resurrected straight out of .env and the guard silently
// undoes itself.
process.env.DEV_AUTH = 'false';
process.env.DEV_AUTH_EMAIL = '';
process.env.NODE_ENV = 'test';
process.env.BALLOT_SECRET = process.env.BALLOT_SECRET || 'test-secret-at-least-32-characters-long';

const assert = require('assert');
const onboardlink = require('../src/onboardlink');
const ballotlink = require('../src/ballotlink');

let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

const ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

async function tokenTests() {
  console.log('the token');

  await it('round-trips the signup id and carries an expiry', () => {
    const r = onboardlink.read(onboardlink.mint(ID));
    assert.strictEqual(r.signupId, ID);
    assert.ok(r.expiresAt instanceof Date && r.expiresAt > new Date());
  });

  await it('a tampered signature is rejected', () => {
    const t = onboardlink.mint(ID);
    assert.strictEqual(onboardlink.read(t.slice(0, -2) + (t.endsWith('AA') ? 'BB' : 'AA')), null);
  });

  await it('an edited signup id is rejected — the id is inside the MAC', () => {
    const raw = Buffer.from(onboardlink.mint(ID), 'base64url');
    raw[5] ^= 0xff;
    assert.strictEqual(onboardlink.read(raw.toString('base64url')), null);
  });

  await it('an expired link is reported as expired, not as invalid', () => {
    // The difference is the whole user experience: "ask for a new one" versus
    // "something is broken".
    const r = onboardlink.read(onboardlink.mint(ID, { days: -1 }));
    assert.strictEqual(r.expired, true);
    assert.strictEqual(r.signupId, ID);
  });

  await it('the expiry cannot be extended without breaking the signature', () => {
    const raw = Buffer.from(onboardlink.mint(ID, { days: 1 }), 'base64url');
    raw.writeUInt32BE(raw.readUInt32BE(17) + 86400 * 3650, 17);   // ten more years
    assert.strictEqual(onboardlink.read(raw.toString('base64url')), null);
  });

  await it('a BALLOT token is not accepted as an onboarding token', () => {
    // Both families are signed with the same secret. The type byte and the
    // length are what keep one from being presented to the other.
    assert.strictEqual(onboardlink.read(ballotlink.mint(ID, ID)), null);
  });

  await it('an onboarding token is not accepted as a ballot token', () => {
    assert.strictEqual(ballotlink.read(onboardlink.mint(ID)), null);
  });

  await it('garbage returns null rather than throwing at a stranger', () => {
    for (const junk of ['', 'x', '../../etc/passwd', 'a'.repeat(400), null, undefined])
      assert.strictEqual(onboardlink.read(junk), null, JSON.stringify(junk));
  });

  await it('the link puts the token in the FRAGMENT, never the query string', () => {
    // A query string reaches the server, the access log, and the Referer header
    // of anything the page later loads. A fragment does not.
    const url = onboardlink.linkFor(ID);
    assert.ok(url.includes('/app/#setup='), url);
    assert.ok(!url.includes('?'), 'nothing may be in the query string');
  });
}

async function serverTests() {
  const db = require('../src/db');
  const { app } = require('../web/server');

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, token) => {
    const r = await fetch(base + path, {
      headers: token ? { authorization: 'Bearer ' + token } : {},
    });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };

  const PHONE = '+15550990001';
  const { rows: [signup] } = await db.query(
    `insert into signups (phone, sleeper_league_id, league_name, source)
     values ($1,'1400000000000000001','Onboard Test','sms') returning *`, [PHONE]);

  try {
    console.log('\nexchanging it for an account');

    await it('a valid link signs you in with no email anywhere', async () => {
      const r = await call('/api/me', onboardlink.mint(signup.id));
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.account.email, null, 'no email was invented for them');
      assert.ok(r.body.account.id);
    });

    await it('the account is anchored to the phone that texted in', async () => {
      const acct = await db.accountByPhone(PHONE);
      assert.ok(acct, 'an account exists for that number');
      assert.strictEqual(acct.phone, PHONE);
    });

    await it('opening the link twice lands in the SAME account', async () => {
      // Phone on a laptop and again on a desktop must not produce two
      // half-onboarded accounts with one league each.
      const a = await call('/api/me', onboardlink.mint(signup.id));
      const b = await call('/api/me', onboardlink.mint(signup.id));
      assert.strictEqual(a.body.account.id, b.body.account.id);
    });

    await it('it carries the league they already chose on the site', async () => {
      const r = await call('/api/me', onboardlink.mint(signup.id));
      assert.strictEqual(r.body.invite.sleeperLeagueId, '1400000000000000001');
      assert.strictEqual(r.body.invite.leagueName, 'Onboard Test');
    });

    console.log('\nwhat it refuses');

    await it('an expired link says link_expired, not invalid_token', async () => {
      const r = await call('/api/me', onboardlink.mint(signup.id, { days: -1 }));
      assert.strictEqual(r.status, 401);
      assert.strictEqual(r.body.error, 'link_expired');
    });

    await it('a forged token is refused', async () => {
      const r = await call('/api/me', 'A'.repeat(50));
      assert.strictEqual(r.status, 401);
      assert.notStrictEqual(r.body.error, undefined);
    });

    await it('deleting the signup revokes the link — the row is the authority', async () => {
      const { rows: [tmp] } = await db.query(
        `insert into signups (phone, league_name, source) values ($1,'Doomed','sms') returning *`,
        ['+15550990002']);
      const token = onboardlink.mint(tmp.id);
      assert.strictEqual((await call('/api/me', token)).status, 200, 'works first');
      await db.query('delete from signups where id = $1', [tmp.id]);
      const after = await call('/api/me', token);
      assert.strictEqual(after.status, 401, 'and is dead once the row is gone');
      assert.strictEqual(after.body.error, 'invalid_token');
    });

    await it('no token at all is still a 401', async () => {
      assert.strictEqual((await call('/api/me')).status, 401);
    });

    await it('an invite cannot reach another account\'s league', async () => {
      // The whole tenancy model rests on loadLeague scoping by account, and an
      // invite is just another way to BE an account — it must not widen that.
      const other = await db.upsertAccount({ email: 'onboard-other@example.invalid' });
      const { rows: [lg] } = await db.query(
        `insert into leagues (name, provider, account_id) values ('Not Yours','sendblue',$1) returning *`,
        [other.id]);
      const r = await call(`/api/leagues/${lg.id}/roster`, onboardlink.mint(signup.id));
      assert.strictEqual(r.status, 404, 'a 404, so it cannot even learn the league exists');
      await db.query('delete from accounts where id = $1', [other.id]);
    });

  } finally {
    await db.query('delete from signups where phone in ($1,$2)', [PHONE, '+15550990002']);
    await db.query('delete from accounts where phone in ($1,$2)', [PHONE, '+15550990002']);
    await db.query(`delete from accounts where email like 'onboard-%@example.invalid'`);
    server.close();
    await db.pool.end();
  }
}

(async () => {
  await tokenTests();
  if (!process.env.DATABASE_URL) console.log('\n  SKIPPED the server half — no DATABASE_URL');
  else await serverTests();
  console.log(`\n${pass} passing`);
})();
