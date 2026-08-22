/**
 * The voting link: zero auth for the voter, real identity for us.
 *
 * A ballot link is handed to one specific person, so the person is IN the link.
 * The token packs the ballot id and the member id as raw bytes and signs them
 * with a server secret. Opening it proves nothing about who is holding the
 * phone — but it does prove the link was minted by us for that member, which is
 * the property a fingerprint can never have and the one 0004_identity_binding
 * says to care about.
 *
 * WHAT THIS DEFENDS AGAINST, AND WHAT IT DOES NOT.
 *
 * It stops: forging a vote for a member you are not, enumerating ballots by
 * guessing ids, and voting twice from two browsers. All three are the failure
 * modes of a public /poll/x8k2q link at ten-voter scale.
 *
 * It does not stop: a league mate forwarding you their own link. Nothing short
 * of a login does, the link is going into a group chat full of people who know
 * each other, and a commissioner can already see who voted for what. Sharing
 * your ballot is a social problem with a social fix, and pretending otherwise
 * by adding an account step would cost more votes than it protects.
 *
 * NO SEPARATE EXPIRY. The ballot's closes_at already refuses late votes, and a
 * token that outlives it is a feature: people come back to the same link to see
 * the result. A second clock here would only add a way for the two to disagree.
 */

const crypto = require('crypto');

/** Truncated to 16 bytes. Full SHA-256 would double the URL for no more security. */
const SIG_BYTES = 16;

/**
 * The secret is required, and there is no default.
 *
 * A fallback like 'dev-secret' is how a signing key reaches production without
 * anybody noticing: everything works, tokens verify, and every league's ballots
 * are forgeable by anyone who has read the repo. Refusing to mint is loud and
 * happens on the first attempt rather than never.
 */
function secret() {
  const s = process.env.BALLOT_SECRET;
  if (!s || s.length < 32) {
    throw new Error(
      'BALLOT_SECRET is not set, or is shorter than 32 characters.\n' +
      '  Generate one:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n' +
      '  Then set it on BOTH Render services — the worker mints links, the web app verifies them.'
    );
  }
  return s;
}

const b64u = buf => buf.toString('base64url');

/** uuid text -> 16 raw bytes. Packing rather than encoding the hyphenated form
 *  keeps the whole token inside a single SMS segment's worth of URL. */
function uuidBytes(uuid) {
  const hex = String(uuid).replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`not a uuid: ${uuid}`);
  return Buffer.from(hex, 'hex');
}

function bytesUuid(buf) {
  const h = buf.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Sign a member's link to one ballot. */
function mint(ballotId, memberId) {
  const body = Buffer.concat([uuidBytes(ballotId), uuidBytes(memberId)]);
  const sig = crypto.createHmac('sha256', secret()).update(body).digest().subarray(0, SIG_BYTES);
  return b64u(Buffer.concat([body, sig]));
}

/**
 * Verify and unpack. Returns null for anything that does not check out — a bad
 * signature, a truncated token, junk from a link that a chat app mangled.
 *
 * Never throws on bad input. This runs on an unauthenticated route that
 * strangers will hit, and a 500 stack trace is a worse answer than a 404.
 */
function read(token) {
  try {
    const raw = Buffer.from(String(token || ''), 'base64url');
    if (raw.length !== 32 + SIG_BYTES) return null;

    const body = raw.subarray(0, 32);
    const given = raw.subarray(32);
    const want = crypto.createHmac('sha256', secret()).update(body).digest().subarray(0, SIG_BYTES);

    // Constant time. A byte-by-byte early return leaks how much of a forged
    // signature was right, which is enough to build one a byte at a time.
    if (!crypto.timingSafeEqual(given, want)) return null;

    return { ballotId: bytesUuid(body.subarray(0, 16)), memberId: bytesUuid(body.subarray(16)) };
  } catch {
    return null;
  }
}

/**
 * The origin links are built from.
 *
 * Falls back to the Render service URL, which is a real https origin today and
 * needs no domain purchase. Wrong-origin links are the failure this repo has
 * now hit three times (see src/authlink.js), so this reads from one place and
 * every caller uses it.
 */
function baseUrl() {
  const raw = process.env.PUBLIC_BASE_URL
    || process.env.RENDER_EXTERNAL_URL
    || 'http://localhost:' + (process.env.PORT || 3000);
  return String(raw).replace(/\/+$/, '');
}

function linkFor(ballotId, memberId) {
  return `${baseUrl()}/v/${mint(ballotId, memberId)}`;
}

module.exports = { mint, read, linkFor, baseUrl, SIG_BYTES };
