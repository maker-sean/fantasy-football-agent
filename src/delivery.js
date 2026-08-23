/**
 * Did it actually land?
 *
 * send_log.ok means Sendblue's API answered 200. That is acceptance, and the
 * distance between acceptance and delivery is where a reply to the league went
 * missing: recorded ok with status QUEUED, then failed at the device layer with
 *
 *   ERROR 5504  Could not determine target service for group;
 *               refusing to default to iMessage
 *
 * Every record this system keeps said that message went out. It never arrived,
 * and it was found because somebody read the chat and asked.
 *
 * WHY POLLING RATHER THAN A CALLBACK. sendblue.js already supports
 * status_callback and nothing has ever set it, which would mean a public
 * endpoint, a registration step in somebody else's dashboard, and a new way to
 * be silently misconfigured — the failure mode this exists to catch. Sendblue's
 * own message list carries the terminal state, the worker already runs cron,
 * and a poll that finds nothing costs one request.
 */

const db = require('./db');

/** Terminal states worth alerting on. */
const FAILED = new Set(['ERROR', 'DECLINED', 'FAILED']);

/**
 * Reconcile recent sends against what Sendblue says happened to them.
 *
 * Returns what it found, so the caller decides whether to shout. Deliberately
 * bounded: this reconciles the recent window rather than the whole table,
 * because a send nobody chased within the hour is history, not an incident.
 */
async function reconcile(provider, { limit = 50, windowHours = 6 } = {}) {
  if (!provider) return { checked: 0, failures: [] };

  const { rows: unchecked } = await db.query(
    `select id, message_handle, chat_id, is_group, at
       from send_log
      where message_handle is not null
        and delivery is null
        and at > now() - ($1 || ' hours')::interval
      order by at desc limit $2`, [String(windowHours), limit]);
  if (!unchecked.length) return { checked: 0, failures: [] };

  let feed;
  try {
    feed = await provider.fetchMessages({ limit: Math.max(limit, 50) });
  } catch (err) {
    console.error('[delivery] could not read Sendblue:', err.message);
    return { checked: 0, failures: [], error: err.message };
  }

  const byHandle = new Map();
  for (const m of feed.messages || []) {
    const h = m.message_handle || m.id;
    if (h) byHandle.set(String(h), m);
  }

  const failures = [];
  let checked = 0;
  for (const row of unchecked) {
    const m = byHandle.get(String(row.message_handle));
    if (!m) continue;                       // not resolved yet, look again later
    const state = String(m.status || '').toUpperCase();
    // Still in flight. Leaving delivery null means the next pass rechecks it,
    // which is the point: a QUEUED that never resolves is itself the signal.
    if (!state || ['QUEUED', 'PENDING', 'REGISTERED', 'ACCEPTED'].includes(state)) continue;

    await db.query(
      `update send_log set delivery = $2, checked_at = now(),
              error = coalesce(error, $3)
        where id = $1`,
      [row.id, state, m.error_message ? String(m.error_message).slice(0, 500) : null]);
    checked++;

    if (FAILED.has(state)) {
      failures.push({
        id: row.id, chatId: row.chat_id, isGroup: row.is_group, at: row.at,
        state, code: m.error_code || null,
        message: m.error_message || m.error_detail || null,
        service: m.service || null,
        preview: String(m.content || '').slice(0, 80),
      });
      require('./errorlog').record({
        system: 'sendblue', operation: 'delivery',
        status: m.error_code || null,
        message: `${state}: ${m.error_message || 'no detail'}`,
      });
    }
  }
  return { checked, failures };
}

/** One line an operator can act on, or null when everything landed. */
function alertText(failures) {
  if (!failures?.length) return null;
  const one = failures[0];
  const rest = failures.length > 1 ? ` (and ${failures.length - 1} more)` : '';
  return `A message to the league did NOT arrive${rest}.\n\n`
       + `${one.state}${one.code ? ' ' + one.code : ''}: ${one.message || 'no detail'}\n`
       + `"${one.preview}"`;
}

module.exports = { reconcile, alertText, FAILED };
