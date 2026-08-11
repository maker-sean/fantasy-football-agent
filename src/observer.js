/**
 * Milestone 0 instrument.
 *
 * The entire point of M0 is that we do NOT know what Blooio sends for a mixed
 * iMessage/RCS/SMS group. So this records every webhook body verbatim, before
 * any parsing, and keeps a running tally of the two things M0 is testing:
 *
 *   (a) do messages from the iPhone users AND the Android user arrive with the
 *       SAME chat id, and with the correct distinct sender?
 *   (b) does one reply to that chat id land in one thread for everyone?
 *
 * (b) is answered by human eyeballs on the group thread. (a) is answered here.
 */

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const RAW_LOG = path.join(LOG_DIR, 'webhooks.jsonl');

fs.mkdirSync(LOG_DIR, { recursive: true });

/** chatId -> { count, protocols:Set, senders:Set, isGroup, firstSeen, lastSeen } */
const chats = new Map();

function recordRaw(body, headers) {
  const line = JSON.stringify({
    received_at: new Date().toISOString(),
    headers,
    body,
  });
  fs.appendFile(RAW_LOG, line + '\n', err => {
    if (err) console.error('[observer] raw log write failed:', err.message);
  });
}

function recordParsed(msg) {
  const key = String(msg.chatId);
  if (!chats.has(key)) {
    chats.set(key, {
      count: 0,          // message.received only — the thing M0 is counting
      statusEvents: 0,   // delivery/read receipts, tracked separately
      protocols: new Set(),
      senders: new Set(),
      isGroup: msg.isGroup,
      firstSeen: new Date().toISOString(),
      lastSeen: null,
    });
  }
  const c = chats.get(key);
  if (msg.type === 'message.received') c.count += 1;
  else c.statusEvents += 1;
  c.lastSeen = new Date().toISOString();
  if (msg.protocol) c.protocols.add(msg.protocol);
  if (msg.senderId) c.senders.add(msg.senderId);
  c.isGroup = c.isGroup || msg.isGroup;
  return c;
}

/** Human-readable one-liner per inbound, so you can watch the terminal live. */
function describe(msg) {
  return [
    `event=${msg.type}`,
    `chatId=${msg.chatId}`,
    `sender=${msg.senderId}`,
    `protocol=${msg.protocol}`,
    `isGroup=${msg.isGroup}`,
    `text=${JSON.stringify(msg.text)}`,
  ].join('  ');
}

/**
 * The M0 verdict. Read this after everyone has sent a message to the group.
 *
 * PASS shape: exactly ONE chat id, isGroup true, >=2 distinct senders, and
 * protocols containing both an Apple and a non-Apple transport (or a single
 * unified protocol that still carried both people).
 *
 * FAIL shape: multiple chat ids for what is one human thread — the group
 * fragmented, and the in-group architecture does not survive a real league.
 */
function verdict() {
  const entries = [...chats].map(([chatId, c]) => ({
    chatId,
    messages: c.count,
    statusEvents: c.statusEvents,
    isGroup: c.isGroup,
    distinctSenders: [...c.senders],
    protocols: [...c.protocols],
    firstSeen: c.firstSeen,
    lastSeen: c.lastSeen,
  }));

  const groupChats = entries.filter(e => e.isGroup);
  const notes = [];

  if (entries.length === 0) {
    notes.push('NO INBOUND YET — nothing to judge. Send a message to the group.');
  } else if (groupChats.length === 0) {
    notes.push('NO GROUP INBOUND — every message arrived with is_group=false. The bot is not seeing the group thread.');
  } else if (groupChats.length > 1) {
    notes.push(`FRAGMENTED — ${groupChats.length} distinct group chat ids for what should be one thread. This is the M0 failure mode.`);
  } else {
    const g = groupChats[0];
    notes.push(`SINGLE GROUP CHAT ID: ${g.chatId}`);
    if (g.distinctSenders.length < 2) {
      notes.push(`Only ${g.distinctSenders.length} distinct sender so far — need at least one iPhone user AND the Android user.`);
    } else {
      notes.push(`${g.distinctSenders.length} distinct senders resolved correctly.`);
    }
    const apple = g.protocols.filter(p => /imessage/i.test(p));
    const other = g.protocols.filter(p => !/imessage/i.test(p));
    if (apple.length && other.length) {
      notes.push(`MIXED-DEVICE CONFIRMED on one chat id: protocols = ${g.protocols.join(', ')}`);
    } else {
      notes.push(`Protocols seen: ${g.protocols.join(', ') || '(none reported)'} — not yet proof of mixed-device.`);
    }
  }

  return { chats: entries, notes, rawLog: RAW_LOG };
}

module.exports = { recordRaw, recordParsed, describe, verdict, RAW_LOG };
