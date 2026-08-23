/**
 * Sending somebody their setup link, from wherever the decision was made.
 *
 * There are now three places that decide to invite a league — the script, a
 * text reply, and a button on the dashboard — and the lesson of this codebase
 * is that three call sites drift. sendblue.js says it about send logging, and
 * today the welcome, the mute and the operator alert each broke because a
 * second path skipped the first path's rules. So the minting, the localhost
 * refusal, the send and the bookkeeping live here once.
 *
 * WHICH ONE. Two signups arriving close together makes a bare "INVITE"
 * ambiguous, and inviting the wrong league is not recoverable: the link signs
 * whoever holds it into an account. So a ref accompanies every alert and is
 * required whenever more than one is waiting. The ref is the last four digits
 * of their number, which is already visible in the alert, needs no schema, and
 * is stable no matter what else arrives in between — unlike a menu position,
 * which silently means something different once a new signup lands.
 */

const db = require('./db');
const onboardlink = require('./onboardlink');

/** Signups that can still be invited: on the waitlist, and textable. */
async function pending() {
  const { rows } = await db.query(
    `select id, phone, league_name, season, total_rosters, sleeper_league_id,
            status, source, created_at,
            first_name, last_name, email, platform, platform_other
       from signups
      where phone is not null
        and status = 'new'
      order by created_at asc`);
  return rows.map(r => ({ ...r, ref: String(r.phone).slice(-4) }));
}

/**
 * Resolve what somebody meant.
 *
 * Bare, with exactly one waiting, is unambiguous and the common case. Bare with
 * several waiting is refused rather than guessed at, because guessing wrong
 * sends a stranger a link that signs them into an account.
 */
async function resolve(ref, opts = {}) {
  // The list can be supplied, which keeps the choosing testable without a
  // database and without a test's fixtures competing with real signups.
  const waiting = opts.waiting || await pending();
  if (!waiting.length) return { error: 'none_pending', waiting };

  const wanted = String(ref || '').replace(/\D/g, '');
  if (!wanted) {
    if (waiting.length === 1) return { signup: waiting[0], waiting };
    return { error: 'ambiguous', waiting };
  }

  const hits = waiting.filter(s => String(s.phone).endsWith(wanted));
  if (!hits.length) return { error: 'no_match', waiting };
  // Two pending numbers ending the same way is unlikely and still has to fail
  // loudly rather than pick one.
  if (hits.length > 1) return { error: 'ambiguous', waiting: hits };
  return { signup: hits[0], waiting };
}

function messageFor({ leagueName, url, days }) {
  const league = leagueName ? ` Set up ${leagueName} here:` : ' Set up your league here:';
  return `Commish AI — you're up.${league}\n${url}\n\n`
       + `This link signs you in, so keep it to yourself. It expires in ${days} days.\n\n`
       + `Msg & data rates may apply. Reply STOP to opt out.`;   // no HELP: it answers nothing, see src/signup.js
}

/**
 * Mint the link and text it.
 *
 * Refuses a localhost base url for the same reason scripts/welcome.js does: by
 * the time anybody notices, it is already on somebody's phone. That refusal has
 * to live here rather than in the script, because the dashboard and the text
 * reply run on the worker and web service and would otherwise skip it.
 */
async function send(signupId, { provider, days = onboardlink.DEFAULT_TTL_DAYS, dryRun = false } = {}) {
  const { rows: [signup] } = await db.query('select * from signups where id = $1', [signupId]);
  if (!signup) return { sent: false, error: 'not_found' };
  if (!signup.phone) return { sent: false, error: 'no_phone' };

  const url = onboardlink.linkFor(signup.id, { days });
  if (/localhost|127\.0\.0\.1/.test(url)) return { sent: false, error: 'localhost_base_url', url };

  const text = messageFor({ leagueName: signup.league_name, url, days });
  if (dryRun) return { sent: false, dryRun: true, text, url, signup };
  if (!provider) return { sent: false, error: 'no_provider' };

  try {
    await provider.send(signup.phone, text);
  } catch (err) {
    return { sent: false, error: 'send_failed', detail: err.message };
  }

  /*
   * invited_at as well as status. Migration 0018 added the column and nothing
   * wrote it, so the funnel's "Sent a setup link" stage counted only rows the
   * backfill had touched. coalesce so a re-invite keeps first contact.
   */
  await db.query(
    `update signups
        set status = 'invited',
            invited_at = coalesce(invited_at, now()),
            updated_at = now()
      where id = $1`, [signup.id]);

  return { sent: true, signup, text, url };
}

module.exports = { pending, resolve, send, messageFor };
