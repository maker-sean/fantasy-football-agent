#!/usr/bin/env node
/**
 * Did it land, and if not, send it again once.
 *
 * send_log.ok means Sendblue answered 200. A reply to the league was accepted,
 * recorded ok with status QUEUED, and then failed at the device layer with
 * "could not determine target service for group". Every record said it went
 * out. It was found because somebody read the chat and asked.
 *
 * The failure is transient and Sendblue does not retry, so one resend recovers
 * it. The danger is the opposite of the bug: a retry that retries itself turns
 * one unresolvable thread into a message every ten minutes forever. That guard
 * is what most of this file is about.
 */
require('dotenv').config();
if (!process.env.DATABASE_URL) {
  console.log('delivery\n  SKIPPED — no DATABASE_URL\n\n0 passing');
  process.exit(0);
}
const assert = require('assert');
const db = require('../src/db');
const delivery = require('../src/delivery');

let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

const CHAT = 'zz_test_group_delivery';

/** A provider that reports one message and records what it was asked to send. */
const fakeProvider = (message, sent = []) => ({
  fetchMessages: async () => ({ messages: [message] }),
  send: async (chatId, text, opts) => { sent.push({ chatId, text, opts }); return { status: 'QUEUED' }; },
  sent,
});

const seed = async (handle, { minutesAgo = 1, isRetry = false, retryCount = 0 } = {}) => {
  const { rows } = await db.query(
    `insert into send_log (chat_id, is_group, ok, status, message_handle, is_retry, retry_count, at)
     values ($1, true, true, 'QUEUED', $2, $3, $4, now() - ($5 || ' minutes')::interval)
     returning id`, [CHAT, handle, isRetry, retryCount, String(minutesAgo)]);
  return rows[0].id;
};

/* A failure that is NOT the flapping group transport, so it gets one attempt. */
const rejected = (handle, content = 'the reply that never arrived') => ({
  message_handle: handle, status: 'ERROR', error_code: 4,
  error_message: 'Message content was rejected', content, service: 'SMS',
});

const errored = (handle, content = 'the reply that never arrived') => ({
  message_handle: handle, status: 'ERROR', error_code: 5504,
  error_message: 'Could not determine target service for group', content, service: 'iMessage',
});

(async () => {
  await db.query('delete from send_log where chat_id = $1', [CHAT]);

  console.log('recording what actually happened');

  await it('a failed send is recorded as failed, next to ok=true', async () => {
    const id = await seed('h-fail');
    const sent = [];
    const out = await delivery.reconcile(fakeProvider(errored('h-fail'), sent));
    assert.strictEqual(out.failures.length, 1);
    const { rows: [row] } = await db.query('select ok, delivery from send_log where id=$1', [id]);
    assert.strictEqual(row.ok, true, 'acceptance should still read as true');
    assert.strictEqual(row.delivery, 'ERROR', 'delivery should record the truth');
  });

  await it('a send still in flight is left alone for the next pass', async () => {
    const id = await seed('h-queued');
    await delivery.reconcile(fakeProvider({ message_handle: 'h-queued', status: 'QUEUED' }));
    const { rows: [row] } = await db.query('select delivery from send_log where id=$1', [id]);
    assert.strictEqual(row.delivery, null, 'a QUEUED that never resolves is itself the signal');
  });

  console.log('\none retry, and only one');

  await it('a recent failure is resent, with the text Sendblue actually had', async () => {
    await seed('h-recent', { minutesAgo: 2 });
    const sent = [];
    const out = await delivery.reconcile(fakeProvider(errored('h-recent', 'exact original body'), sent));
    assert.strictEqual(sent.length, 1, 'nothing was resent');
    assert.strictEqual(sent[0].text, 'exact original body');
    assert.strictEqual(sent[0].chatId, CHAT);
    assert.strictEqual(out.failures[0].retried, true);
  });

  await it('the resend is marked so it can never be retried itself', async () => {
    await seed('h-mark', { minutesAgo: 2 });
    const sent = [];
    await delivery.reconcile(fakeProvider(errored('h-mark'), sent));
    assert.strictEqual(sent[0].opts.isRetry, true,
      'without this flag an unresolvable thread resends every ten minutes forever');
  });

  await it('a retry of the group transport failure IS tried again, because it flaps', async () => {
    /*
     * This used to assert the opposite, and the opposite was measured wrong.
     * On 2026-08-24 a league's group sends failed 5504 at 01:45, 01:48 and
     * 01:54 and one went through cleanly at 01:51 — an evenly flapping
     * transport, not a dead one. Stopping after a single attempt is what left
     * that league silent.
     */
    await seed('h-flap2', { minutesAgo: 2, isRetry: true, retryCount: 1 });
    const sent = [];
    const out = await delivery.reconcile(fakeProvider(errored('h-flap2'), sent));
    assert.strictEqual(sent.length, 1, 'gave up on a transport known to recover');
    assert.strictEqual(out.failures[0].retried, true);
  });

  await it('the chain still stops, so an unresolvable thread cannot loop forever', async () => {
    await seed('h-budget', { minutesAgo: 2, isRetry: true, retryCount: 3 });
    const sent = [];
    const out = await delivery.reconcile(fakeProvider(errored('h-budget'), sent));
    assert.strictEqual(sent.length, 0, 'resent past the budget, which is the loop');
    assert.strictEqual(out.failures[0].retried, false);
  });

  await it('a legacy retry row counts as an attempt even with no count on it', async () => {
    // Every row written before retry_count existed defaults to 0. Without the
    // is_retry floor they would all read as fresh and get a full new budget.
    await seed('h-legacy', { minutesAgo: 2, isRetry: true });
    const sent = [];
    await delivery.reconcile(fakeProvider(rejected('h-legacy'), sent));
    assert.strictEqual(sent.length, 0, 'a legacy retry was treated as a first attempt');
  });

  await it('a failure that is NOT the transport still gets exactly one attempt', async () => {
    // The extra budget is bought by 5504 specifically recovering on its own.
    // Rejected content will be rejected again however many times it is sent.
    await seed('h-rejected', { minutesAgo: 2, isRetry: true, retryCount: 1 });
    const sent = [];
    await delivery.reconcile(fakeProvider(rejected('h-rejected'), sent));
    assert.strictEqual(sent.length, 0, 'kept resending something the gateway refuses');
  });

  await it('the same failure is not resent on the next pass', async () => {
    await seed('h-once', { minutesAgo: 2 });
    const first = [];
    await delivery.reconcile(fakeProvider(errored('h-once'), first));
    assert.strictEqual(first.length, 1);
    // delivery is now set, so it is no longer unchecked and cannot come back.
    const second = [];
    await delivery.reconcile(fakeProvider(errored('h-once'), second));
    assert.strictEqual(second.length, 0, 'resent twice');
  });

  console.log('\nan introduction that never landed');

  /*
   * Sigma Chi Dynasty, 2026-08-24 01:45:29. welcomed_at was stamped on a send
   * that failed at the device layer two seconds later, and welcomed_at is the
   * guard against introducing a league twice — so it was never introduced once.
   * Twelve people met a bot that said nothing about itself and then started
   * answering questions.
   */
  const seedLeague = async (handle) => {
    await db.query("delete from leagues where sleeper_league_id = 'zz-delivery-welcome'");
    const { rows } = await db.query(
      `insert into leagues (name, sleeper_league_id, provider, chat_id, active, welcomed_at,
                            welcome_message_handle)
       values ('ZZ Delivery Welcome', 'zz-delivery-welcome', 'sendblue', $1, true, now(), $2)
       returning id`, [CHAT, handle]);
    return rows[0].id;
  };
  const leagueState = async (id) => (await db.query(
    'select welcomed_at, welcome_message_handle from leagues where id = $1', [id])).rows[0];

  await it('a failed introduction un-welcomes the league so it goes again', async () => {
    const id = await seedLeague('h-welcome');
    await seed('h-welcome', { minutesAgo: 2 });
    const out = await delivery.reconcile(fakeProvider(errored('h-welcome'), []));
    const after = await leagueState(id);
    assert.strictEqual(after.welcomed_at, null, 'the league is still marked introduced');
    assert.strictEqual(after.welcome_message_handle, null);
    assert.strictEqual(out.failures[0].unwelcomed, true);
  });

  await it('it is un-welcomed INSTEAD of resent, not as well as', async () => {
    // Doing both sends the introduction twice: once from the stale copy
    // Sendblue is holding, once from welcome.js rebuilding it next cycle.
    const id = await seedLeague('h-welcome-once');
    await seed('h-welcome-once', { minutesAgo: 2 });
    const sent = [];
    await delivery.reconcile(fakeProvider(errored('h-welcome-once'), sent));
    assert.strictEqual(sent.length, 0, 'resent the introduction AND queued another one');
    assert.strictEqual((await leagueState(id)).welcomed_at, null);
  });

  await it('a failed recap does not un-welcome a league introduced weeks ago', async () => {
    // Scoped by handle, not by league. Otherwise any later failure erases a
    // perfectly good introduction and the league is introduced all over again.
    const id = await seedLeague('h-welcome-kept');
    await seed('h-other-send', { minutesAgo: 2 });
    await delivery.reconcile(fakeProvider(errored('h-other-send'), []));
    assert.ok((await leagueState(id)).welcomed_at, 'an unrelated failure un-welcomed the league');
  });

  await it('a delivered introduction drops its handle, so it can never be undone later', async () => {
    const id = await seedLeague('h-welcome-ok');
    await seed('h-welcome-ok', { minutesAgo: 2 });
    await delivery.reconcile(fakeProvider(
      { message_handle: 'h-welcome-ok', status: 'DELIVERED', content: 'hello' }, []));
    const after = await leagueState(id);
    assert.ok(after.welcomed_at, 'a delivered introduction was thrown away');
    assert.strictEqual(after.welcome_message_handle, null,
      'the handle is still live and a later lookup could un-welcome them');
  });

  await db.query("delete from leagues where sleeper_league_id = 'zz-delivery-welcome'");

  console.log('\nage is the bargain');

  await it('an old failure is reported but NOT resent', async () => {
    // A reply landing an hour late drops into a conversation that moved on.
    await seed('h-old', { minutesAgo: 45 });
    const sent = [];
    const out = await delivery.reconcile(fakeProvider(errored('h-old'), sent));
    assert.strictEqual(sent.length, 0, 'resent something 45 minutes stale');
    assert.strictEqual(out.failures[0].retried, false);
  });

  console.log('\nwhat the operator is told');

  await it('the alert says whether it was resent, because that changes what you do', async () => {
    assert.match(delivery.alertText([{ state: 'ERROR', code: 5504, message: 'x', preview: 'y', retried: true }]),
      /sent it again/i);
    assert.match(delivery.alertText([{ state: 'ERROR', code: 5504, message: 'x', preview: 'y', retried: false }]),
      /Too old/i);
  });

  await it('no failures means no alert at all', async () => {
    assert.strictEqual(delivery.alertText([]), null);
    assert.strictEqual(delivery.alertText(null), null);
  });

  console.log('\nwhich transport carried it');

  await it('a chat with no recorded transport has no history to report', async () => {
    assert.strictEqual(await delivery.transportHistory('sb_group_nothing_here'), null);
  });

  await it('a null chat is null-safe', async () => {
    assert.strictEqual(await delivery.transportHistory(null), null);
  });

  await it('successes and failures are separated by transport', async () => {
    /*
     * The case this exists for: a group reply failed on iMessage with 5504 and
     * the automatic retry succeeded on SMS. Both facts sat in Sendblue's feed
     * and neither was in this database, so "this chat works on SMS" could not
     * be asked of our own data.
     */
    const chat = 'sb_group_transport_test';
    await db.query('delete from send_log where chat_id = $1', [chat]);
    for (const [service, delivered] of [['iMessage', 'ERROR'], ['iMessage', 'ERROR'], ['SMS', 'SENT']]) {
      await db.query(
        `insert into send_log (at, chat_id, is_group, ok, status, delivery, service, message_handle)
         values (now(), $1, true, true, 'QUEUED', $2, $3, gen_random_uuid()::text)`,
        [chat, delivered, service]);
    }
    const h = await delivery.transportHistory(chat);
    assert.deepStrictEqual(h.failed, { iMessage: 2 }, 'iMessage failures must not count as landings');
    assert.deepStrictEqual(h.worked, { SMS: 1 });
    assert.match(h.summary, /landed on SMS 1x/);
    assert.match(h.summary, /failed on iMessage 2x/);
    await db.query('delete from send_log where chat_id = $1', [chat]);
  });

  await it('the alert carries the pattern, so one bad night reads differently from a chronic chat', async () => {
    const withHistory = delivery.alertText([{
      state: 'ERROR', code: 5504, service: 'iMessage', message: 'x', preview: 'y', retried: true,
      history: { summary: 'landed on SMS 5x; failed on iMessage 1x' },
    }]);
    assert.match(withHistory, /on iMessage/, 'the failing transport must be named');
    assert.match(withHistory, /landed on SMS 5x/);
    assert.match(delivery.alertText([{ state: 'ERROR', message: 'x', preview: 'y', retried: true }]),
      /did NOT arrive/);
  });

  await db.query('delete from send_log where chat_id = $1', [CHAT]);
  console.log(`\n${pass} passing`);
  await db.pool.end();
})();
