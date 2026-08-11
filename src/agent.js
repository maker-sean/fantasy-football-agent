/**
 * The agent — STUB. Deliberately not wired to an LLM yet.
 *
 * Milestone 2 replaces the body of runAgent with real league context + an
 * Anthropic call. It stays stubbed until Milestone 0 proves the group surface
 * works, because a brain sitting on a fragmented transport is wasted work.
 *
 * Two policies that are NOT optional later:
 *   - reply-first: respond on address/trigger, not to every line
 *   - rate-limited: chatty automated numbers get flagged and deregistered
 */

const RATE = {
  minGapMs: 20_000,      // never two sends to the same chat inside this window
  maxPerHour: 12,
};

const sendHistory = new Map(); // chatId -> number[] (timestamps)

function allowedToSend(chatId, now = Date.now()) {
  const hist = (sendHistory.get(chatId) || []).filter(t => now - t < 3_600_000);
  sendHistory.set(chatId, hist);
  if (hist.length >= RATE.maxPerHour) return { ok: false, reason: 'hourly cap' };
  const last = hist[hist.length - 1];
  if (last && now - last < RATE.minGapMs) return { ok: false, reason: 'min gap' };
  return { ok: true };
}

function noteSend(chatId, now = Date.now()) {
  const hist = sendHistory.get(chatId) || [];
  hist.push(now);
  sendHistory.set(chatId, hist);
}

const TRIGGERS = ['@bot', 'commish'];

async function runAgent(league, msg) {
  const text = (msg.text || '').toLowerCase();
  if (!TRIGGERS.some(t => text.includes(t))) return null;   // stay quiet

  // M0/M1: prove the send path lands in the one thread. Echo back enough that
  // a human reading the group can confirm the bot saw the right sender.
  return `heard you, ${msg.senderId} (via ${msg.protocol}). agent brain not wired yet.`;
}

module.exports = { runAgent, allowedToSend, noteSend, RATE, TRIGGERS };
