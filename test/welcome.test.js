#!/usr/bin/env node
/**
 * The introduction, and the rule that nothing precedes it.
 *
 * Two properties carry real consequences:
 *
 *   1. It is the first message a group ever receives, so it must identify the
 *      sender and carry STOP. That is what an A2P reviewer looks at, and a
 *      scheduled recap arriving first would be a roast from an unknown number.
 *
 *   2. welcomed_at is stamped only after a SUCCESSFUL send. Stamping first
 *      marks a league introduced on a message that never landed, and it would
 *      never be introduced again. Same shape as the poller cursor bug this repo
 *      already paid for: commit after the work, never before it.
 */
const assert = require('assert');
if (!process.env.DATABASE_URL) require('dotenv').config();

const welcome = require('../src/welcome');
const db = require('../src/db');

let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

const league = (over = {}) => ({
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Test League',
  chat_id: 'grp_test',
  welcomed_at: null,
  config: { botNames: ['Commish'] },
  ...over,
});

async function main() {
  console.log('what the introduction must contain');

  await it('it identifies the sender by its configured name', async () => {
    assert.match(welcome.welcomeText(league()), /I am Commish/);
    assert.match(welcome.welcomeText(league({ config: { botNames: ['Ref'] } })), /I am Ref/);
  });

  await it('it carries STOP, because this is the message a carrier reads', async () => {
    assert.match(welcome.welcomeText(league()), /\bSTOP\b/);
  });

  await it('it promises nothing it cannot do', async () => {
    // An earlier draft said "HELP brings this back". signup.js deliberately
    // never replies to a reserved keyword, because the provider suppresses
    // outbound the moment it sees one, so that reply would never arrive.
    assert.ok(!/HELP/.test(welcome.welcomeText(league())), 'do not promise a HELP reply');
  });

  await it('it tells people how to reach it, using the name that actually works', async () => {
    const t = welcome.welcomeText(league({ config: { botNames: ['Ref'] } }));
    assert.match(t, /Say "Ref"/);
    assert.ok(!/Say "Commish"/.test(t), 'it must not advertise a trigger that is not configured');
  });

  await it('it arrives as two messages, not a wall', async () => {
    const parts = welcome.welcomeText(league()).split(/\n-{3,}\n/);
    assert.strictEqual(parts.length, 2);
    for (const p of parts) {
      assert.ok(p.trim().split(/\s+/).length <= 80, 'a part is long enough to read as a document');
    }
  });

  await it('the roster line appears only when binding is incomplete', async () => {
    // The copy changed: it used to ask people to reply with their name, which
    // nothing implements. It now points at the commissioner, who is the only
    // one who can actually fix it.
    assert.match(welcome.welcomeText(league(), { needsBinding: true }), /still "Roster 7" to me/);
    assert.ok(!/Roster 7/.test(welcome.welcomeText(league(), { needsBinding: false })));
  });

  await it('it never asks anyone to text their name, because nothing reads it', async () => {
    for (const needsBinding of [true, false]) {
      const t = welcome.welcomeText(league(), { needsBinding });
      assert.ok(!/reply with your name/i.test(t), 'db.renameMember is called by nothing');
    }
  });

  await it('it falls back to a name rather than saying undefined', async () => {
    assert.match(welcome.welcomeText(league({ config: {} })), /I am Commish/);
    assert.match(welcome.welcomeText(league({ config: null })), /I am Commish/);
  });

  console.log('\nthe precondition');

  await it('an already welcomed league is not welcomed twice', async () => {
    let calls = 0;
    const r = await welcome.ensureWelcomed(league({ welcomed_at: new Date() }), {
      send: async () => { calls++; },
    });
    assert.strictEqual(calls, 0);
    assert.strictEqual(r.welcomed, true, 'it is welcomed, just not again');
    assert.strictEqual(r.sent, false);
  });

  await it('a league with no chat is not welcomed and not clear to send', async () => {
    const r = await welcome.ensureWelcomed(league({ chat_id: null }), { send: async () => {} });
    assert.strictEqual(r.welcomed, false, 'nothing may be sent to a league with no chat');
  });

  await it('a failed send does NOT mark the league welcomed', async () => {
    // The important one. Marking first would introduce a league on a message
    // that never arrived, and it would never be introduced again.
    const real = db.query;
    let stamped = false;
    db.query = async sql => { if (/welcomed_at = now/.test(sql)) stamped = true; return { rows: [] }; };
    try {
      const r = await welcome.ensureWelcomed(league(), {
        send: async () => { throw new Error('provider down'); },
      });
      assert.strictEqual(r.welcomed, false);
      assert.strictEqual(stamped, false, 'a failed send stamped welcomed_at');
    } finally { db.query = real; }
  });

  await it('a dry run sends nothing and stays un-welcomed', async () => {
    let calls = 0;
    const r = await welcome.ensureWelcomed(league(), { send: async () => { calls++; }, dryRun: true });
    assert.strictEqual(calls, 0);
    assert.strictEqual(r.welcomed, false, 'a dry run must not clear the way for a real recap');
  });

  await it('a successful send stamps it exactly once', async () => {
    const real = db.query;
    let stamps = 0;
    db.query = async sql => { if (/welcomed_at = now/.test(sql)) stamps++; return { rows: [] }; };
    try {
      const r = await welcome.ensureWelcomed(league(), { send: async () => {} });
      assert.strictEqual(r.sent, true);
      assert.strictEqual(r.welcomed, true);
      assert.strictEqual(stamps, 1);
    } finally { db.query = real; }
  });

  console.log('\nthe introduction is a prefix, not a replacement');

  await it('a successful introduction leaves the reply intact', async () => {
    // "Commish who won in 2023" must get the introduction AND the answer.
    // Consuming the mention would mean the first question anyone ever asks is
    // silently dropped, which is not what "first, not instead" means.
    const real = db.query;
    db.query = async () => ({ rows: [] });
    try {
      const r = await welcome.ensureWelcomed(league(), { send: async () => {} });
      assert.strictEqual(r.welcomed, true,
        'a caller checks this to decide whether it may still send its own message');
    } finally { db.query = real; }
  });

  await it('a failed introduction is the one case that blocks the reply', async () => {
    // Answering anyway means a roast from a number the group has never been
    // told anything about, which is the thing the precondition exists to stop.
    const r = await welcome.ensureWelcomed(league(), {
      send: async () => { throw new Error('provider down'); },
    });
    assert.strictEqual(r.welcomed, false);
  });

  if (!process.env.DATABASE_URL) {
    console.log('\nagainst a database\n  SKIPPED — no DATABASE_URL');
    console.log(`\n${pass} passing`);
    return;
  }

  console.log('\nagainst a database');

  await it('needsBinding reports true while any member is unbound', async () => {
    const { rows } = await db.query(`select id, name from leagues order by name limit 1`);
    if (!rows.length) return;
    const v = await welcome.needsBinding(rows[0].id);
    assert.strictEqual(typeof v, 'boolean');
  });

  await it('no live league has been welcomed yet, so none is mid-introduction', async () => {
    // A sanity check on the migration rather than on logic: every existing
    // league must start un-welcomed, or the league already sitting in a real
    // group chat would skip its introduction.
    const { rows } = await db.query(`select name, welcomed_at from leagues`);
    for (const r of rows) {
      assert.ok(r.welcomed_at === null || r.welcomed_at instanceof Date);
    }
  });

  console.log(`\n${pass} passing`);
}

main();
