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

/*
 * A second kind: "open my roster and let me fix it".
 *
 * Same signing, same fragment, same expiry mechanics — a different first byte
 * and a LEAGUE id in the body instead of a signup id. It exists because the
 * answer to "somebody took my team" and "I co-own this one" has to be a link
 * the commissioner can tap, not an instruction to go and find a website.
 *
 * It authorises exactly one thing: editing that league's roster. It is minted
 * for the commissioner and texted to the commissioner, never to the person who
 * asked — which is the entire security property. Anybody in a group chat can
 * ask for a team to be reassigned; only the person who owns the league can do
 * it.
 */
const KIND_ROSTER = 0x02;

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

function pack(kind, id, days) {
  const expires = Math.floor(Date.now() / 1000) + Math.round(days * 86400);
  const body = Buffer.alloc(21);
  body[0] = kind;
  uuidBytes(id).copy(body, 1);
  body.writeUInt32BE(expires, 17);
  const sig = crypto.createHmac('sha256', secret()).update(body).digest().subarray(0, SIG_BYTES);
  return Buffer.concat([body, sig]).toString('base64url');
}

/** Sign an invite for one signup. */
function mint(signupId, { days = DEFAULT_TTL_DAYS } = {}) {
  return pack(KIND_ONBOARD, signupId, days);
}

/**
 * Sign a roster-editing link for one league.
 *
 * Shorter lived than an invite. An invite has to survive a weekend and somebody
 * getting round to it; this is sent in response to a request that was made
 * seconds ago, and it grants write access to who is who — so three days, not
 * seven.
 */
function mintRoster(leagueId, { days = 3 } = {}) {
  return pack(KIND_ROSTER, leagueId, days);
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
    const kind = raw[0];
    if (kind !== KIND_ONBOARD && kind !== KIND_ROSTER) return null;

    const body = raw.subarray(0, 21);
    const given = raw.subarray(21);
    const want = crypto.createHmac('sha256', secret()).update(body).digest().subarray(0, SIG_BYTES);
    if (!crypto.timingSafeEqual(given, want)) return null;

    const id = bytesUuid(body.subarray(1, 17));
    // The kind is INSIDE the signed body, so a roster link cannot be edited
    // into an invite or the other way round.
    const field = kind === KIND_ROSTER ? 'leagueId' : 'signupId';

    const expires = body.readUInt32BE(17);
    if (expires * 1000 <= now) return { expired: true, kind, [field]: id };

    return { kind, [field]: id, expiresAt: new Date(expires * 1000) };
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

/** Same fragment key — the server decides what the token authorises, not the URL. */
function rosterLinkFor(leagueId, opts) {
  return `${baseUrl()}/app/#setup=${mintRoster(leagueId, opts)}`;
}

module.exports = { mint, mintRoster, read, linkFor, rosterLinkFor, baseUrl,
  DEFAULT_TTL_DAYS, KIND_ONBOARD, KIND_ROSTER };
