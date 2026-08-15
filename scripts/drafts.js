#!/usr/bin/env node
/**
 * Inspect and act on recap drafts from a terminal.
 *
 * The normal path is your phone — the bot texts you the recap and you reply
 * SEND. This is the escape hatch for when you are at a laptop, and the way to
 * exercise the flow before a season is running.
 *
 * Usage:
 *   node scripts/drafts.js                 what is queued
 *   node scripts/drafts.js --generate      run the weekly job now
 *   node scripts/drafts.js --generate --dry-run
 *   node scripts/drafts.js --send <id>
 *   node scripts/drafts.js --kill <id>
 */

require('dotenv').config();
const db = require('../src/db');
const drafts = require('../src/drafts');

const argv = process.argv.slice(2);
const has = n => argv.includes(`--${n}`);
const flag = n => { const i = argv.indexOf(`--${n}`); return i !== -1 ? argv[i + 1] : null; };

function provider() {
  const { SendblueProvider } = require('../src/sendblue');
  return new SendblueProvider(
    process.env.SENDBLUE_API_KEY_ID,
    process.env.SENDBLUE_API_SECRET_KEY,
    { fromNumber: process.env.SENDBLUE_FROM_NUMBER }
  );
}

(async () => {
  if (has('generate')) {
    const { runWeeklyRecaps } = require('../src/weekly');
    const detail = await runWeeklyRecaps(provider(), { dryRun: has('dry-run') });
    console.log(JSON.stringify(detail, null, 2));
    return;
  }

  const sendId = flag('send');
  const killId = flag('kill');

  if (killId) {
    const row = await drafts.markRejected(Number(killId), { by: 'cli' });
    console.log(row ? `Killed draft ${row.id}.` : 'No pending draft with that id.');
    return;
  }

  if (sendId) {
    const { rows } = await db.query(
      `select d.*, l.name as league_name, l.chat_id, l.provider
       from recap_drafts d join leagues l on l.id = d.league_id
       where d.id = $1 and d.status = 'pending'`, [Number(sendId)]);
    const d = rows[0];
    if (!d) { console.error('No pending draft with that id.'); process.exitCode = 1; return; }
    if (!d.chat_id) { console.error(`${d.league_name} has no chat thread linked.`); process.exitCode = 1; return; }

    console.log(`Posting to ${d.league_name} (${d.chat_id}):\n\n${d.body}\n`);
    const res = await provider().send(d.chat_id, d.body);
    await drafts.markSent(d.id, { by: 'cli', messageId: res?.message_handle || null });
    await db.recordMessage({
      leagueId: d.league_id, provider: d.provider, providerMessageId: res?.message_handle || null,
      direction: 'outbound', chatId: d.chat_id, senderPhone: null, isGroup: true,
      protocol: null, body: d.body, raw: { source: 'recap_draft', draft_id: d.id, approved_by: 'cli' },
      occurredAt: Date.now(),
    });
    console.log(`${res.status} — draft ${d.id} marked sent.`);
    return;
  }

  const { rows: leagues } = await db.query('select id, name, config, chat_id from leagues order by created_at');
  for (const l of leagues) {
    const owners = drafts.ownersOf(l);
    console.log(`\n${l.name}`);
    console.log(`  owners: ${owners.length ? owners.join(', ') : '(none — set config.ownerPhone)'}`);
    console.log(`  autoPost: ${drafts.autoPostEnabled(l) ? 'ON' : 'off'}   thread: ${l.chat_id || '(unlinked)'}`);
    const rows = await drafts.recent(l.id, 8);
    if (!rows.length) { console.log('  no drafts yet'); continue; }
    for (const d of rows) {
      console.log(`  #${String(d.id).padEnd(4)} wk ${String(d.week).padStart(2)}  ${d.status.padEnd(9)} ${d.preview.replace(/\s+/g, ' ').slice(0, 60)}...`);
    }
  }
  console.log('\nApprove from your phone by replying SEND, or here with --send <id>.');
})()
  .catch(err => { console.error('ERROR:', err.message); process.exitCode = 1; })
  .finally(() => db.pool.end().catch(() => {}));
