/**
 * Tell the operator something happened.
 *
 * A signup landed at 01:50 and the only trace of it was a console.log in the
 * worker's output. The admin dashboard shows signup COUNTS — last hour, last
 * 12, last 24, total — so the evidence available was a number going from 1 to
 * 2, with no way to see who or which league without opening a terminal. The
 * actual way it got noticed was somebody querying the database by hand.
 *
 * That is the wrong shape for this product in particular. The whole argument
 * for it is that a text beats a dashboard nobody opens, and the one person who
 * has to act on a signup was the only one not being texted.
 *
 * Deliberately one-way and best effort. A failed alert must never fail the
 * thing it is reporting on: a signup that was recorded and not announced is a
 * missed notification, while a signup that throws because the alert failed is
 * a lost lead.
 */

const db = require('./db');

/** Where alerts go. Unset means alerts are off, which is a valid deployment. */
function operatorPhone() {
  const raw = process.env.OPERATOR_PHONE;
  return raw ? db.normalizePhone(raw) : null;
}

/**
 * @param provider  MessagingProvider
 * @param text      what to say. Keep it to something readable on a lock screen.
 * @param opts.dryRun  compose and log, send nothing
 */
/**
 * A provider, built here when the caller has none.
 *
 * record() is the single funnel every signup passes through — sms, the website
 * form, and the conversational path that returns before handle() ever sees it —
 * which makes it the only place an alert cannot be bypassed. It has no provider
 * to hand over, so one is built lazily rather than threading a messaging client
 * through a function whose job is writing a row.
 */
function fallbackProvider() {
  const id = process.env.SENDBLUE_API_KEY_ID;
  const secret = process.env.SENDBLUE_API_SECRET_KEY;
  if (!id || !secret) return null;
  const { SendblueProvider } = require('./sendblue');
  return new SendblueProvider(id, secret, { fromNumber: process.env.SENDBLUE_FROM_NUMBER });
}

async function operator(provider, text, { dryRun = false } = {}) {
  const to = operatorPhone();
  if (!to) return { sent: false, reason: 'no_operator_phone' };
  const send = provider || fallbackProvider();
  if (!send) return { sent: false, reason: 'no_provider' };
  if (dryRun) {
    console.log('[notify] DRY RUN, would tell the operator:', text.split('\n')[0]);
    return { sent: false, reason: 'dry_run', text };
  }
  try {
    await send.send(to, text);
    return { sent: true, text };
  } catch (err) {
    console.error('[notify] operator alert failed:', err.message);
    return { sent: false, reason: 'send_failed' };
  }
}

/**
 * A new league is on the waitlist.
 *
 * Carries the command, not just the news. The gap between finding out and
 * acting was a terminal, a script name nobody remembers, and a phone number
 * that had to be looked up first.
 */
function waitlistText({ leagueName, teams, phone, email, name, source, pendingCount = 1 }) {
  const who = leagueName || 'a league with no Sleeper id';
  const size = teams ? `, ${teams} teams` : '';
  const from = source === 'web' ? ' (from the website)' : '';

  /*
   * Who they are, now that we know.
   *
   * The website asks for a name before it hands out the code, so an alert that
   * says only "a league, 12 teams" is throwing away the one thing that makes it
   * possible to reply like a person. This line was written before that field
   * existed.
   */
  const person = [name, email].filter(Boolean).join('  ');
  const intro = `New signup: ${who}${size}${from}.` + (person ? `\n${person}` : '');

  /*
   * A signup with no phone CANNOT be invited, and must not be told to try.
   *
   * The first real website signup produced "Reply INVITE .com": the ref is the
   * last four characters of the contact, and with no phone it fell back to the
   * email address. The advice underneath it was wrong anyway — invites.pending()
   * filters on `phone is not null` and invites.send() refuses without one, so
   * INVITE could never have reached this row however it was typed. An
   * instruction that cannot work is worse than no instruction: it costs the
   * minute somebody spends finding that out.
   */
  if (!phone) {
    return `${intro}\n\nNo phone on this one, so INVITE will not reach them. `
         + `Email them yourself${email ? '' : ' — and there is no address either, so the '
           + 'dashboard is the only place this lead exists'}.`;
  }

  /*
   * The ref is in the alert even when it is not needed yet.
   *
   * Two signups arriving close together makes a bare INVITE ambiguous, and by
   * then the first alert has already been sent without one. Printing it always
   * means the message you scroll back to is still actionable after a second
   * league lands.
   */
  const ref = String(phone).slice(-4);
  const how = pendingCount > 1
    ? `Reply INVITE ${ref} to send the setup link. ${pendingCount} are waiting, so the number matters.`
    : `Reply INVITE to send the setup link, or INVITE ${ref} to be explicit.`;

  return `${intro}\n\n${how}`;
}

module.exports = { operator, operatorPhone, waitlistText };
