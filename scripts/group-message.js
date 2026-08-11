#!/usr/bin/env node
/**
 * Create a group and send it one message. This is Milestone 0 test (b).
 *
 * Per docs.blooio.com (POST /groups):
 *   "Omit chat_guid to create a new group. When you send the first message, a
 *    new iMessage chat will be created."
 *
 * The group therefore does not exist as a real thread until the first send —
 * so this script does both in sequence.
 *
 * CAVEAT worth holding onto: a bot-CREATED group is not the same deployment
 * path as the bot being ADDED to a league's existing 12-person thread. This
 * validates the mechanism cheaply. It does not validate the real rollout.
 *
 * Usage:
 *   node scripts/group-message.js --dry-run "Test Group" "message" 4805551111 4805552222
 *   node scripts/group-message.js "Test Group" "message" 4805551111 4805552222 4805553333
 */

require('dotenv').config();
const { BlooioProvider } = require('../src/provider');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const rest = argv.filter(a => a !== '--dry-run');
const [groupName, text, ...rawMembers] = rest;

if (!groupName || !text || !rawMembers.length) {
  console.error('usage: node scripts/group-message.js [--dry-run] "<group name>" "<message>" <number> [<number> ...]');
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
  console.log(`Group:   ${JSON.stringify(groupName)}`);
  console.log(`Members: ${members.join(', ')}  (+ your number makes ${members.length + 1})`);
  console.log(`Message: ${JSON.stringify(text)}`);

  if (members.length + 1 > 10) {
    console.warn('\nWARNING: >10 participants. Group MMS is carrier-capped around 10.');
    console.warn('If any member is non-Apple this may fragment or hard-error.');
  }

  if (dryRun) {
    console.log('\nDRY RUN — no group created, nothing sent.');
    return;
  }

  console.log('\n1. Checking capabilities (who is Apple, who is not)...');
  for (const m of members) {
    try {
      console.log(`   ${m}  ${JSON.stringify(await provider.capabilities(m))}`);
    } catch (err) {
      console.log(`   ${m}  (lookup failed: ${err.status || err.message})`);
    }
  }

  console.log('\n2. Creating group (no chat_guid -> new iMessage chat on first send)...');
  const group = await provider.createGroup({ name: groupName, members });
  console.log(JSON.stringify(group, null, 2));

  const groupId = group.group_id || group.id;
  if (!groupId) throw new Error('no group_id in response — inspect the payload above');

  // Did Blooio actually attach the members to the real thread? For a LINKED
  // group the docs say members are bookkeeping only. For a CREATED group this
  // is the field that tells us.
  if ('added_members' in group) {
    console.log(`\n   added_members: ${JSON.stringify(group.added_members)}`);
    console.log('   ^ if this is empty, the members were recorded but NOT put in the real chat.');
  }

  console.log(`\n3. Sending first message to group ${groupId}...`);
  let sentTo = groupId;
  try {
    await provider.send(groupId, text, { idempotencyKey: `grp-${groupId}-${Date.now()}` });
  } catch (err) {
    // Fall back to the BlueBubbles chat guid if the group id isn't the chat handle.
    if (group.chat_guid) {
      console.log(`   group_id send failed (${err.status}); retrying with chat_guid...`);
      await provider.send(group.chat_guid, text, { idempotencyKey: `grp-${group.chat_guid}-${Date.now()}` });
      sentTo = group.chat_guid;
    } else {
      throw err;
    }
  }

  console.log(`   202 Accepted — queued to ${sentTo}`);
  console.log('\n--- what to check now ---');
  console.log('1. Did all members land in ONE thread, or did some get a separate 1:1?');
  console.log('2. Have EACH of them reply in that thread (include the Android user).');
  console.log('3. With the receiver running (npm start), read the verdict:');
  console.log('     curl -s localhost:3000/m0');
  console.log(`   PASS = one chat id, is_group true, every sender distinct, protocols spanning`);
  console.log('   imessage and sms/rcs. More than one group chat id = fragmentation.');
})().catch(err => {
  console.error('\nERROR:', err.message);
  if (err.status === 404) {
    console.error('POST /groups 404 — confirm the path at docs.blooio.com/reference/v2/groups.');
  }
  process.exit(1);
});
