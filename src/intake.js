/**
 * The three questions asked after somebody joins the waitlist.
 *
 * Name, email, and where they actually want the bot. The waitlist recorded a
 * phone, a league and a timestamp, which is enough to text a setup link and
 * nothing else: no way to reach anyone when the product ships something, and
 * no way to know which platform to build for next.
 *
 * ASKED AT SIGNUP, because that is the moment somebody is most willing to
 * answer. They have just chosen to be here. Every later moment is an
 * interruption of something else.
 *
 * ONE QUESTION PER MESSAGE. A single text asking for three things gets one
 * answer, usually to the first, and then a parsing problem. Three short turns
 * read like a conversation, which is the product's whole premise.
 *
 * EVERY STEP IS SKIPPABLE and says so. A waitlist entry with a phone and a
 * league is already useful; refusing to proceed without an email would trade a
 * lead for a field. "skip" ends the step, and anything unparseable is asked
 * once more rather than silently dropped.
 *
 * The platform question is the one that changes what gets built. Onboarding
 * runs over SMS because that is what works today, and somebody answering
 * "Discord" is not confused about that — they are saying where their league
 * actually lives.
 */

const db = require('./db');

const PLATFORMS = [
  ['imessage',  'iMessage or text group'],
  ['messenger', 'Facebook Messenger'],
  ['whatsapp',  'WhatsApp'],
  ['groupme',   'GroupMe'],
  ['discord',   'Discord'],
  ['other',     'Something else'],
];

const SKIP = /^\s*(skip|pass|no thanks?|nah|later|rather not|n\/?a)\s*[.!]*$/i;

/*
 * Deliberately loose. A strict address regex rejects real mail and the cost of
 * a wrong one is a bounced newsletter, while the cost of rejecting a good one
 * is the address itself. Same reasoning web/server.js already applies.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const askName = () =>
  "One thing before you go: what's your name? First and last is ideal.\n\n"
  + '(Say "skip" if you would rather not.)';

const askEmail = (first) =>
  `${first ? `Thanks ${first}. ` : 'Got it. '}What email should I use when there is `
  + 'something worth telling you about?\n\n(Or "skip".)';

const askPlatform = () =>
  'Last one. Where does your league actually live? Reply with a number:\n\n'
  + PLATFORMS.map(([, label], i) => `  ${i + 1}) ${label}`).join('\n')
  + '\n\n(Onboarding happens here over text either way. This tells me what to build next.)';

const done = (platform) =>
  platform
    ? `Noted, ${platform}. You are on the list and I will text you here when it is your turn.`
    : 'You are on the list. I will text you here when it is your turn.';

/** "Chris Dalton" -> { first: 'Chris', last: 'Dalton' }. One word is a first name. */
function parseName(text) {
  const clean = String(text || '').trim().replace(/\s+/g, ' ');
  if (!clean || clean.length > 80) return null;
  // A sentence is not a name. People answer "my name is Chris Dalton".
  /*
   * People answer a question about their name with a sentence. The optional
   * trailing "is" matters: without it "My name is Chris Dalton" strips to
   * "is Chris Dalton" and records a manager called Is.
   */
  const stripped = clean
    .replace(/^(?:my name(?:'?s)?|i'?m|it'?s|this is|name)\s*(?:is\s+)?/i, '')
    .replace(/^[,:\-\s]+/, '')
    .trim();
  if (!stripped || !/[a-z]/i.test(stripped)) return null;
  const parts = stripped.split(' ').filter(Boolean);
  if (parts.length > 5) return null;
  return { first: parts[0], last: parts.slice(1).join(' ') || null };
}

/** A number, or the platform's name typed out. */
function parsePlatform(text) {
  const clean = String(text || '').trim().toLowerCase();
  if (!clean) return null;

  const n = Number(clean.replace(/[^\d]/g, ''));
  if (Number.isInteger(n) && n >= 1 && n <= PLATFORMS.length) return PLATFORMS[n - 1][0];

  for (const [key, label] of PLATFORMS) {
    if (key === 'other') continue;
    if (clean.includes(key) || clean.includes(label.toLowerCase())) return key;
  }
  // "text", "sms" and "imessage" are the same answer to a person.
  if (/\b(text|sms|imessage|group ?chat)\b/.test(clean)) return 'imessage';
  /*
   * "Facebook" on its own means Messenger. The loop above matches on the key or
   * the full label, so relabelling this from "Messenger" to "Facebook
   * Messenger" would otherwise leave the shorter, more common answer matching
   * nothing — somebody who types the brand rather than the app gets asked
   * again.
   */
  if (/\b(facebook|fb)\b/.test(clean)) return 'messenger';
  return null;
}

/**
 * Advance the intake. Returns { reply, state, done } or null when this message
 * is not part of one.
 *
 * The signup row is updated as each answer arrives rather than at the end, so
 * somebody who stops halfway leaves behind what they did give.
 */
async function advance({ phone, text, convo, setState, endState }) {
  const state = convo?.state;
  const signupId = convo?.data?.signupId;
  if (!signupId) return null;

  const skipped = SKIP.test(text);

  if (state === 'intake_name') {
    const name = skipped ? null : parseName(text);
    if (!skipped && !name) {
      return { reply: 'I did not catch that. What name should I use? Or say "skip".', state };
    }
    if (name) {
      await db.query('update signups set first_name = $2, last_name = $3, updated_at = now() where id = $1',
        [signupId, name.first, name.last]);
    }
    await setState('intake_email', { ...convo.data, first: name?.first || null });
    return { reply: askEmail(name?.first), state: 'intake_email' };
  }

  if (state === 'intake_email') {
    const address = skipped ? null : String(text || '').trim();
    if (!skipped && !EMAIL.test(address)) {
      return { reply: 'That does not look like an email. Try again, or say "skip".', state };
    }
    if (address) {
      await db.query('update signups set email = $2, updated_at = now() where id = $1',
        [signupId, address.toLowerCase()]);
    }
    await setState('intake_platform', convo.data);
    return { reply: askPlatform(), state: 'intake_platform' };
  }

  if (state === 'intake_platform') {
    if (skipped) {
      await endState();
      return { reply: done(null), state: null, done: true };
    }
    const picked = parsePlatform(text);
    if (!picked) {
      // Anything unrecognised IS the "other" answer, kept verbatim, which is
      // the entire value of having an other box.
      await db.query(
        'update signups set platform = $2, platform_other = $3, updated_at = now() where id = $1',
        [signupId, 'other', String(text || '').trim().slice(0, 120)]);
      await endState();
      return { reply: done(String(text || '').trim()), state: null, done: true };
    }
    await db.query('update signups set platform = $2, updated_at = now() where id = $1',
      [signupId, picked]);
    await endState();
    const label = PLATFORMS.find(([k]) => k === picked)[1];
    return { reply: done(label), state: null, done: true };
  }

  return null;
}

module.exports = { advance, askName, askEmail, askPlatform, parseName, parsePlatform,
  PLATFORMS, SKIP, EMAIL };
