/**
 * "START <sleeper league id>" — the signup that arrives as a text message.
 *
 * The website's get-started flow validates a league against Sleeper in the
 * browser and then hands the visitor a pre-filled text. That text lands here,
 * through the poller that is already running, which is why this feature needed
 * no new service, no new hosting and no new secret.
 *
 * It is deliberately a queue rather than self-serve provisioning. Onboarding a
 * real league today is blocked on a messaging-plan contact cap and carrier
 * registration, and quietly signing people up for something that cannot be
 * delivered is worse than telling them they are in line.
 */

const db = require('./db');
const sleeper = require('./sleeper');

/**
 * The keyword shown on the site. One is displayed, several are accepted —
 * people retype from memory and will send whichever word they remember. Being
 * strict here costs a signup and teaches the sender nothing.
 *
 * STOP and HELP are carrier-reserved and deliberately absent.
 */
const KEYWORD = process.env.SIGNUP_KEYWORD || 'COMMISH';
const KEYWORDS = ['commish', 'draft', 'join', 'signup', 'start'];

/**
 * Matches "COMMISH 4F2K", "commish: 4f2k", "DRAFT 1400000000000000001", or the
 * keyword on its own.
 *
 * Both argument forms are accepted deliberately. A short code is what the site
 * issues now; a raw Sleeper league id is what the first version of this flow
 * told people to text, and anything already sent or screenshotted keeps working.
 */
const SIGNUP = new RegExp(
  `^\\s*(?:${KEYWORDS.join('|')})\\b[\\s:,-]*([A-Za-z0-9]{4,25})?\\s*$`, 'i'
);

/** Unambiguous alphabet: no O/0, no I/1/L. It has to survive being read aloud. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LEN = 4;
const looksLikeLeagueId = v => /^[0-9]{6,25}$/.test(v);

function parse(text) {
  const m = SIGNUP.exec(String(text || ''));
  if (!m) return null;
  const arg = m[1] || null;
  if (!arg) return { leagueId: null, code: null };
  return looksLikeLeagueId(arg)
    ? { leagueId: arg, code: null }
    : { leagueId: null, code: arg.toUpperCase() };
}

function newCode() {
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Issue a code for a league the visitor just picked on the site. Retries on
 * collision — 30^4 is a large space but not an infinite one.
 */
async function issueCode({ sleeperLeagueId, league }) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = newCode();
    const { rows } = await db.query(
      `insert into signup_codes (code, sleeper_league_id, league_name, season, total_rosters)
       values ($1,$2,$3,$4,$5)
       on conflict (code) do nothing
       returning *`,
      [code, sleeperLeagueId, league?.name || null, league?.season || null, league?.total_rosters || null]
    );
    if (rows[0]) return rows[0];
  }
  throw new Error('could not allocate a signup code');
}

async function resolveCode(code) {
  const { rows } = await db.query(
    'select * from signup_codes where code = $1', [String(code).toUpperCase()]
  );
  return rows[0] || null;
}

/**
 * Record a signup. Idempotent per (phone, league): texting START twice is a
 * person retrying, not a second lead.
 *
 * Returns { signup, created, league } — `league` is null when Sleeper does not
 * recognise the id, which is surfaced rather than stored as though it were fine.
 */
async function record({ phone, leagueId, rawText, source = 'sms' }) {
  const normalized = db.normalizePhone(phone);

  // Resolve the league so a typo is visible in the queue immediately, instead
  // of looking like a valid lead until someone tries to onboard it.
  let league = null;
  if (leagueId) {
    try {
      const lg = await sleeper.league(leagueId);
      if (lg && lg.league_id) league = lg;
    } catch { /* unknown id; recorded below with league_name null */ }
  }

  const { rows } = await db.query(
    `insert into signups (phone, sleeper_league_id, league_name, season, total_rosters, raw_text, source)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (phone, coalesce(sleeper_league_id, '')) do nothing
     returning *`,
    [normalized, leagueId || null, league?.name || null, league?.season || null,
     league?.total_rosters || null, rawText || null, source]
  );

  if (rows[0]) return { signup: rows[0], created: true, league };

  const { rows: existing } = await db.query(
    `select * from signups where phone = $1 and coalesce(sleeper_league_id,'') = $2`,
    [normalized, leagueId || '']
  );
  return { signup: existing[0] || null, created: false, league };
}

/** What to text back. Honest about the queue — see the note at the top. */
function reply({ created, league, leagueId }) {
  if (!leagueId) {
    return `You're on the list. To attach your league, grab your code from the site `
         + `and text ${KEYWORD} plus that code.`;
  }
  if (!league) {
    return `I couldn't find a Sleeper league with that ID, so I've noted your number but not the `
         + `league. Double-check the ID and text it again.`;
  }
  if (!created) {
    return `Already got you down for ${league.name}. You're in the queue — I'll text when it's ready.`;
  }
  return `Got it — ${league.name}, ${league.total_rosters} teams. You're in the queue.\n\n`
       + `Onboarding isn't automatic yet, so I'll text you to set it up rather than leave you `
       + `guessing. Nothing's charged. Reply STOP to drop off.`;
}

/**
 * Handle an inbound message if it is a signup. Returns null when it is not,
 * so callers can fall through to the normal reply path.
 */
async function handle(msg, provider, { dryRun = false } = {}) {
  // Group messages are a league talking, not a person signing up.
  if (msg.isGroup) return null;
  const parsed = parse(msg.text);
  if (!parsed) return null;

  // A short code carries the league the visitor already chose on the site.
  let leagueId = parsed.leagueId;
  if (parsed.code) {
    const issued = await resolveCode(parsed.code);
    if (!issued) {
      const text = `I don't recognise the code ${parsed.code}. Grab a fresh one from the site and text it again.`;
      if (!dryRun && provider) await provider.send(msg.senderId, text);
      return { handled: true, created: false, unknownCode: parsed.code, reply: text };
    }
    leagueId = issued.sleeper_league_id;
    await db.query(
      'update signup_codes set used_at = coalesce(used_at, now()), used_by_phone = coalesce(used_by_phone, $2) where code = $1',
      [issued.code, db.normalizePhone(msg.senderId)]
    );
  }

  const res = await record({
    phone: msg.senderId,
    leagueId,
    rawText: msg.text,
  });
  const text = reply({ ...res, leagueId });

  if (!dryRun && provider) {
    await provider.send(msg.senderId, text);
  }
  console.log(`[signup] ${res.created ? 'NEW' : 'repeat'} ${res.league?.name || parsed.leagueId || '(no league)'}`);
  return { handled: true, created: res.created, signup: res.signup, reply: text };
}

module.exports = {
  parse, record, reply, handle,
  issueCode, resolveCode, newCode,
  KEYWORD, KEYWORDS, SIGNUP, CODE_ALPHABET, CODE_LEN,
};
