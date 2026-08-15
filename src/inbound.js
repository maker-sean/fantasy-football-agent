/**
 * One inbound path, shared by every entry point.
 *
 * Three things can deliver a message now — the web webhook route (1:1 only,
 * since Sendblue does not push group messages), `scripts/poll.js`, and the
 * worker's poll loop. They must behave identically, so the logic lives here
 * rather than being copied three times and drifting.
 *
 * Order matters: observe, then persist, then decide whether to reply. A
 * persistence failure must never swallow the message or block a reply.
 */

const observer = require('./observer');
const agent = require('./agent');

const PERSIST = Boolean(process.env.DATABASE_URL);
const db = PERSIST ? require('./db') : null;

/**
 * @param msg      normalized event (see provider.parseInbound / poller.toEvent)
 * @param provider MessagingProvider used for any reply
 * @param opts.providerName  'sendblue' | 'blooio'
 * @param opts.echo          allow the agent to reply
 * @param opts.recordRaw     log the verbatim payload (webhook route already did)
 */
async function handleInbound(msg, provider, opts = {}) {
  const { providerName = 'sendblue', echo = false, recordRaw = true } = opts;

  if (msg.type && msg.type !== 'message.received') return { skipped: 'not a received message' };

  if (recordRaw) observer.recordRaw(msg.raw, { source: opts.source || 'poll', provider: providerName });
  observer.recordParsed(msg);

  const result = { stored: false, duplicate: false, league: null, replied: false };

  if (db) {
    try {
      const league = await db.leagueByChat(providerName, msg.chatId);
      result.league = league?.name || null;
      const row = await db.recordMessage({
        leagueId: league?.id || null,
        provider: providerName,
        providerMessageId: msg.messageId,
        direction: 'inbound',
        chatId: msg.chatId,
        senderPhone: msg.senderId,
        isGroup: msg.isGroup,
        protocol: msg.protocol,
        body: msg.text,
        raw: msg.raw || {},
        occurredAt: msg.timestamp,
      });
      result.stored = Boolean(row);
      result.duplicate = !row;
    } catch (err) {
      // A dropped log line is bad; a dropped conversation is worse.
      console.error('[inbound] persist failed:', err.message);
      result.error = err.message;
    }
  }

  if (!echo) return result;

  const reply = await agent.runAgent({ id: result.league || 'unrouted' }, msg);
  if (!reply) return result;

  const gate = agent.allowedToSend(msg.chatId);
  if (!gate.ok) {
    result.suppressed = gate.reason;
    return result;
  }

  try {
    await provider.send(msg.chatId, reply);
    agent.noteSend(msg.chatId);
    result.replied = reply;

    // Record our own message too — Phase 2's metric is human replies PER BOT
    // MESSAGE, which is uncomputable without the denominator.
    if (db) {
      const league = await db.leagueByChat(providerName, msg.chatId);
      await db.recordMessage({
        leagueId: league?.id || null,
        provider: providerName,
        providerMessageId: null,
        direction: 'outbound',
        chatId: msg.chatId,
        senderPhone: null,
        isGroup: msg.isGroup,
        protocol: msg.protocol,
        body: reply,
        raw: { reply_to: msg.messageId },
        occurredAt: Date.now(),
      });
    }
  } catch (err) {
    console.error('[inbound] reply failed:', err.message);
    result.error = err.message;
  }

  return result;
}

/** One-line log for a handled message. */
function describe(msg, result) {
  const where = msg.isGroup ? `grp ${String(msg.chatId).slice(0, 22)}` : '1:1';
  const tags = [
    result.duplicate ? 'dup' : (result.stored ? 'stored' : 'not-stored'),
    result.league ? result.league : 'UNROUTED',
    result.suppressed ? `rate:${result.suppressed}` : null,
    result.replied ? 'REPLIED' : null,
  ].filter(Boolean).join(' ');

  return `${new Date(msg.timestamp).toISOString().slice(11, 19)} ${msg.senderId} ${msg.protocol} ${where}  [${tags}]\n     ${JSON.stringify(String(msg.text || '').slice(0, 88))}`;
}

module.exports = { handleInbound, describe, PERSIST };
