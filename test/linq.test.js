#!/usr/bin/env node
/**
 * The Linq provider — built, tested, and deliberately not active.
 *
 * Every field asserted here was measured against the live API on 2026-08-16.
 * That matters: the Blooio adapter this project started from was written from
 * documentation, read the wrong field names, and would have dropped every
 * inbound message silently. Docs summarise; only the wire is authoritative.
 */
const assert = require('assert');
const crypto = require('crypto');
const { LinqProvider, textOf } = require('../src/linq');

let pass = 0;
const it = (n, f) => {
  try { f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

const p = new LinqProvider('test-key', { fromNumber: '+15555550110' });

console.log('inbound transport');
it('declares webhook delivery, unlike Sendblue', () =>
  assert.strictEqual(p.inboundMode, 'webhook'));
it('the poller refuses a webhook provider instead of spinning silently', () => {
  const { startPolling } = require('../src/poller');
  assert.throws(() => startPolling(p, () => {}), /webhook, not polling/);
});

console.log('\nparsing a real message payload');
// Shape captured from GET /chats/{id}/messages against the live API.
const wire = {
  id: '71365ca7-2659-4ccc-8d26-eb20a3179f8a',
  chat_id: 'ea56d5f4-c21c-4afd-b7c9-bf331d9f7e85',
  from_handle: '+15555550111',
  from: '+15555550111',
  is_from_me: false,
  parts: [{ type: 'text', text: 'bot who won last year?' }],
  service: 'iMessage',
  preferred_service: 'iMessage',
  delivery_status: 'delivered',
  created_at: '2026-08-16T19:30:02.318117Z',
  reply_to: null,
};

it('pulls text out of the parts array', () =>
  assert.strictEqual(p.parseInbound({ data: wire }).text, 'bot who won last year?'));
it('reads the sender from from_handle', () =>
  assert.strictEqual(p.parseInbound({ data: wire }).senderId, '+15555550111'));
it('carries the chat id', () =>
  assert.strictEqual(p.parseInbound({ data: wire }).chatId, wire.chat_id));
it('normalizes the service to a protocol', () =>
  assert.strictEqual(p.parseInbound({ data: wire }).protocol, 'imessage'));
it('parses the timestamp', () =>
  assert.strictEqual(p.parseInbound({ data: wire }).timestamp, Date.parse(wire.created_at)));

console.log('\nis_from_me is authoritative — this is how the bot avoids answering itself');
it('a message from someone else is inbound', () =>
  assert.strictEqual(p.parseInbound({ data: wire }).direction, 'inbound'));
it('our own message is outbound', () =>
  assert.strictEqual(p.parseInbound({ data: { ...wire, is_from_me: true } }).direction, 'outbound'));

console.log('\nreply_to — a signal Sendblue never provided');
it('no reply reference means replyToBot is false', () =>
  assert.strictEqual(p.parseInbound({ data: wire }).replyToBot, false));
it('a reply reference sets replyToBot, which decide.js already handles', () => {
  const m = p.parseInbound({ data: { ...wire, reply_to: { id: 'abc' } } });
  assert.strictEqual(m.replyToBot, true);
  assert.strictEqual(m.replyToId, 'abc');
});

console.log('\nenvelope shapes — webhooks may wrap the message');
for (const [label, body] of [
  ['bare', wire],
  ['under data', { data: wire }],
  ['under message', { message: wire }],
  ['under data.message', { data: { message: wire }, event: 'message.received' }],
]) {
  it(`unwraps ${label}`, () => assert.strictEqual(p.parseInbound(body).messageId, wire.id));
}

console.log('\ntext extraction');
it('ignores non-text parts', () =>
  assert.strictEqual(textOf([{ type: 'link', url: 'x' }, { type: 'text', text: 'hi' }]), 'hi'));
it('joins multiple text parts', () =>
  assert.strictEqual(textOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb'));
it('an attachment-only message yields empty text, not a crash', () =>
  assert.strictEqual(textOf([{ type: 'media', url: 'x' }]), ''));

console.log('\ngroup limits are enforced before the API rejects them');
const nums = n => Array.from({ length: n }, (_, i) => '+1555000' + String(i).padStart(4, '0'));
it('refuses a group below two recipients', () =>
  assert.throws(() => LinqProvider.assertGroupSize(nums(1)), /at least 2/));
it('refuses more than the documented 31', () =>
  assert.throws(() => LinqProvider.assertGroupSize(nums(32)), /at most 31/));
it('accepts the 11 other managers in a 12-person league', () =>
  assert.strictEqual(LinqProvider.assertGroupSize(nums(11)).length, 11));
it('drops blanks rather than sending them to the API', () =>
  assert.strictEqual(LinqProvider.assertGroupSize(['+15551112222', '', '  ', '+15553334444']).length, 2));

console.log('\nwebhook signatures — this endpoint is public');
const SECRET = 'whsec_' + Buffer.from('super-secret-value').toString('base64');
const raw = JSON.stringify({ data: wire });
const sign = (body, ts) => {
  const secret = SECRET.replace(/^whsec_/, '');
  const payload = ts ? `${ts}.${body}` : body;
  return crypto.createHmac('sha256', Buffer.from(secret, 'base64')).update(payload, 'utf8').digest('hex');
};

it('accepts a correct bare signature', () =>
  assert.strictEqual(LinqProvider.verifySignature(raw, sign(raw), SECRET), true));
it('accepts a correct timestamped signature', () => {
  const ts = Math.floor(Date.now() / 1000);
  assert.strictEqual(LinqProvider.verifySignature(raw, `t=${ts},v1=${sign(raw, ts)}`, SECRET), true);
});
it('rejects a wrong signature', () =>
  assert.strictEqual(LinqProvider.verifySignature(raw, 'deadbeef', SECRET), false));
it('rejects a valid signature over a DIFFERENT body', () =>
  assert.strictEqual(LinqProvider.verifySignature('{"tampered":true}', sign(raw), SECRET), false));
it('rejects a missing signature', () =>
  assert.strictEqual(LinqProvider.verifySignature(raw, null, SECRET), false));
it('rejects when no secret is configured', () =>
  assert.strictEqual(LinqProvider.verifySignature(raw, sign(raw), null), false));
it('rejects a replayed payload outside the timestamp window', () => {
  const old = Math.floor(Date.now() / 1000) - 3600;
  assert.strictEqual(LinqProvider.verifySignature(raw, `t=${old},v1=${sign(raw, old)}`, SECRET), false);
});

console.log('\nsending needs a line');
it('createGroup without a from number fails loudly', () => {
  const noFrom = new LinqProvider('k');
  assert.throws(() => noFrom.requireFromNumber(), /LINQ_FROM_NUMBER/);
});

console.log(`\n${pass} passing`);
