/**
 * A sign-in link delivered by text.
 *
 * The funnel's dead end was structural, not a bug: /app/ needs an account, an
 * account needed an email, and the only way to get one was a magic link over
 * SMTP that has never successfully sent in production. Every fix aimed at the
 * email — a domain, custom SMTP, a warmed sending reputation — is work spent
 * repairing the weakest channel in the system.
 *
 * Meanwhile the person already texted us. Sendblue verified the number, the message
 * arrived, we replied to it. Possession of that phone is a stronger identity
 * claim than possession of an inbox, and it is the one that already works. So
 * the link goes over SMS, signed, and opening it IS the sign-in.
 *
 * WHAT THIS IS. A bearer credential. Whoever holds the URL becomes the account.
 * That is the same trust model as every magic link ever emailed, with a better
 * delivery channel — but it means the usual bearer rules apply and are worth
 * stating rather than assuming:
 *
 *   It EXPIRES. Ballot links deliberately do not, because a stale one only ever
 *   shows a closed vote. This one grants write access to a league and to twelve
 *   people's phone numbers, so it dies on a clock — seven days, long enough to
 *   survive a weekend, short enough that a forwarded screenshot goes stale.
 *
 *   It travels in the URL FRAGMENT, not the query string. Fragments are never
 *   sent to a server, so this cannot land in an access log, a proxy, or a
 *   Referer header on the way to a third party. It is the same reason Supabase
 *   puts its own tokens there, and web/app/app.js already strips the fragment
 *   the moment it reads one.
 *
 *   It is NOT revocable on its own. Deleting the signup row it points at is the
 *   revocation, which is worth knowing before texting one to the wrong number.
 */

const crypto = require('crypto');

const SIG_BYTES = 16;
const DEFAULT_TTL_DAYS = Number(process.env.ONBOARD_LINK_DAYS || 7);

/**
 * A type byte, first in the signed body.
 *
 * BALLOT_SECRET signs two different families of link now. Without a domain
 * separator a token minted for one could in principle be presented to the
 * other, and "in principle" is how this kind of thing is always discovered.
 * The lengths already differ, which the readers check, so this is belt and
 * braces — but it is one byte and it makes the separation explicit rather than
 * incidental.
 */
const KIND_ONBOARD = 0x01;

function secret() {
  const s = process.env.BALLOT_SECRET;
  if (!s || s.length < 32) {
    throw new Error(
      'BALLOT_SECRET is not set, or is shorter than 32 characters.\n' +
      '  It signs voting links AND onboarding links. Same value on the worker\n' +
      '  (which mints) and the web app (which verifies).'
    );
  }
  return s;
}

function uuidBytes(uuid) {
  const hex = String(uuid).replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`not a uuid: ${uuid}`);
  return Buffer.from(hex, 'hex');
}

function bytesUuid(buf) {
  const h = buf.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Sign an invite for one signup. */
function mint(signupId, { days = DEFAULT_TTL_DAYS } = {}) {
  const expires = Math.floor(Date.now() / 1000) + Math.round(days * 86400);
  const body = Buffer.alloc(21);
  body[0] = KIND_ONBOARD;
  uuidBytes(signupId).copy(body, 1);
  body.writeUInt32BE(expires, 17);

  const sig = crypto.createHmac('sha256', secret()).update(body).digest().subarray(0, SIG_BYTES);
  return Buffer.concat([body, sig]).toString('base64url');
}

/**
 * Verify and unpack. Null for anything that does not check out.
 *
 * The signature is checked BEFORE the expiry. Reading a timestamp out of an
 * unverified buffer and branching on it hands an attacker a way to probe, and
 * costs nothing to avoid.
 */
function read(token, { now = Date.now() } = {}) {
  try {
    const raw = Buffer.from(String(token || ''), 'base64url');
    if (raw.length !== 21 + SIG_BYTES) return null;
    if (raw[0] !== KIND_ONBOARD) return null;

    const body = raw.subarray(0, 21);
    const given = raw.subarray(21);
    const want = crypto.createHmac('sha256', secret()).update(body).digest().subarray(0, SIG_BYTES);
    if (!crypto.timingSafeEqual(given, want)) return null;

    const expires = body.readUInt32BE(17);
    if (expires * 1000 <= now) return { expired: true, signupId: bytesUuid(body.subarray(1, 17)) };

    return { signupId: bytesUuid(body.subarray(1, 17)), expiresAt: new Date(expires * 1000) };
  } catch {
    return null;
  }
}

function baseUrl() {
  const raw = process.env.PUBLIC_BASE_URL
    || process.env.RENDER_EXTERNAL_URL
    || 'http://localhost:' + (process.env.PORT || 3000);
  return String(raw).replace(/\/+$/, '');
}

/** The fragment is the point — see the note at the top. */
function linkFor(signupId, opts) {
  return `${baseUrl()}/app/#setup=${mint(signupId, opts)}`;
}

module.exports = { mint, read, linkFor, baseUrl, DEFAULT_TTL_DAYS, KIND_ONBOARD };
