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

const seed = async (handle, { minutesAgo = 1, isRetry = false } = {}) => {
  const { rows } = await db.query(
    `insert into send_log (chat_id, is_group, ok, status, message_handle, is_retry, at)
     values ($1, true, true, 'QUEUED', $2, $3, now() - ($4 || ' minutes')::interval)
     returning id`, [CHAT, handle, isRetry, String(minutesAgo)]);
  return rows[0].id;
};

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

  await it('a row that IS a retry is never retried again', async () => {
    await seed('h-isretry', { minutesAgo: 2, isRetry: true });
    const sent = [];
    const out = await delivery.reconcile(fakeProvider(errored('h-isretry'), sent));
    assert.strictEqual(sent.length, 0, 'a retry was retried, which is the loop');
    assert.strictEqual(out.failures[0].retried, false);
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

  await db.query('delete from send_log where chat_id = $1', [CHAT]);
  console.log(`\n${pass} passing`);
  await db.pool.end();
})();
