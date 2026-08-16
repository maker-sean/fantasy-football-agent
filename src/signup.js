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
 * Sleeper league ids are long numeric strings. Accepting the word alone is
 * deliberate too: people will text START on its own, and replying "you're in
 * the queue, which league?" beats silence.
 */
const START = /^\s*start\b[\s:]*([0-9]{6,25})?\s*$/i;

function parse(text) {
  const m = START.exec(String(text || ''));
  if (!m) return null;
  return { leagueId: m[1] || null };
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
    return "You're on the list. Reply with START and your Sleeper league ID and I'll "
         + "attach it — or grab it from the site and I'll do the rest.";
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

  const res = await record({
    phone: msg.senderId,
    leagueId: parsed.leagueId,
    rawText: msg.text,
  });
  const text = reply({ ...res, leagueId: parsed.leagueId });

  if (!dryRun && provider) {
    await provider.send(msg.senderId, text);
  }
  console.log(`[signup] ${res.created ? 'NEW' : 'repeat'} ${res.league?.name || parsed.leagueId || '(no league)'}`);
  return { handled: true, created: res.created, signup: res.signup, reply: text };
}

module.exports = { parse, record, reply, handle, START };
