#!/usr/bin/env node
/**
 * Show received messages.
 *
 * Reads Postgres when DATABASE_URL is set, and falls back to the raw webhook
 * log otherwise — the raw log is written before parsing, so it is ground truth
 * even when a payload arrives in a shape the parser did not expect.
 *
 * Usage:
 *   node scripts/messages.js              last 20
 *   node scripts/messages.js --watch      poll every 3s
 *   node scripts/messages.js --raw        force the jsonl file
 *   node scripts/messages.js --limit 50
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const has = f => argv.includes(`--${f}`);
const flag = f => { const i = argv.indexOf(`--${f}`); return i !== -1 ? argv[i + 1] : null; };

const LIMIT = Number(flag('limit') || 20);
const RAW_LOG = path.join(__dirname, '..', 'logs', 'webhooks.jsonl');
const useDb = Boolean(process.env.DATABASE_URL) && !has('raw');

const stamp = d => new Date(d).toISOString().replace('T', ' ').slice(5, 19);

function line(m) {
  const dir = m.direction === 'outbound' ? '->' : '<-';
  const who = m.sender_phone || '(bot)';
  const where = m.is_group ? `grp ${String(m.chat_id).slice(0, 22)}` : '1:1';
  const league = m.league_id ? '' : '  [UNROUTED]';
  return `${stamp(m.occurred_at)}  ${dir} ${String(who).padEnd(13)} ${String(m.protocol || '?').padEnd(8)} ${where}${league}\n     ${JSON.stringify(String(m.body || '').slice(0, 80))}`;
}

async function fromDb(sinceId = 0) {
  const db = require('../src/db');
  const { rows } = await db.query(
    `select id, league_id, direction, chat_id, sender_phone, is_group, protocol, body, occurred_at
     from messages where id > $1 order by id desc limit $2`,
    [sinceId, LIMIT]
  );
  return rows.reverse();
}

function fromRaw() {
  if (!fs.existsSync(RAW_LOG)) return [];
  const lines = fs.readFileSync(RAW_LOG, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-LIMIT).map(l => {
    const e = JSON.parse(l);
    const b = e.body || {};
    // Handles both provider shapes: Sendblue uses from_number/content/group_id,
    // Blooio uses sender/text/external_id.
    return {
      direction: 'inbound',
      sender_phone: b.from_number || b.sender || null,
      chat_id: b.group_id || b.external_id || b.from_number || null,
      is_group: Boolean(b.group_id || b.is_group),
      protocol: (b.service || b.protocol || '').toLowerCase() || null,
      body: b.content ?? b.text ?? null,
      occurred_at: e.received_at,
      league_id: null,
    };
  });
}

async function show(sinceId) {
  const rows = useDb ? await fromDb(sinceId) : fromRaw();
  for (const r of rows) console.log(line(r));
  return rows.length ? Math.max(...rows.map(r => r.id || 0)) : sinceId;
}

(async () => {
  console.log(useDb ? 'source: postgres' : `source: ${RAW_LOG}`);
  if (!useDb && process.env.DATABASE_URL) console.log('(--raw forced)');
  if (!useDb && !process.env.DATABASE_URL) {
    console.log('DATABASE_URL not set — reading the raw log. Messages are NOT being persisted.');
  }
  console.log('');

  let since = await show(0);

  if (!has('watch')) {
    if (!since && !fromRaw().length) {
      console.log('No messages yet.\n');
      console.log('For inbound to reach you, ALL of these must be true:');
      console.log('  1. npm start                             (receiver running)');
      console.log('  2. npx cloudflared tunnel --url http://localhost:3000');
      console.log('  3. sendblue webhooks set-receive <tunnel-url>/webhooks/sendblue');
      console.log('  4. someone actually replies in the group');
      console.log('\nVerify 3 with:  node scripts/sendblue-webhooks.js list');
    }
    if (useDb) await require('../src/db').pool.end();
    return;
  }

  console.log('\n--- watching (ctrl-c to stop) ---');
  setInterval(async () => {
    try {
      const next = await show(since);
      since = next || since;
    } catch (err) {
      console.error('[watch]', err.message);
    }
  }, 3000);
})().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
