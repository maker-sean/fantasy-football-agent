#!/usr/bin/env node
/**
 * Store any Sendblue messages the poller missed.
 *
 * The poller's cursor used to advance on READ rather than on successful
 * handling, so anything read during a run that did not persist was skipped
 * permanently — silently, with no way to notice except comparing against the
 * provider by hand. That is fixed in src/poller.js, but messages already lost
 * to it need recovering.
 *
 * Idempotent: inserts are unique on (provider, provider_message_id), so running
 * this twice stores nothing the second time.
 *
 * Usage:
 *   node scripts/messages-backfill.js --dry-run
 *   node scripts/messages-backfill.js --limit 200
 */

require('dotenv').config();
const db = require('../src/db');
const poller = require('../src/poller');
const { SendblueProvider } = require('../src/sendblue');

const argv = process.argv.slice(2);
const has = f => argv.includes(`--${f}`);
const flag = f => { const i = argv.indexOf(`--${f}`); return i !== -1 ? argv[i + 1] : null; };
const limit = Number(flag('limit') || 100);

const provider = new SendblueProvider(
  process.env.SENDBLUE_API_KEY_ID,
  process.env.SENDBLUE_API_SECRET_KEY,
  { fromNumber: process.env.SENDBLUE_FROM_NUMBER }
);

(async () => {
  const res = await provider.request('GET', `/api/v2/messages?limit=${limit}`);
  const rows = res?.messages || res?.data || (Array.isArray(res) ? res : []);
  console.log(`${rows.length} message(s) on Sendblue (limit ${limit})`);

  const { rows: existing } = await db.query(
    `select provider_message_id from messages where provider = 'sendblue'
     and provider_message_id is not null`);
  const known = new Set(existing.map(r => r.provider_message_id));

  // Backfill outbound too — the engagement metric's denominator is bot
  // messages, so a missing send corrupts the ratio just as badly as a missing
  // reply.
  const missing = rows.filter(m => m.message_handle && !known.has(m.message_handle));
  console.log(`${missing.length} not yet stored\n`);

  if (!missing.length) { console.log('Nothing to backfill.'); return; }

  let stored = 0, skipped = 0, unrouted = 0;
  for (const m of missing.sort((a, b) => String(a.date_sent).localeCompare(String(b.date_sent)))) {
    const ev = poller.toEvent(m);
    const dir = m.is_outbound ? 'outbound' : 'inbound';
    const chatId = m.group_id || (m.is_outbound
      ? (Array.isArray(m.to_number) ? m.to_number.join(',') : m.to_number)
      : m.from_number);

    const label = `${String(m.date_sent).slice(5, 16)}  ${dir.padEnd(8)} ${JSON.stringify(String(m.content || '').slice(0, 48))}`;

    if (has('dry-run')) { console.log(`  would store  ${label}`); stored += 1; continue; }

    const league = await db.leagueByChat('sendblue', chatId);
    if (!league) unrouted += 1;

    const row = await db.recordMessage({
      leagueId: league?.id || null,
      provider: 'sendblue',
      providerMessageId: m.message_handle,
      direction: dir,
      chatId,
      senderPhone: m.is_outbound ? null : m.from_number,
      isGroup: Boolean(m.group_id) || m.message_type === 'group',
      protocol: String(m.service || '').toLowerCase() || null,
      body: m.content,
      raw: m,
      occurredAt: m.date_sent ? Date.parse(m.date_sent) : Date.now(),
    });

    if (row) { stored += 1; console.log(`  stored  ${label}${league ? '' : '  [UNROUTED]'}`); }
    else { skipped += 1; }
  }

  console.log(`\n${stored} stored, ${skipped} already present, ${unrouted} unrouted`);
  if (!has('dry-run')) {
    console.log('\nRe-run the decision replay to see what the bot would have done:');
    console.log('  node scripts/decide-replay.js --verbose');
  }
})()
  .catch(err => { console.error('ERROR:', err.message); process.exitCode = 1; })
  .finally(() => db.pool.end().catch(() => {}));
