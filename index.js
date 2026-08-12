/**
 * Fantasy League Agent — Milestone 0 instrument + Milestone 1 echo.
 *
 * Run:
 *   npm install
 *   cp .env.example .env   # fill in BLOOIO_API_KEY
 *   npm start
 *   npx cloudflared tunnel --url http://localhost:3000
 *   Register <tunnel-url>/webhooks/blooio in the Blooio dashboard.
 *
 * Then run the M0 test (see README) and read GET /m0 for the verdict.
 */

require('dotenv').config();

const express = require('express');
const crypto = require('crypto');

const { BlooioProvider } = require('./src/provider');
const { SendblueProvider } = require('./src/sendblue');
const { registerLeague, leagueByChat, allLeagues } = require('./src/leagues');
const { runAgent, allowedToSend, noteSend } = require('./src/agent');
const observer = require('./src/observer');

const PORT = Number(process.env.PORT || 3000);
// M0 mode accepts inbound from chats we haven't registered yet. This is the
// whole point: we do not know the group's chat id until we observe it. Turning
// this off before M0 passes would drop exactly the data we're trying to collect.
const M0_MODE = process.env.M0_MODE !== 'false';
const ECHO = process.env.ECHO !== 'false';

// Two transports, same downstream code. Each is constructed only if configured,
// so a missing key for one never blocks the other.
const provider = process.env.BLOOIO_API_KEY
  ? new BlooioProvider(process.env.BLOOIO_API_KEY)
  : null;

const sendblue = (process.env.SENDBLUE_API_KEY_ID && process.env.SENDBLUE_API_SECRET_KEY)
  ? new SendblueProvider(
      process.env.SENDBLUE_API_KEY_ID,
      process.env.SENDBLUE_API_SECRET_KEY,
      { fromNumber: process.env.SENDBLUE_FROM_NUMBER }
    )
  : null;

if (process.env.TEST_CHAT_ID) {
  registerLeague('my-league', process.env.TEST_CHAT_ID, { name: 'Test League' });
}

async function handleInbound(msg, activeProvider = provider) {
  if (msg.type !== 'message.received') return;    // ignore delivery/read events

  const league = leagueByChat(msg.chatId);
  if (!league && !M0_MODE) {
    return console.warn('[inbound] unregistered chat, dropping:', msg.chatId);
  }
  if (!league) {
    console.log(`[m0] inbound from UNREGISTERED chat ${msg.chatId} — observing anyway`);
  }

  if (!ECHO) return;

  const reply = await runAgent(league || { id: '(unregistered)' }, msg);
  if (!reply) return;

  const gate = allowedToSend(msg.chatId);
  if (!gate.ok) return console.log(`[rate] suppressed reply to ${msg.chatId}: ${gate.reason}`);

  if (!activeProvider) return console.warn('[send] no provider configured; skipping reply');

  try {
    await activeProvider.send(msg.chatId, reply, {
      idempotencyKey: `reply-${msg.messageId || crypto.randomUUID()}`,
    });
    noteSend(msg.chatId);
    console.log(`[send] -> ${msg.chatId}: ${JSON.stringify(reply)}`);
  } catch (err) {
    console.error('[send] failed:', err.message);
  }
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.post('/webhooks/blooio', (req, res) => {
  res.sendStatus(200);                    // ack fast, process after

  // Record the body VERBATIM before any parsing — if our field-name assumptions
  // are wrong, this file is the ground truth that tells us so.
  observer.recordRaw(req.body, {
    'content-type': req.get('content-type'),
    'user-agent': req.get('user-agent'),
    // Capture whatever signature header Blooio sends so we can identify the
    // scheme for Milestone 4. TODO(prod): verify it before trusting the body.
    ...Object.fromEntries(
      Object.entries(req.headers).filter(([k]) => /sign|hmac|digest|timestamp/i.test(k))
    ),
  });

  let msg;
  try {
    msg = provider.parseInbound(req.body);
  } catch (err) {
    return console.error('[parse] failed:', err.message, req.body);
  }

  observer.recordParsed(msg);
  console.log('[inbound]', observer.describe(msg));

  handleInbound(msg).catch(err => console.error('[handleInbound]', err));
});

/**
 * Sendblue inbound. Register with:
 *   sendblue webhooks set-receive <tunnel-url>/webhooks/sendblue
 *
 * Sendblue posts inbound messages and status callbacks to different URLs and
 * puts no event type in the body, so the type comes from the route.
 */
app.post('/webhooks/sendblue', (req, res) => {
  res.sendStatus(200);

  observer.recordRaw(req.body, {
    provider: 'sendblue',
    'content-type': req.get('content-type'),
    ...Object.fromEntries(
      Object.entries(req.headers).filter(([k]) => /sign|hmac|digest|timestamp/i.test(k))
    ),
  });

  if (!sendblue) return console.warn('[sendblue] inbound but provider not configured');

  let msg;
  try {
    msg = sendblue.parseInbound(req.body);
  } catch (err) {
    return console.error('[sendblue parse] failed:', err.message, req.body);
  }

  observer.recordParsed(msg);
  console.log('[sendblue inbound]', observer.describe(msg));

  handleInbound(msg, sendblue).catch(err => console.error('[handleInbound sendblue]', err));
});

/** The Milestone 0 verdict. Hit this after everyone has posted to the group. */
app.get('/m0', (_req, res) => res.json(observer.verdict()));

app.get('/leagues', (_req, res) => res.json(allLeagues()));

app.get('/health', (_req, res) => res.json({ ok: true, m0Mode: M0_MODE, echo: ECHO }));

app.listen(PORT, () => {
  console.log(`listening on :${PORT}`);
  console.log(`  webhook  POST /webhooks/blooio`);
  console.log(`  verdict  GET  /m0`);
  console.log(`  raw log  ${observer.RAW_LOG}`);
  console.log(`  m0Mode=${M0_MODE} echo=${ECHO}`);
});
