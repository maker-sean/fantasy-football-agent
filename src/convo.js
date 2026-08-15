/**
 * Conversational state, derived from the messages table rather than kept
 * alongside it.
 *
 * A separate counters table would drift the first time a write failed or a
 * process restarted mid-burst, and a bot whose rate limiter thinks it has been
 * quiet when it has not is exactly the bug that gets a number muted. The
 * messages table is already the source of truth; these are queries over it.
 */

const db = require('./db');

const MINUTE = 60 * 1000;

/**
 * @param chatId   provider chat/group id
 * @param provider 'sendblue' | 'blooio'
 * @param now      ms epoch (injectable for tests and replay)
 */
async function conversationState(chatId, provider, now = Date.now()) {
  const { rows } = await db.query(
    `select direction, sender_phone, occurred_at
     from messages
     where provider = $1 and chat_id = $2
     order by occurred_at desc
     limit 200`,
    [provider, chatId]
  );

  const msgs = rows.map(r => ({
    direction: r.direction,
    sender: r.sender_phone,
    at: new Date(r.occurred_at).getTime(),
  }));

  const lastBot = msgs.find(m => m.direction === 'outbound') || null;
  const lastBotAt = lastBot ? lastBot.at : null;

  // Consecutive bot messages with no human between them. The single best
  // signal that the bot is talking to itself.
  let botStreak = 0;
  for (const m of msgs) {
    if (m.direction === 'outbound') botStreak += 1;
    else break;
  }

  const humansSinceBot = lastBotAt
    ? msgs.filter(m => m.direction === 'inbound' && m.at > lastBotAt).length
    : msgs.filter(m => m.direction === 'inbound').length;

  const sentInLastHour = msgs.filter(m => m.direction === 'outbound' && now - m.at < 60 * MINUTE).length;
  const sentToday = msgs.filter(m => m.direction === 'outbound' && now - m.at < 24 * 60 * MINUTE).length;

  // Thread temperature: how alive the conversation is right now.
  //
  // This inverts the naive rule. The bot is most valuable speaking into a dead
  // thread and least valuable interrupting a live one — the whole premise is
  // that league chatter dies off. Layers 2+ read this; Layer 1 does not, because
  // a direct mention outranks any notion of politeness.
  const recent = n => msgs.filter(m => m.direction === 'inbound' && now - m.at < n * MINUTE).length;
  const inbound5 = recent(5);
  const inbound60 = recent(60);
  const distinct60 = new Set(
    msgs.filter(m => m.direction === 'inbound' && now - m.at < 60 * MINUTE).map(m => m.sender)
  ).size;

  return {
    chatId,
    provider,
    now,
    totalSeen: msgs.length,
    lastBotAt,
    msSinceLastBot: lastBotAt == null ? null : now - lastBotAt,
    botStreak,
    humansSinceBot,
    sentInLastHour,
    sentToday,
    inbound5,
    inbound60,
    distinctSpeakers60: distinct60,
    // hot: multiple people actively going back and forth
    temperature: inbound5 >= 4 && distinct60 >= 2 ? 'hot'
      : inbound60 >= 3 ? 'warm'
      : 'cold',
  };
}

module.exports = { conversationState, MINUTE };
