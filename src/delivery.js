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
async function reconcile(provider, { limit = 50, windowHours = 6,
  retryWithinMs = 15 * 60 * 1000, maxRetries = 3 } = {}) {
  if (!provider) return { checked: 0, failures: [] };

  const { rows: unchecked } = await db.query(
    `select id, message_handle, chat_id, is_group, at, is_retry, retry_count, league_id
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

    // Landed: drop the handle so nothing can revisit this decision. Leaving it
    // set would let a much later lookup of the same handle un-welcome a league
    // that has been talking happily for a month.
    if (!FAILED.has(state) && row.message_handle) {
      await db.query(
        'update leagues set welcome_message_handle = null where welcome_message_handle = $1',
        [row.message_handle]).catch(() => {});
    }

    if (FAILED.has(state)) {
      const failure = {
        id: row.id, chatId: row.chat_id, isGroup: row.is_group, at: row.at,
        state, code: m.error_code || null,
        message: m.error_message || m.error_detail || null,
        service: m.service || null,
        preview: String(m.content || '').slice(0, 80),
        retried: false,
      };

      /*
       * THE INTRODUCTION IS UN-STAMPED, NOT RESENT — and it is checked first,
       * because doing both would introduce the league twice.
       *
       * welcomed_at is set optimistically the moment Sendblue accepts the send:
       * reconciliation is a six minute poll and blocking a league's first
       * message on it would time out every time. That is only safe if something
       * takes the stamp back when the send turns out to have failed, or the
       * guard against introducing a league twice becomes a guarantee it is
       * never introduced once. Sigma Chi Dynasty on 2026-08-24 is that bug.
       *
       * Un-stamping rather than retrying here, because welcome.js composes the
       * text — with the roll call and the contact card — and rebuilding it is
       * better than resending a stale copy Sendblue happens to be holding. It
       * goes out on the worker's next cycle.
       *
       * Scoped by handle, so a failed recap cannot un-welcome a league that was
       * introduced perfectly well last week.
       */
      const undone = await db.query(
        `update leagues set welcomed_at = null, welcome_message_handle = null
          where welcome_message_handle = $1`, [row.message_handle]).catch(() => null);
      const wasWelcome = Boolean(undone?.rowCount);
      if (wasWelcome) {
        failure.unwelcomed = true;
        console.warn('[delivery] the introduction never landed; that league will be welcomed again');
      }

      /*
       * Otherwise: resend, more than once for the group transport failure,
       * because it flaps rather than fails.
       *
       * On 2026-08-24 a league's sends failed 5504 at 01:45, 01:48 and 01:54
       * and one went through cleanly at 01:51. A single retry inside fifteen
       * minutes is the right shape and the wrong number against a roughly even
       * success rate — the message that lands is the one tried a third time.
       * 5504 is Sendblue declining to guess the group's transport rather than
       * rejecting the content, and it does not retry on its own.
       *
       * The age limit is the real bargain and does the real limiting. A reply
       * landing a few minutes late is worth having; one landing an hour later
       * drops into a conversation that has moved on and reads worse than
       * silence. Counting attempts is belt and braces against a thread that can
       * never resolve its transport at all.
       *
       * The TEXT COMES FROM SENDBLUE. send_log stores no body, and their record
       * of what was attempted is the thing that failed, so it is also the right
       * thing to send again.
       */
      const ageMs = Date.now() - new Date(row.at).getTime();
      const transportFlap = /could not determine target service/i.test(
        String(m.error_message || m.error_detail || ''));
      // is_retry as the floor: every row written before retry_count existed has
      // it defaulted to 0, and a legacy retry row must not read as a fresh one.
      const attempts = Math.max(row.retry_count || 0, row.is_retry ? 1 : 0);
      const budget = transportFlap ? maxRetries : 1;
      const eligible = !wasWelcome && attempts < budget && ageMs <= retryWithinMs && m.content;
      if (eligible) {
        try {
          await provider.send(row.chat_id, String(m.content),
            { isRetry: true, retryCount: attempts + 1, leagueId: row.league_id });
          failure.retried = true;
          console.log(`[delivery] resent after ${state} on ${row.chat_id} (attempt ${attempts + 2})`);
        } catch (err) {
          failure.retryError = err.message;
          console.error('[delivery] retry failed:', err.message);
        }
        await db.query('update send_log set retried_at = now() where id = $1', [row.id])
          .catch(() => {});
      }

      failures.push(failure);
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
  /*
   * Says whether it was resent, because that changes what you do about it.
   * "Did not arrive" and "did not arrive, sent again" are different problems
   * and only one of them needs you.
   */
  const outcome = one.unwelcomed
    ? 'It was the introduction, so the league has been un-welcomed and it goes again next cycle.'
    : one.retried
    ? 'I sent it again.'
    : one.retryError ? `The resend also failed: ${one.retryError}`
    : 'Too old to resend automatically.';
  return `A message to the league did NOT arrive${rest}. ${outcome}\n\n`
       + `${one.state}${one.code ? ' ' + one.code : ''}: ${one.message || 'no detail'}\n`
       + `"${one.preview}"`;
}

module.exports = { reconcile, alertText, FAILED };
