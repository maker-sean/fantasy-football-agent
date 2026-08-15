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
const observer = require('../src/observer');
const agent = require('../src/agent');

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
  observer.recordRaw(msg.raw, { source: 'poll', provider: 'sendblue' });
  observer.recordParsed(msg);

  const where = msg.isGroup ? `grp ${String(msg.chatId).slice(0, 24)}` : '1:1';
  console.log(`[in] ${new Date(msg.timestamp).toISOString().slice(11, 19)} ${msg.senderId} ${msg.protocol} ${where}`);
  console.log(`     ${JSON.stringify(String(msg.text || '').slice(0, 90))}`);

  if (db) {
    try {
      const league = await db.leagueByChat('sendblue', msg.chatId);
      const row = await db.recordMessage({
        leagueId: league?.id || null,
        provider: 'sendblue',
        providerMessageId: msg.messageId,
        direction: 'inbound',
        chatId: msg.chatId,
        senderPhone: msg.senderId,
        isGroup: msg.isGroup,
        protocol: msg.protocol,
        body: msg.text,
        raw: msg.raw,
        occurredAt: msg.timestamp,
      });
      if (!row) console.log('     (duplicate, not stored)');
      else if (!league) console.log('     (stored, UNROUTED — no league for this chat)');
    } catch (err) {
      console.error('     [db]', err.message);
    }
  }

  if (!ECHO) return;

  const reply = await agent.runAgent({ id: 'poll' }, msg);
  if (!reply) return;

  const gate = agent.allowedToSend(msg.chatId);
  if (!gate.ok) return console.log(`     [rate] suppressed: ${gate.reason}`);

  try {
    await provider.send(msg.chatId, reply);
    agent.noteSend(msg.chatId);
    console.log(`[out] ${JSON.stringify(reply)}`);
  } catch (err) {
    console.error('[out] failed:', err.message);
  }
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
