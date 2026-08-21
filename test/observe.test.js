#!/usr/bin/env node
/**
 * Operator views and the control plane.
 *
 * Two properties matter more than the rest, and both are silent when broken:
 *
 *   1. A cross-tenant read has to be ASKED FOR. observe.scoped() is the single
 *      place that decides, and the dangerous failure is a scope that is present
 *      but ignored, which returns every league and looks normal doing it.
 *
 *   2. The kill switch fails to PAUSED. A database it cannot read must never
 *      un-pause a bot an operator deliberately stopped.
 *
 * Everything runs sequentially. It did not at first, and the bug was
 * instructive: the kill-switch cases stub db.query to throw, and with the SQL
 * cases racing them the stub leaked and failed six unrelated assertions.
 * Concurrency in a file that monkey-patches a shared module is a flake
 * generator, not a speed-up.
 */
const assert = require('assert');

// Before src/db is required, not after: db reads DATABASE_URL when it builds
// its pool, so a late dotenv load leaves every SQL case failing on a database
// that is in fact configured.
if (!process.env.DATABASE_URL) require('dotenv').config();

const observe = require('../src/observe');
const flags = require('../src/flags');
const db = require('../src/db');

let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

/** Run fn with db.query stubbed, always restoring it. */
async function withQuery(stub, fn) {
  const real = db.query;
  const prevEnv = process.env.REPLY_DRY_RUN;
  delete process.env.REPLY_DRY_RUN;
  db.query = stub;
  flags._resetCache();
  try { await fn(); }
  finally {
    db.query = real;
    if (prevEnv !== undefined) process.env.REPLY_DRY_RUN = prevEnv;
    flags._resetCache();
  }
}

async function main() {
  console.log('scope is asked for, never defaulted into');

  await it('null scope reads every league, and says so in the SQL', () => {
    const s = observe.scoped(null);
    assert.strictEqual(s.sql, 'true');
    assert.deepStrictEqual(s.params, []);
  });

  await it('undefined scope behaves as null rather than as an empty list', () => {
    // An empty array would silently return NOTHING, which reads as "the system
    // is idle" instead of "you forgot an argument". Unscoped is the loud one.
    assert.strictEqual(observe.scoped(undefined).sql, 'true');
  });

  await it('an array scope produces a real predicate bound to a parameter', () => {
    const s = observe.scoped(['a-uuid'], 'league_id', 3);
    assert.match(s.sql, /league_id = any\(\$3::uuid\[\]\)/);
    assert.deepStrictEqual(s.params, [['a-uuid']]);
  });

  await it('a bare string is rejected instead of being coerced', () => {
    // The bug this stops: scoped('some-uuid') silently becoming a cross-tenant
    // read because a string is truthy. It must throw, not widen.
    assert.throws(() => observe.scoped('some-uuid'), /array of league ids or null/);
  });

  await it('the predicate honours the column it is given', () => {
    assert.match(observe.scoped(['x'], 'o.league_id', 2).sql, /o\.league_id/);
  });

  await it('thread refuses to run without a league', async () => {
    // Every other view can legitimately be unscoped. A thread cannot: an
    // "all leagues" thread is a merged conversation belonging to nobody.
    await assert.rejects(() => observe.thread({}), /requires a leagueId/);
  });

  console.log('\nthe kill switch fails safe');

  await it('REPLY_DRY_RUN beats the database', async () => {
    const prev = process.env.REPLY_DRY_RUN;
    process.env.REPLY_DRY_RUN = 'true';
    flags._resetCache();
    try { assert.strictEqual(await flags.repliesPaused(), true); }
    finally {
      if (prev === undefined) delete process.env.REPLY_DRY_RUN; else process.env.REPLY_DRY_RUN = prev;
      flags._resetCache();
    }
  });

  await it('an unreadable database pauses rather than resumes', async () => {
    await withQuery(async () => { throw new Error('connection refused'); }, async () => {
      assert.strictEqual(await flags.repliesPaused(), true, 'must fail closed');
    });
  });

  await it('a later outage holds the last known value instead of flipping', async () => {
    await withQuery(async () => ({ rows: [{ value: false }] }), async () => {
      assert.strictEqual(await flags.repliesPaused(), false);
      db.query = async () => { throw new Error('gone'); };
      // inside the cache TTL, so this reads the cache, not the failure
      assert.strictEqual(await flags.repliesPaused(), false);
    });
  });

  await it('the cache cannot outlive two polls', () => {
    // Tied to the ten second poll interval: a longer TTL would make a pause
    // take longer to bite than an operator would ever expect.
    assert.ok(flags.TTL_MS <= 10000, `TTL ${flags.TTL_MS}ms is longer than a poll`);
  });

  if (!process.env.DATABASE_URL) {
    console.log('\nread models against a database\n  SKIPPED — no DATABASE_URL');
    console.log(`\n${pass} passing`);
    return;
  }

  console.log('\nread models against a database');

  await it('replyRate answers with a rate, or null when there is nothing to rate', async () => {
    const r = await observe.replyRate({ days: 3650 });
    assert.ok(Number.isInteger(r.bot_messages), 'bot_messages must be an integer');
    assert.ok(r.answered <= r.bot_messages, 'cannot answer more messages than were sent');
    assert.ok(r.rate === null || (r.rate >= 0 && r.rate <= 1));
  });

  await it('an empty scope returns nothing rather than everything', async () => {
    // The inverse guard, against real SQL: a scope matching no league must not
    // fall through to unscoped.
    assert.strictEqual((await observe.replyRate({ scope: [], days: 3650 })).bot_messages, 0);
  });

  await it('decisionBreakdown groups by layer, verdict and reason', async () => {
    for (const r of await observe.decisionBreakdown({ days: 3650 })) {
      assert.ok(typeof r.layer === 'string');
      assert.ok(['reply', 'silent'].includes(r.decision));
      assert.ok(Number.isInteger(r.n) && r.n > 0);
    }
  });

  await it('leagueList reports binding as a fraction, never over one', async () => {
    for (const l of await observe.leagueList()) {
      assert.ok(l.bound_members <= l.total_members,
        `${l.name}: ${l.bound_members} bound of ${l.total_members}`);
    }
  });

  await it('thread returns messages oldest first so a conversation reads down', async () => {
    const withMsgs = (await observe.leagueList()).find(l => l.messages > 1);
    if (!withMsgs) return;
    const { messages } = await observe.thread({ leagueId: withMsgs.id, limit: 50 });
    for (let i = 1; i < messages.length; i++) {
      assert.ok(new Date(messages[i].occurred_at) >= new Date(messages[i - 1].occurred_at),
        'messages must be chronological');
    }
  });

  await it('draftHistory carries the trace fields the board renders', async () => {
    for (const d of await observe.draftHistory({ limit: 5 })) {
      for (const k of ['facts', 'verification', 'status', 'league_name']) {
        assert.ok(k in d, `draft is missing ${k}`);
      }
    }
  });

  console.log(`\n${pass} passing`);
}

main();
