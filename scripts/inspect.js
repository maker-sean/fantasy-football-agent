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
      console.log('\n--- summary ---');
      for (const g of groups) {
        // NOTE: the LIST response omits chat_guid. Absence here is not evidence
        // the group is unlinked — check `inspect.js group <id>` for the truth.
        const guid = 'chat_guid' in g
          ? (g.chat_guid ? `LINKED ${g.chat_guid}` : 'chat_guid=null')
          : 'chat_guid not returned by list — use `inspect.js group <id>`';
        console.log(`${g.group_id}  ${JSON.stringify(g.name)}  members=${g.member_count}  msgs=${g.message_count}  last=${g.last_message_direction}`);
        console.log(`    ${guid}`);
      }
      console.log('\nA group with outbound messages in its history is demonstrably working,');
      console.log('whatever the list endpoint reports. Read one: inspect.js verdict <groupId>');
      return;
    }

    case 'group': {
      if (!args[0]) throw new Error('usage: inspect.js group <groupId>');
      const detail = await provider.request('GET', `/groups/${enc(args[0])}`);
      console.log(JSON.stringify(detail, null, 2));
      console.log(`\nchat_guid: ${detail.chat_guid ?? '(null/absent — created via API, not linked)'}`);
      try {
        const mem = await provider.request('GET', `/groups/${enc(args[0])}/members`);
        console.log('\nmembers:', JSON.stringify(mem, null, 2));
      } catch (err) {
        console.log(`\nmembers lookup failed: ${err.status || err.message}`);
      }
      return;
    }

    case 'verdict': {
      if (!args[0]) throw new Error('usage: inspect.js verdict <groupId or chatId>');
      const chatId = args[0];
      const res = await provider.request('GET', `/chats/${enc(chatId)}/messages`);
      const msgs = res.messages || [];

      console.log(`${msgs.length} messages in ${chatId}\n`);
      for (const m of msgs) {
        const who = m.direction === 'outbound' ? '(bot)' : (m.sender || m.from || '?');
        console.log(`[${m.direction}] ${who}  protocol=${m.protocol}  status=${m.status}${m.error ? '  ERROR=' + JSON.stringify(m.error) : ''}`);
        console.log(`    ${JSON.stringify((m.text || '').slice(0, 90))}`);
      }

      const inbound = msgs.filter(m => m.direction === 'inbound');
      const outbound = msgs.filter(m => m.direction === 'outbound');
      const senders = [...new Set(inbound.map(m => m.sender || m.from).filter(Boolean))];
      // `pending` and `unknown` are not transports — pending means the wire
      // service never resolved, so counting them as protocols is misleading.
      const protocols = [...new Set(
        msgs.map(m => m.protocol).filter(p => p && p !== 'pending' && p !== 'unknown')
      )];
      const delivered = outbound.filter(m => m.status === 'delivered' || m.status === 'sent');
      const failed = outbound.filter(m => m.status === 'failed');

      console.log('\n--- MILESTONE 0 VERDICT ---');
      console.log(`inbound=${inbound.length}  outbound=${outbound.length}  delivered/sent=${delivered.length}  failed=${failed.length}`);
      console.log(`distinct inbound senders: ${senders.length ? senders.join(', ') : '(none)'}`);
      console.log(`protocols observed: ${protocols.join(', ') || '(none)'}`);

      const apple = protocols.filter(p => /imessage/i.test(p));
      const other = protocols.filter(p => !/imessage/i.test(p) && p !== 'unknown');

      if (delivered.length && senders.length >= 2) {
        console.log('\nTEST (b) PASS: outbound reached this thread.');
        console.log('TEST (a) PASS: multiple distinct senders resolved on ONE chat id.');
      } else if (delivered.length) {
        console.log('\nTEST (b) PASS: outbound reached this thread.');
        console.log(`TEST (a) INCOMPLETE: only ${senders.length} distinct sender — need the Android member to post.`);
      } else {
        console.log('\nTEST (b) FAIL/UNKNOWN: no outbound reached sent/delivered.');
      }

      if (apple.length && other.length) {
        console.log(`MIXED-DEVICE CONFIRMED on one chat: ${protocols.join(' + ')}`);
        console.log('The in-group architecture survives a real mixed league.');
      } else if (protocols.length) {
        console.log(`Single protocol family (${protocols.join(', ')}) — not yet proof of mixed-device.`);
      }

      // A thread that receives RCS/SMS inbound is NOT an iMessage thread. The
      // bot's sending hardware is a Mac; whether it can push into a non-iMessage
      // group is the thing that decides the whole in-group architecture.
      const nonAppleInbound = inbound.some(m => /rcs|sms/i.test(m.protocol || ''));
      if (nonAppleInbound) {
        console.log('\nThis thread carries inbound over RCS/SMS — it is NOT an iMessage group.');
        console.log('A non-Apple member forced it off iMessage for everyone.');
      }

      const deviceErrors = failed.filter(m => m.error?.code === 'device_send_error');
      if (deviceErrors.length) {
        console.log('\n--- DEVICE SEND ERROR ---');
        for (const m of deviceErrors) {
          console.log(`  ${m.error.message} (deviceErrorCode=${m.error.details?.deviceErrorCode})`);
        }
        console.log('  protocol=pending means the wire service never resolved — the send');
        console.log('  failed at Blooio\'s Mac before a transport was chosen.');
        console.log('  This code is undocumented. One occurrence is not proof of a');
        console.log('  structural limit: retry before concluding in-group is dead.');
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
  node scripts/inspect.js groups                       list all groups
  node scripts/inspect.js group <groupId>              detail + chat_guid + members
  node scripts/inspect.js verdict <groupId>            read history, render M0 verdict
  node scripts/inspect.js chats
  node scripts/inspect.js messages <chatId>
  node scripts/inspect.js status <chatId> <messageId>`);
      process.exit(1);
  }
})().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
