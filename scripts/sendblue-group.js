#!/usr/bin/env node
/**
 * Run the Milestone 0 group test against Sendblue.
 *
 * Same experiment as the Blooio run: create a group containing at least one
 * non-iMessage member and see whether outbound reaches it. Nothing above
 * MessagingProvider changed to get here.
 *
 * Prior: Sendblue's own feature page states "Group iMessage requires all
 * participants to have iMessage enabled," and outbound group creation is gated
 * to the Blue Ocean plan. Their docs separately claim SMS and MMS group sending
 * is supported. That contradiction is what this script resolves.
 *
 * Usage:
 *   node scripts/sendblue-group.js --dry-run "message" 4805551111 4805552222
 *   node scripts/sendblue-group.js "message" 4805551111 4805552222 4805553333
 *   node scripts/sendblue-group.js --group <group_id> "follow-up message"
 */

require('dotenv').config();
const { SendblueProvider } = require('../src/sendblue');

const argv = process.argv.slice(2);

const skip = new Set();
let groupId = null;
let dryRun = false;
argv.forEach((a, i) => {
  if (a === '--dry-run') { dryRun = true; skip.add(i); }
  if (a === '--group') { groupId = argv[i + 1] || null; skip.add(i); skip.add(i + 1); }
});

const rest = argv.filter((_, i) => !skip.has(i));
const [text, ...rawNumbers] = rest;

if (!text || (!rawNumbers.length && !groupId)) {
  console.error('usage: node scripts/sendblue-group.js [--dry-run] "<message>" <number> [<number> ...]');
  console.error('       node scripts/sendblue-group.js --group <group_id> "<message>"');
  process.exit(1);
}

if (/^\+?[\d\s().-]{7,}$/.test(text.trim())) {
  console.error(`Refusing to send ${JSON.stringify(text)} — that looks like a phone number, not a message.`);
  console.error('The message must come FIRST, then the recipients.');
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

const numbers = rawNumbers.map(toE164);
const provider = new SendblueProvider(
  process.env.SENDBLUE_API_KEY_ID,
  process.env.SENDBLUE_API_SECRET_KEY,
  { fromNumber: process.env.SENDBLUE_FROM_NUMBER }
);

(async () => {
  console.log(`Message: ${JSON.stringify(text)}`);
  if (groupId) console.log(`Existing group: ${groupId}`);
  else console.log(`Participants: ${numbers.join(', ')}`);

  let anyNonApple = false;

  if (!groupId) {
    console.log('\n1. Service lookup (Sendblue evaluate-service):');
    for (const n of numbers) {
      try {
        const res = await provider.evaluateService(n);
        const service = res?.service || res?.data?.service || JSON.stringify(res);
        if (!/imessage/i.test(String(service))) anyNonApple = true;
        console.log(`   ${n}  service=${service}`);
      } catch (err) {
        console.log(`   ${n}  lookup failed: ${err.code || err.status} ${err.message.slice(0, 120)}`);
      }
    }

    if (anyNonApple) {
      console.log('\n   Mixed group confirmed. Sendblue states group iMessage requires');
      console.log('   every participant on iMessage — this is the exact condition that');
      console.log('   failed on Blooio with device_send_error 4.');
    }
  }

  if (dryRun) {
    console.log('\nDRY RUN — nothing sent.');
    return;
  }

  console.log('\n2. Sending...');
  const res = groupId
    ? await provider.send(groupId, text)
    : await provider.sendNewGroup(numbers, text);

  console.log(JSON.stringify(res, null, 2));

  const newGroupId = res?.group_id || res?.data?.group_id;
  if (newGroupId) {
    console.log(`\ngroup_id: ${newGroupId}`);
    console.log('Save it — Sendblue\'s docs call it "the only way you will be able to');
    console.log('correlate messages sent in a group to messages received from a group."');
    console.log(`Follow up with:  node scripts/sendblue-group.js --group ${newGroupId} "next message"`);
  }

  console.log('\n--- NOW VERIFY WITH HUMANS ---');
  console.log('An accepted API response is not delivery. Ask each participant:');
  console.log('  - did the message arrive at all?');
  console.log('  - did it arrive in ONE shared thread, or as a separate 1:1?');
  console.log('  - did the non-iMessage member get it?');
})().catch(err => {
  console.error('\nERROR:', err.message);
  if (err.code) console.error('error_code:', err.code);

  const blob = `${err.code || ''} ${err.message}`.toLowerCase();
  if (/plan|subscription|upgrade|not allowed|forbidden|permission/.test(blob) || err.status === 403) {
    console.error('\n--- LIKELY PLAN GATE ---');
    console.error('Sendblue restricts outbound group creation to the Blue Ocean plan.');
    console.error('On a free account this fails regardless of device mix, so it does');
    console.error('NOT tell you anything about mixed-device groups. Test 1:1 instead:');
    console.error('  node scripts/sendblue-send.js "+1<android-number>" "test"');
  }
  process.exit(1);
});
