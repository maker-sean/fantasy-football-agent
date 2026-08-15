/**
 * Poll Sendblue for inbound messages.
 *
 * MEASURED 2026-08-15: Sendblue's `receive` webhook does NOT fire for group
 * messages. A 1:1 (`message_type: "message"`) delivers a webhook; group
 * messages (`message_type: "group"`) never do, even with a verified receive
 * webhook registered and reachable. Every group reply IS recorded server-side
 * and readable at GET /api/v2/messages with a correct, stable group_id.
 *
 * Since the entire product lives in a group thread, webhooks cannot drive the
 * reactive path on this provider. Polling is the transport for inbound.
 *
 * This is not purely a downgrade:
 *   - no public URL, no tunnel, no re-registering a URL that changes hourly
 *   - survives restarts via a durable cursor instead of losing anything sent
 *     while the receiver was down
 *   - one code path for group and 1:1
 * The cost is latency (one poll interval) and API calls.
 */

const fs = require('fs');
const path = require('path');

const CURSOR_FILE = path.join(__dirname, '..', 'logs', 'poll-cursor.json');

/** Cursor = the set of message_handles already seen, plus the newest timestamp. */
function loadCursor() {
  try {
    const raw = JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf8'));
    return { since: raw.since || null, seen: new Set(raw.seen || []) };
  } catch {
    return { since: null, seen: new Set() };
  }
}

function saveCursor(cursor) {
  fs.mkdirSync(path.dirname(CURSOR_FILE), { recursive: true });
  fs.writeFileSync(CURSOR_FILE, JSON.stringify({
    since: cursor.since,
    // Bound the set; handles far older than the cursor can't recur.
    seen: [...cursor.seen].slice(-500),
  }, null, 2));
}

/**
 * Convert a Sendblue message row into the same shape parseInbound produces, so
 * everything downstream is identical whether it came from a webhook or a poll.
 */
function toEvent(m) {
  const service = String(m.service || '').toLowerCase();
  return {
    type: 'message.received',
    chatId: m.group_id || m.from_number,
    senderId: m.from_number,
    text: m.content,
    isGroup: Boolean(m.group_id) || m.message_type === 'group',
    protocol: service === 'imessage' ? 'imessage' : service,
    messageId: m.message_handle,
    ourNumber: m.to_number || m.sendblue_number,
    timestamp: m.date_sent ? Date.parse(m.date_sent) : Date.now(),
    raw: m,
  };
}

/**
 * One poll. Returns new inbound events, oldest first.
 * `bootstrap: true` marks everything currently present as seen without
 * emitting — so starting the poller doesn't replay weeks of history into the
 * agent and blast the group with catch-up replies.
 */
async function pollOnce(provider, cursor, { limit = 25, bootstrap = false } = {}) {
  const res = await provider.request('GET', `/api/v2/messages?limit=${limit}`);
  const rows = res?.messages || res?.data || (Array.isArray(res) ? res : []);

  const inbound = rows.filter(m => !m.is_outbound);
  const fresh = [];

  for (const m of inbound) {
    const handle = m.message_handle;
    if (!handle || cursor.seen.has(handle)) continue;
    cursor.seen.add(handle);
    if (!bootstrap) fresh.push(toEvent(m));
    const ts = m.date_sent;
    if (ts && (!cursor.since || ts > cursor.since)) cursor.since = ts;
  }

  fresh.sort((a, b) => a.timestamp - b.timestamp);
  saveCursor(cursor);
  return fresh;
}

/**
 * Long-running loop. `onMessage` receives one normalized event at a time.
 * Errors are logged and retried rather than killing the loop — a transient 500
 * must not silently stop inbound for the rest of the day.
 */
function startPolling(provider, onMessage, { intervalMs = 10_000, bootstrap = true } = {}) {
  const cursor = loadCursor();
  let stopped = false;
  let consecutiveErrors = 0;

  const tick = async () => {
    if (stopped) return;
    try {
      const isFirst = bootstrap && !cursor.since && cursor.seen.size === 0;
      const events = await pollOnce(provider, cursor, { bootstrap: isFirst });
      consecutiveErrors = 0;
      if (isFirst) {
        console.log(`[poll] bootstrapped — ${cursor.seen.size} existing message(s) marked seen, not replayed`);
      }
      for (const e of events) {
        try { await onMessage(e); }
        catch (err) { console.error('[poll] handler threw:', err.message); }
      }
    } catch (err) {
      consecutiveErrors += 1;
      console.error(`[poll] failed (${consecutiveErrors}):`, err.message);
    } finally {
      if (!stopped) {
        // Back off on repeated failure, capped, so a provider outage doesn't
        // turn into a tight retry loop.
        const delay = consecutiveErrors > 2
          ? Math.min(intervalMs * 2 ** Math.min(consecutiveErrors - 2, 4), 300_000)
          : intervalMs;
        setTimeout(tick, delay);
      }
    }
  };

  tick();
  return () => { stopped = true; };
}

module.exports = { pollOnce, startPolling, loadCursor, saveCursor, toEvent, CURSOR_FILE };
