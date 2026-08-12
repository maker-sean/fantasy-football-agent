#!/usr/bin/env node
/**
 * Read what actually happened to Sendblue messages.
 *
 * QUEUED is not delivery. Sendblue's lifecycle is
 *   REGISTERED -> PENDING -> QUEUED -> ACCEPTED -> SENT -> DELIVERED
 * with DECLINED / ERROR as terminal failures. Every send in this project so far
 * that looked fine at accept time has needed this check to be believed.
 *
 * Watch two fields on group sends specifically:
 *   was_downgraded  — set when the thread is pushed off iMessage
 *   service         — the transport that actually carried it (null until resolved)
 *
 * Usage:
 *   node scripts/sendblue-status.js                       # recent messages
 *   node scripts/sendblue-status.js <message_handle>      # one message
 *   node scripts/sendblue-status.js --group <group_id>    # one thread
 */

require('dotenv').config();
const { SendblueProvider } = require('../src/sendblue');

const argv = process.argv.slice(2);
const groupIdx = argv.indexOf('--group');
const groupId = groupIdx !== -1 ? argv[groupIdx + 1] : null;
const handle = argv.find((a, i) => a !== '--group' && i !== groupIdx + 1 && !a.startsWith('--'));

const provider = new SendblueProvider(
  process.env.SENDBLUE_API_KEY_ID,
  process.env.SENDBLUE_API_SECRET_KEY,
  { fromNumber: process.env.SENDBLUE_FROM_NUMBER }
);

const row = m => {
  const dir = m.is_outbound ? 'out' : 'IN ';
  const who = m.is_outbound
    ? (Array.isArray(m.to_number) ? m.to_number.join(',') : m.to_number)
    : m.from_number;
  console.log(`[${dir}] ${m.status.padEnd(9)} service=${String(m.service)} downgraded=${String(m.was_downgraded)} group=${m.group_id || '-'}`);
  console.log(`      ${who}  ${JSON.stringify(String(m.content || '').slice(0, 70))}`);
  if (m.error_code || m.error_message) {
    console.log(`      ERROR ${m.error_code || ''} ${m.error_message || ''} ${m.error_detail || ''}`);
  }
};

(async () => {
  let path = '/api/v2/messages?limit=25';
  if (groupId) path += `&group_id=${encodeURIComponent(groupId)}`;

  const res = await provider.request('GET', path);
  const msgs = res?.messages || res?.data || (Array.isArray(res) ? res : []);

  const filtered = handle
    ? msgs.filter(m => m.message_handle === handle)
    : msgs;

  if (!filtered.length) {
    console.log('No messages matched. Raw response:');
    console.log(JSON.stringify(res, null, 2).slice(0, 1500));
    return;
  }

  for (const m of filtered) row(m);

  const groups = filtered.filter(m => m.group_id);
  const outbound = groups.filter(m => m.is_outbound);
  const inbound = groups.filter(m => !m.is_outbound);
  const senders = [...new Set(inbound.map(m => m.from_number))];
  const landed = outbound.filter(m => ['SENT', 'DELIVERED'].includes(String(m.status).toUpperCase()));
  const downgraded = groups.filter(m => m.was_downgraded);

  if (groups.length) {
    console.log('\n--- GROUP SUMMARY ---');
    console.log(`outbound=${outbound.length} (landed=${landed.length})  inbound=${inbound.length}`);
    console.log(`distinct inbound senders: ${senders.join(', ') || '(none)'}`);
    console.log(`services seen: ${[...new Set(groups.map(m => m.service).filter(Boolean))].join(', ') || '(none resolved)'}`);
    if (downgraded.length) {
      console.log(`DOWNGRADED: ${downgraded.length} message(s) pushed off iMessage.`);
      console.log('That is the mixed-device fallback actually working — the thing Blooio could not do.');
    }
    if (senders.length >= 2) {
      console.log('Replies from multiple people correlated to ONE group_id — inbound routing holds.');
    } else if (inbound.length) {
      console.log(`Only ${senders.length} distinct replier so far — need more people to reply.`);
    }
  }
})().catch(err => {
  console.error('ERROR:', err.message);
  if (err.status === 401) console.error('Check SENDBLUE_API_KEY_ID / SENDBLUE_API_SECRET_KEY in .env');
  process.exit(1);
});
