#!/usr/bin/env node
/**
 * Inspect / create Blooio groups.
 *
 * IMPORTANT (from docs.blooio.com, POST /groups):
 *   - Omit chat_guid  -> a NEW iMessage chat is created when you send the first message.
 *   - Provide chat_guid -> JOIN an existing group chat created outside the API.
 *     chat_guid is a BlueBubbles chat GUID.
 *   - "The members list records who is in the group but does NOT add them to
 *     the linked iMessage chat." Members are bookkeeping. Adding the bot to a
 *     real league thread is a HUMAN action from someone's iPhone.
 *
 * Usage:
 *   node scripts/groups.js list
 *   node scripts/groups.js get <groupId>
 *   node scripts/groups.js members <groupId>
 *   node scripts/groups.js create "My League" [chat_guid] [+1555...,+1555...]
 */

require('dotenv').config();
const { BlooioProvider } = require('../src/provider');

const provider = new BlooioProvider(process.env.BLOOIO_API_KEY);
const [cmd, ...args] = process.argv.slice(2);

function out(x) { console.log(JSON.stringify(x, null, 2)); }

(async () => {
  switch (cmd) {
    case 'list':
      return out(await provider.listGroups());

    case 'get':
      if (!args[0]) throw new Error('usage: groups.js get <groupId>');
      return out(await provider.getGroup(args[0]));

    case 'members':
      if (!args[0]) throw new Error('usage: groups.js members <groupId>');
      return out(await provider.listGroupMembers(args[0]));

    case 'create': {
      const [name, chatGuid, members] = args;
      if (!name) throw new Error('usage: groups.js create "<name>" [chat_guid] [members,csv]');
      const res = await provider.createGroup({
        name,
        chatGuid: chatGuid || undefined,
        members: members ? members.split(',').map(s => s.trim()) : undefined,
      });
      out(res);
      if (!chatGuid) {
        console.error('\nNOTE: no chat_guid given — the iMessage chat is not created until');
        console.error('you send the first message to this group.');
      }
      console.error('\nREMINDER: members[] does NOT add anyone to the real iMessage thread.');
      return;
    }

    default:
      console.error(`usage:
  node scripts/groups.js list
  node scripts/groups.js get <groupId>
  node scripts/groups.js members <groupId>
  node scripts/groups.js create "<name>" [chat_guid] [+1555...,+1555...]`);
      process.exit(1);
  }
})().catch(err => {
  console.error('ERROR:', err.message);
  if (err.status === 404) {
    console.error('\n404 — this endpoint path may differ in your account\'s API version.');
    console.error('Check docs.blooio.com/reference/v2/groups and adjust src/provider.js.');
  }
  process.exit(1);
});
