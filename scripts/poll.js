#!/usr/bin/env node
/**
 * Inbound via polling — the working path for group messages on Sendblue.
 *
 * Sendblue does not fire receive webhooks for group messages (measured
 * 2026-08-15), and the product lives in a group. This replaces the webhook for
 * inbound and needs no tunnel and no public URL.
 *
 * Usage:
 *   node scripts/poll.js --once          one poll, print what is new
 *   node scripts/poll.js                 run continuously
 *   node scripts/poll.js --replay        emit existing history instead of skipping it
 *   node scripts/poll.js --echo          let the agent reply (off by default)
 *   node scripts/poll.js --interval 5    seconds between polls
 */

require('dotenv').config();

const { SendblueProvider } = require('../src/sendblue');
const poller = require('../src/poller');
const inbound = require('../src/inbound');

const argv = process.argv.slice(2);
const has = f => argv.includes(`--${f}`);
const flag = f => { const i = argv.indexOf(`--${f}`); return i !== -1 ? argv[i + 1] : null; };

const ECHO = has('echo');
const INTERVAL = Number(flag('interval') || 10) * 1000;
const PERSIST = Boolean(process.env.DATABASE_URL);

const provider = new SendblueProvider(
  process.env.SENDBLUE_API_KEY_ID,
  process.env.SENDBLUE_API_SECRET_KEY,
  { fromNumber: process.env.SENDBLUE_FROM_NUMBER }
);

let db = null;
if (PERSIST) db = require('../src/db');

async function onMessage(msg) {
  const result = await inbound.handleInbound(msg, provider, {
    providerName: 'sendblue',
    echo: ECHO,
    source: 'poll-script',
  });
  console.log('[in] ' + inbound.describe(msg, result));
}

(async () => {
  console.log(`polling Sendblue every ${INTERVAL / 1000}s`);
  console.log(`  echo    ${ECHO ? 'ON — the agent will reply in the real thread' : 'off (--echo to enable)'}`);
  console.log(`  persist ${PERSIST ? 'postgres' : 'OFF — set DATABASE_URL'}`);
  console.log(`  cursor  ${poller.CURSOR_FILE}\n`);

  if (has('once')) {
    const cursor = poller.loadCursor();
    const events = await poller.pollOnce(provider, cursor, { bootstrap: false });
    if (!events.length) console.log('(nothing new since the last poll)');
    for (const e of events) await onMessage(e);
    if (db) await db.pool.end();
    return;
  }

  const stop = poller.startPolling(provider, onMessage, {
    intervalMs: INTERVAL,
    bootstrap: !has('replay'),
  });

  const shutdown = async () => {
    stop();
    console.log('\nstopped.');
    if (db) await db.pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
