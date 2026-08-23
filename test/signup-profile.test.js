#!/usr/bin/env node
/**
 * Who somebody is, captured once, by whichever door they came through.
 *
 * The waitlist recorded a phone, a league and a timestamp — enough to text a
 * setup link and nothing else. src/intake.js closed that for the texted path by
 * asking three questions straight after the confirmation, one per message.
 *
 * It could not close it for the website's email path, because that path never
 * has a conversation: somebody who leaves an address never texts anything, so
 * nothing later ever asks them and the lead stays an address forever. That
 * form asks instead.
 *
 * TWO DOORS, ONE SHAPE. The thing worth pinning is not that each door works —
 * it is that they AGREE. A form splitting on the first space while intake
 * strips "my name is" would file the same person under two different first
 * names depending on how they arrived, and nothing would ever error.
 */
require('dotenv').config();
if (!process.env.DATABASE_URL) {
  console.log('signup profile\n  SKIPPED — no DATABASE_URL\n\n0 passing');
  process.exit(0);
}
process.env.NODE_ENV = 'test';

const assert = require('assert');
const { app } = require('../web/server');
const db = require('../src/db');
const intake = require('../src/intake');
const signup = require('../src/signup');

let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

const MAIL = e => `zz-profile-${e}@example.invalid`;
const clean = async () => {
  await db.query("delete from signups where email like 'zz-profile-%'");
  await db.query("delete from signups where phone like '+1555881900%'");
  await db.query("delete from signup_codes where sleeper_league_id like 'zz-profile-%'");
};
const bySignupEmail = async e => (await db.query(
  'select * from signups where lower(email) = $1', [MAIL(e).toLowerCase()])).rows[0];

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body) => fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

  await clean();

  console.log('the email alternative records the same answers');

  await it('name and platform arrive from the form and are stored', async () => {
    await post('/api/signup-email', { email: MAIL('a'), name: 'Chris Dalton', platform: 'discord' });
    const row = await bySignupEmail('a');
    assert.strictEqual(row.first_name, 'Chris');
    assert.strictEqual(row.last_name, 'Dalton');
    assert.strictEqual(row.platform, 'discord');
    assert.strictEqual(row.source, 'web');
  });

  await it('a sentence typed into the box is stripped the way intake strips it', async () => {
    // People answer a question about their name with a sentence, in a form as
    // readily as in a text. Without the shared parser this files a manager
    // called "My".
    await post('/api/signup-email', { email: MAIL('b'), name: 'my name is Chris Dalton' });
    const row = await bySignupEmail('b');
    const texted = intake.parseName('my name is Chris Dalton');
    assert.strictEqual(row.first_name, texted.first);
    assert.strictEqual(row.last_name, texted.last);
    assert.strictEqual(row.first_name, 'Chris');
  });

  await it('"something else" is kept verbatim, which is the whole point of an other box', async () => {
    await post('/api/signup-email',
      { email: MAIL('c'), name: 'Dana', platform: 'other', platformOther: 'a Slack channel' });
    const row = await bySignupEmail('c');
    assert.strictEqual(row.platform, 'other');
    assert.strictEqual(row.platform_other, 'a Slack channel');
  });

  await it('a platform nobody offered is dropped, not stored raw', async () => {
    // The column is an enum in everything but name, and the waitlist is sorted
    // by it to decide what gets built. One row reading "<script>" or "discrod"
    // makes that sort a guess.
    await post('/api/signup-email', { email: MAIL('d'), platform: 'carrier pigeon' });
    const row = await bySignupEmail('d');
    assert.strictEqual(row.platform, null);
  });

  await it('the free-text box is ignored unless they actually picked other', async () => {
    await post('/api/signup-email',
      { email: MAIL('e'), platform: 'whatsapp', platformOther: 'ignore me' });
    const row = await bySignupEmail('e');
    assert.strictEqual(row.platform, 'whatsapp');
    assert.strictEqual(row.platform_other, null);
  });

  await it('an address with no name is still a lead, not a rejection', async () => {
    // A form that refuses to submit without a name trades a lead for a field,
    // which is why the texted version lets you say "skip".
    const r = await post('/api/signup-email', { email: MAIL('f') });
    assert.strictEqual(r.status, 200);
    const row = await bySignupEmail('f');
    assert.ok(row, 'the signup was refused for want of an optional field');
    assert.strictEqual(row.first_name, null);
  });

  console.log('the code carries what the form collected');

  const codeFor = async (label, profile) => {
    await db.query('delete from signup_codes where sleeper_league_id = $1', ['zz-profile-' + label]);
    return signup.issueCode({
      sleeperLeagueId: 'zz-profile-' + label,
      league: { name: 'ZZ ' + label, season: '2026', total_rosters: 12 },
      profile,
    });
  };
  const redeem = async (phone, code) => {
    await db.query('delete from signups where phone = $1', [phone]);
    await signup.endConversation(phone);
    await signup.handle({ senderId: phone, text: 'COMMISH ' + code },
      { send: async () => {} }, { dryRun: true });
    const { rows: [row] } = await db.query('select * from signups where phone = $1', [phone]);
    return { row, convo: await signup.getConversation(phone) };
  };

  await it('the profile typed on the website arrives on the signup', async () => {
    const c = await codeFor('carry', { firstName: 'Dana', lastName: 'Reyes',
      email: 'zz-profile-carry@example.invalid', platform: 'discord' });
    const { row } = await redeem('+15558819001', c.code);
    assert.strictEqual(row.first_name, 'Dana');
    assert.strictEqual(row.email, 'zz-profile-carry@example.invalid');
    assert.strictEqual(row.platform, 'discord');
  });

  await it('nothing is asked twice when the form already got all three', async () => {
    // Re-asking reads as a system that was not listening, and unlike never
    // asking, the person can see they already answered.
    const c = await codeFor('quiet', { firstName: 'Dana', lastName: 'Reyes',
      email: 'zz-profile-quiet@example.invalid', platform: 'groupme' });
    const { convo } = await redeem('+15558819002', c.code);
    assert.strictEqual(convo?.state ?? null, null, 'started an intake it did not need');
  });

  await it('a half-filled form resumes at the first gap, not the beginning', async () => {
    const c = await codeFor('gap', { firstName: 'Dana', lastName: 'Reyes' });
    const { convo } = await redeem('+15558819003', c.code);
    assert.strictEqual(convo.state, 'intake_email');
  });

  await it('an empty form still asks all three', async () => {
    const c = await codeFor('empty', null);
    const { convo } = await redeem('+15558819004', c.code);
    assert.strictEqual(convo.state, 'intake_name');
  });

  console.log('\nno code without the three answers');

  /*
   * Checked on the server, not only in the browser. The page disables the
   * button; this is what makes it a rule rather than a courtesy, and it is the
   * shape of bug this codebase keeps rediscovering — a second caller that never
   * learned the first caller's rules.
   */
  const LEAGUE = '1400000000000000003';   // a real Sleeper id, so the route gets past its lookup
  const intent = body => post('/api/signup-intent', { sleeperLeagueId: LEAGUE, ...body });

  await it('a bare request for a code is refused', async () => {
    const r = await intent({});
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, 'incomplete_profile');
    assert.deepStrictEqual(r.body.missing, ['firstName', 'email', 'platform']);
  });

  await it('two out of three is still refused, and says which one', async () => {
    const r = await intent({ name: 'Dana Reyes', email: 'zz-profile-gate@example.invalid' });
    assert.strictEqual(r.status, 400);
    assert.deepStrictEqual(r.body.missing, ['platform']);
  });

  await it('picking "something else" without saying where is refused', async () => {
    const r = await intent({ name: 'Dana Reyes', email: 'zz-profile-gate@example.invalid',
      platform: 'other' });
    assert.strictEqual(r.status, 400);
    assert.deepStrictEqual(r.body.missing, ['platformOther']);
  });

  await it('a complete answer gets a code, carrying the profile', async () => {
    const r = await intent({ name: 'Dana Reyes', email: 'zz-profile-gate@example.invalid',
      platform: 'discord' });
    assert.strictEqual(r.status, 200);
    assert.ok(/^[A-Z0-9]{4}$/.test(r.body.code), 'no code came back');
    const { rows: [row] } = await db.query(
      'select * from signup_codes where code = $1', [r.body.code]);
    assert.strictEqual(row.first_name, 'Dana');
    assert.strictEqual(row.email, 'zz-profile-gate@example.invalid');
    assert.strictEqual(row.platform, 'discord');
    await db.query('delete from signup_codes where code = $1', [r.body.code]);
  });

  console.log('\nthe texted door fills the same columns');

  await it('record() carries a profile through for any source', async () => {
    const out = await signup.record({
      email: MAIL('g'), source: 'sms',
      firstName: 'Dana', lastName: 'Reyes', platform: 'groupme',
    });
    assert.strictEqual(out.created, true);
    assert.strictEqual(out.signup.first_name, 'Dana');
    assert.strictEqual(out.signup.platform, 'groupme');
  });

  await it('every platform the form offers is one intake would accept', async () => {
    // The two lists are the same list. If the form ever offers a value intake
    // cannot parse, the same person answers the same question two ways and only
    // one of them counts.
    const offered = ['imessage', 'messenger', 'whatsapp', 'groupme', 'discord', 'other'];
    assert.deepStrictEqual(intake.PLATFORMS.map(([k]) => k), offered);
  });

  await clean();
  console.log(`\n${pass} passing`);
  server.close();
  await db.pool.end();
});
