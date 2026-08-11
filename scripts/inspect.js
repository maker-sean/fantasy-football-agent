#!/usr/bin/env node
/**
 * Inspect what actually exists on the account: groups (with chat_guid), chats,
 * and the messages/statuses in a given chat.
 *
 * Use this to find the group you ALREADY have with the bot number in it — a
 * group created outside the API is exactly the "linked iMessage chat" the send
 * endpoint requires, and it's a truer Milestone 0 target than a bot-made group.
 *
 * Usage:
 *   node scripts/inspect.js groups
 *   node scripts/inspect.js chats
 *   node scripts/inspect.js messages <chatId>      # includes delivery status
 *   node scripts/inspect.js status <chatId> <messageId>
 */

require('dotenv').config();
const { BlooioProvider } = require('../src/provider');

const provider = new BlooioProvider(process.env.BLOOIO_API_KEY);
const [cmd, ...args] = process.argv.slice(2);
const enc = encodeURIComponent;

(async () => {
  switch (cmd) {
    case 'groups': {
      const res = await provider.request('GET', '/groups');
      const groups = res.groups || res;
      console.log(JSON.stringify(res, null, 2));
      console.log('\n--- linkage ---');
      for (const g of groups) {
        const linked = g.chat_guid
          ? `LINKED to ${g.chat_guid}`
          : 'NO chat_guid — cannot receive sends to its grp_ id';
        console.log(`${g.group_id}  ${JSON.stringify(g.name)}  members=${g.member_count}  ${linked}`);
      }
      return;
    }

    case 'chats': {
      const res = await provider.request('GET', '/chats');
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    case 'messages': {
      if (!args[0]) throw new Error('usage: inspect.js messages <chatId>');
      const res = await provider.request('GET', `/chats/${enc(args[0])}/messages`);
      console.log(JSON.stringify(res, null, 2));
      const msgs = res.messages || [];
      console.log('\n--- delivery ---');
      for (const m of msgs.slice(-10)) {
        console.log(`${m.message_id}  dir=${m.direction}  status=${m.status}  protocol=${m.protocol}  ${m.error ? 'ERROR=' + JSON.stringify(m.error) : ''}`);
      }
      return;
    }

    case 'status': {
      const [chatId, messageId] = args;
      if (!chatId || !messageId) throw new Error('usage: inspect.js status <chatId> <messageId>');
      const res = await provider.request('GET', `/chats/${enc(chatId)}/messages/${enc(messageId)}/status`);
      console.log(JSON.stringify(res, null, 2));
      if (res.status === 'failed') {
        console.log('\nFAILED — the 202 only meant queued. `error` above is the real reason.');
      }
      return;
    }

    default:
      console.error(`usage:
  node scripts/inspect.js groups
  node scripts/inspect.js chats
  node scripts/inspect.js messages <chatId>
  node scripts/inspect.js status <chatId> <messageId>`);
      process.exit(1);
  }
})().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
