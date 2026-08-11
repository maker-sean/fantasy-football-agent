#!/usr/bin/env node
/**
 * Send one message to a real group chat. This is Milestone 0 test (b).
 *
 * WHY THE grp_ PATH FAILED SILENTLY (from the OpenAPI spec, POST /chats/{chatId}/messages):
 *
 *   "The chatId can be: (1) E.164 phone number, (2) email address, (3) group ID
 *    (grp_xxxx), or (4) comma-separated list of phone/email for multi-recipient
 *    chats. For multi-recipient, an unnamed group is automatically created or
 *    reused if the exact participant combination already exists. For explicit
 *    groups, the group must be linked to an existing iMessage chat."
 *
 * A group created via POST /groups WITHOUT chat_guid has no linked iMessage
 * chat, so sending to its grp_ id is accepted (202) and then goes nowhere.
 * The 202 means queued, never delivered.
 *
 * So this script uses mode (4): the comma-separated participant list, which
 * creates the real chat as a side effect of the send.
 *
 * Usage:
 *   node scripts/group-message.js --dry-run "message" 4805551111 4805552222
 *   node scripts/group-message.js "message" 4805551111 4805552222 4805553333
 *   node scripts/group-message.js --via-group grp_abc123 "message"
 */

require('dotenv').config();
const { BlooioProvider } = require('../src/provider');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const viaGroupIdx = argv.indexOf('--via-group');
const viaGroup = viaGroupIdx !== -1 ? argv[viaGroupIdx + 1] : null;

const rest = argv.filter((a, i) =>
  a !== '--dry-run' && a !== '--via-group' && i !== viaGroupIdx + 1);
const [text, ...rawMembers] = rest;

if (!text || (!rawMembers.length && !viaGroup)) {
  console.error('usage: node scripts/group-message.js [--dry-run] "<message>" <number> [<number> ...]');
  console.error('       node scripts/group-message.js --via-group <grp_id> "<message>"');
  process.exit(1);
}

function toE164(raw) {
  const s = String(raw).trim();
  if (s.includes('@')) return s;
  const digits = s.replace(/[^\d]/g, '');
  if (s.startsWith('+')) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  throw new Error(`can't normalize "${raw}" — pass it in E.164 (+15551234567)`);
}

const members = rawMembers.map(toE164);
const provider = new BlooioProvider(process.env.BLOOIO_API_KEY);

(async () => {
  // Mode (4): the participant list IS the chat id. This is what creates a real
  // multi-recipient thread; an unlinked grp_ id does not.
  const chatId = viaGroup || members.join(',');

  console.log(`chatId:  ${chatId}`);
  console.log(`Message: ${JSON.stringify(text)}`);
  if (members.length) console.log(`Participants: ${members.length} + your number = ${members.length + 1}`);

  if (members.length + 1 > 10) {
    console.warn('\nWARNING: >10 participants — group MMS is carrier-capped near 10.');
  }

  if (!viaGroup) {
    console.log('\nCapabilities:');
    let anyNonApple = false;
    for (const m of members) {
      try {
        const cap = await provider.capabilities(m);
        const im = cap?.capabilities?.imessage;
        if (im === false) anyNonApple = true;
        console.log(`  ${m}  imessage=${im}  sms=${cap?.capabilities?.sms}`);
      } catch (err) {
        console.log(`  ${m}  (lookup failed: ${err.status || err.message})`);
      }
    }
    if (anyNonApple) {
      console.log('\n  Mixed group: at least one member has no iMessage. An all-Apple');
      console.log('  iMessage group is impossible here — this must degrade to group');
      console.log('  MMS/RCS or fragment. That degradation IS the Milestone 0 question.');
    }
  }

  if (dryRun) {
    console.log('\nDRY RUN — nothing sent.');
    return;
  }

  console.log('\nSending...');
  const res = await provider.send(chatId, text, { idempotencyKey: `grp-${Date.now()}` });
  console.log('202 Accepted:', JSON.stringify(res));

  const messageId = res?.message_id || res?.id;
  console.log('\n--- 202 IS NOT DELIVERY ---');
  if (messageId) {
    console.log('Check what actually happened:');
    console.log(`  node scripts/inspect.js status ${JSON.stringify(chatId)} ${messageId}`);
  } else {
    console.log('No message_id in the response body. List the chat instead:');
    console.log(`  node scripts/inspect.js messages ${JSON.stringify(chatId)}`);
  }
  console.log('\nStatus meanings: queued -> waiting for Apple/carrier; sent -> handed off');
  console.log('(protocol resolves here); delivered -> receipt received; failed -> see `error`.');
})().catch(err => {
  console.error('\nERROR:', err.message);
  const code = err.body?.code;
  if (code) console.error(`code: ${code}`);
  if (code === 'conversation_content_restricted') {
    console.error('Links/media are blocked before the recipient first writes back. Send plain text.');
  }
  if (code === 'conversation_awaiting_reply') {
    console.error('Cap of 3 messages to a new recipient before they respond.');
  }
  process.exit(1);
});
