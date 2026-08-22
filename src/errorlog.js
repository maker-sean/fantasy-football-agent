/**
 * One place every failure gets written down.
 *
 * Deliberately tiny, and deliberately incapable of making anything worse.
 * Recording an error must never throw, never block, and never change what the
 * caller was going to do — a metrics table that can turn a handled 400 into an
 * unhandled 500 is a liability, not observability.
 *
 * Fire and forget: callers do not await this. The row lands a few milliseconds
 * after the response does, which is soon enough for a dashboard and far better
 * than adding a database round trip to every error path.
 */

const MAX = 1000;   // messages get long; a stack trace is not the point here.

function record({ system, operation = null, status = null, message, leagueId = null, detail = {} }) {
  if (!message) return;

  /*
   * The test suite must not fill the operator's error board.
   *
   * Half of these tests assert on failure — a 404 for another account's league,
   * a 400 for a malformed phone, a rejected token — and every one of them is a
   * PASS. Recording them would put fourteen fabricated production errors on the
   * dashboard after each run, which is worse than having no dashboard: it
   * teaches an operator that the red numbers are noise.
   */
  if (process.env.NODE_ENV === 'test') return;
  try {
    const db = require('./db');
    db.query(
      `insert into error_log (system, operation, status, message, league_id, detail)
       values ($1,$2,$3,$4,$5,$6)`,
      [system, operation, status, String(message).slice(0, MAX), leagueId, detail]
    ).catch(err => console.error('[errorlog] insert failed:', err.message));
  } catch (err) {
    console.error('[errorlog] unavailable:', err.message);
  }
}

module.exports = { record };
