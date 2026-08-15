/**
 * Collect inbound messages into bursts before deciding.
 *
 * Group chats arrive in flurries. Evaluating each message independently means
 * the bot can reply five times to what was one thought, and it splits messages
 * that belong together — "@bot" followed two seconds later by "who do I start
 * at flex" is one question, not a mention with no content plus a question with
 * no addressee.
 *
 * Two timers, because either alone misbehaves:
 *   quietMs  — flush once the thread goes quiet (the common case)
 *   maxWaitMs — flush anyway during a sustained flurry, so a busy Sunday thread
 *               does not defer the bot indefinitely
 *
 * At a 10s poll interval a few extra seconds of latency is invisible, and a
 * slightly delayed reply reads more naturally than an instant one.
 */

class BurstCollector {
  /**
   * @param onBurst  async (chatId, messages[]) => void
   */
  constructor({ onBurst, quietMs = 8000, maxWaitMs = 30000 } = {}) {
    this.onBurst = onBurst;
    this.quietMs = quietMs;
    this.maxWaitMs = maxWaitMs;
    this.pending = new Map(); // chatId -> { messages, quietTimer, maxTimer, firstAt }
    this.stopped = false;
  }

  add(msg) {
    if (this.stopped) return;
    const key = String(msg.chatId);
    let entry = this.pending.get(key);

    if (!entry) {
      entry = { messages: [], quietTimer: null, maxTimer: null, firstAt: Date.now() };
      this.pending.set(key, entry);
      // The ceiling timer is set once, when the burst opens — resetting it
      // alongside the quiet timer would defeat its purpose entirely.
      entry.maxTimer = setTimeout(() => this.flush(key, 'max_wait'), this.maxWaitMs);
      if (entry.maxTimer.unref) entry.maxTimer.unref();
    }

    entry.messages.push(msg);

    if (entry.quietTimer) clearTimeout(entry.quietTimer);
    entry.quietTimer = setTimeout(() => this.flush(key, 'quiet'), this.quietMs);
    if (entry.quietTimer.unref) entry.quietTimer.unref();
  }

  /** Flush one chat's burst now. Safe to call twice; the second is a no-op. */
  async flush(chatId, trigger = 'manual') {
    const key = String(chatId);
    const entry = this.pending.get(key);
    if (!entry) return null;

    this.pending.delete(key);
    if (entry.quietTimer) clearTimeout(entry.quietTimer);
    if (entry.maxTimer) clearTimeout(entry.maxTimer);

    const messages = entry.messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    try {
      await this.onBurst(key, messages, { trigger, waitedMs: Date.now() - entry.firstAt });
    } catch (err) {
      console.error('[burst] handler threw:', err.message);
    }
    return messages;
  }

  /** Flush everything — call on shutdown so a pending burst is not dropped. */
  async flushAll(trigger = 'shutdown') {
    for (const key of [...this.pending.keys()]) await this.flush(key, trigger);
  }

  stop() {
    this.stopped = true;
    for (const entry of this.pending.values()) {
      if (entry.quietTimer) clearTimeout(entry.quietTimer);
      if (entry.maxTimer) clearTimeout(entry.maxTimer);
    }
    this.pending.clear();
  }

  get pendingCount() {
    return [...this.pending.values()].reduce((n, e) => n + e.messages.length, 0);
  }
}

module.exports = { BurstCollector };
