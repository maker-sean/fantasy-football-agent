/**
 * "Which one of you is this?" — answered in the chat.
 *
 * The commissioner used to type twelve names and twelve phone numbers into a
 * form, looking each number up in Contacts. That is the expensive part and no
 * form design fixes it: the numbers are not in a list anywhere, they are in a
 * phone. Meanwhile the twelve people they belong to are sitting in the group
 * chat holding those phones, and every message they send carries the number
 * already — verified by the transport rather than typed by a third party,
 * which is the anchor 0004_identity_binding.sql argues for anyway.
 *
 * WHAT IS BEING CLAIMED IS A ROSTER, NOT A NAME.
 *
 * "This is Marcus" is the obvious design and it is the wrong one. Sleeper knows
 * usernames and team names and has never heard of Marcus, so a name on its own
 * cannot be joined to anything. The join this system actually needs is
 * phone -> roster, so the menu is numbered by sleeper_roster_id and a claim
 * says which number. A name is welcome alongside it and is stored, but it is
 * decoration on top of the binding rather than the binding itself.
 *
 * The roster id is the menu number ON PURPOSE, rather than a 1..N index over
 * the unclaimed ones. An index shifts every time somebody claims, so a person
 * scrolling back to a menu from twenty minutes ago would claim the wrong team
 * — and it would look like it worked.
 */

const db = require('./db');

/** How long a BARE number reads as a claim after the menu was shown. */
const CLAIM_WINDOW_MINUTES = Number(process.env.CLAIM_WINDOW_MINUTES || 60);

/** One nudge per phone per day, so an ignored stranger is not nagged. */
const PROMPT_GAP_HOURS = 24;

/** Rosters nobody has claimed yet, in menu order. */
async function unclaimed(leagueId) {
  const { rows } = await db.query(
    `select sleeper_roster_id as roster, sleeper_username, team_name, display_name
       from members
      where league_id = $1 and sleeper_roster_id is not null and phone is null
      order by sleeper_roster_id`,
    [leagueId]
  );
  return rows;
}

/**
 * The menu, as text.
 *
 * Both labels on every line. The team name is what they see in the Sleeper app;
 * the username is what tells two joke team names apart. Either one is also an
 * accepted answer, so printing both widens what the parser will take.
 */
function menuText(rows) {
  return rows
    .map(r => `  ${r.roster}  ${r.team_name || r.display_name || 'Roster ' + r.roster}` +
              (r.sleeper_username ? ` — ${r.sleeper_username}` : ''))
    .join('\n');
}

function askText(rows, botName) {
  return `I do not know which of you is which yet. Reply with your team's number — ` +
         `add your name and I will use it:\n\n${menuText(rows)}\n\n` +
         `e.g. "${rows[0].roster} ${'Marcus'}"  ·  or say ${botName} first any time later.`;
}

/**
 * Read a claim out of a message.
 *
 * Generous about form, strict about what counts. Returns null for anything that
 * is not clearly a claim — silence is the correct answer to ordinary chat, and
 * this runs on every message from every unbound person.
 */
function parseClaim(text, { rosters, addressed, withinWindow, botNames = [] }) {
  let s = String(text || '').trim();
  if (!s) return null;

  // Strip a leading bot name so "bot 3 Marcus" parses as "3 Marcus".
  let wasAddressed = addressed;
  for (const n of botNames) {
    const re = new RegExp(`^@?${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[\\s:,-]*`, 'i');
    if (re.test(s)) { s = s.replace(re, '').trim(); wasAddressed = true; }
  }
  if (!s) return null;

  const byRoster = new Map(rosters.map(r => [String(r.roster), r]));

  // "3" or "3 Marcus"
  const num = /^(\d{1,3})(?:\s+(.{1,40}))?$/.exec(s);
  if (num) {
    const hit = byRoster.get(num[1]);
    if (!hit) return null;
    // A bare number is ordinary conversation — week 3, 3 points, pick 3. It
    // only reads as a claim when the menu is fresh, or when the bot was named.
    if (!wasAddressed && !withinWindow) return null;

    const name = cleanName(num[2]);
    /*
     * Trailing text that is not a name.
     *
     * "3 Marcus" is a claim. "3 and I are winning" is somebody talking. The two
     * are only distinguishable by whether what follows looks like a name — so
     * when it does not, an unaddressed message is treated as conversation and
     * dropped entirely rather than bound with the name thrown away.
     *
     * Naming the bot removes the ambiguity, so an addressed claim still stands
     * and simply loses the name.
     */
    if (num[2] && !name && !wasAddressed) return null;

    return { roster: hit.roster, name, how: wasAddressed ? 'addressed' : 'window' };
  }

  // A username or a team name is unambiguous on its own and needs no window:
  // nobody says "Punt Intended" by accident.
  const lower = s.toLowerCase();
  for (const r of rosters) {
    for (const label of [r.sleeper_username, r.team_name]) {
      if (!label) continue;
      const l = String(label).toLowerCase();
      if (lower === l || lower === `i am ${l}` || lower === `this is ${l}` || lower === `im ${l}`) {
        return { roster: r.roster, name: null, how: 'label' };
      }
    }
  }
  return null;
}

/** A name people would actually want printed, or nothing. */
function cleanName(raw) {
  const n = String(raw || '').trim().replace(/^["']|["']$/g, '');
  if (!n) return null;
  /*
   * One or two words that look like a name, and nothing else.
   *
   * A length cap alone is not enough: "Marcus and I are winning" is 24
   * characters and would have passed, then been read aloud in every recap and
   * every injury alert from then on. A display name is the most repeated string
   * this product produces, so the bar for accepting one is high.
   */
  return /^\p{L}[\p{L}'’.-]{0,19}(?: \p{L}[\p{L}'’.-]{0,19})?$/u.test(n) ? n : null;
}

/**
 * Apply a claim.
 *
 * The safety checks happen HERE, before bindMember, and then bindMember is
 * called with force. That looks backwards and is not: the roster's row already
 * exists from the Sleeper sync with a null phone, and members are keyed on
 * (league_id, phone), so an unforced bind would insert a SECOND row for the
 * same roster and trip the unique index on (league_id, sleeper_user_id). force
 * is what clears the empty shell. It also skips the write-once guards, which is
 * why they are re-implemented above it rather than trusted.
 */
async function apply(leagueId, phone, claim) {
  const normalized = db.normalizePhone(phone);

  const { rows: [target] } = await db.query(
    `select * from members where league_id = $1 and sleeper_roster_id = $2
      order by (sleeper_user_id is null) limit 1`,
    [leagueId, claim.roster]
  );
  if (!target) return { outcome: 'rejected_no_match' };

  // Somebody already holds this team.
  if (target.phone && target.phone !== normalized) {
    return { outcome: 'rejected_team_taken', existing: target };
  }
  // Already theirs — a repeat, not a conflict.
  if (target.phone === normalized) {
    if (claim.name && claim.name !== target.display_name) {
      await db.renameMember(leagueId, normalized, claim.name);
      return { outcome: 'bound', member: { ...target, display_name: claim.name }, renamed: true };
    }
    return { outcome: 'unchanged', member: target };
  }

  // This phone is already somebody else in this league.
  const { rows: [mine] } = await db.query(
    `select * from members where league_id = $1 and phone = $2`, [leagueId, normalized]);
  if (mine && mine.sleeper_roster_id !== null && mine.locked) {
    return { outcome: 'rejected_phone_taken', existing: mine };
  }

  const out = await db.bindMember(leagueId, {
    phone: normalized,
    sleeperUserId: target.sleeper_user_id,
    sleeperRosterId: claim.roster,
    displayName: claim.name,
    username: target.sleeper_username,
    teamName: target.team_name,
    boundBy: normalized,
    boundVia: 'chat',
    force: true,
  });
  return { outcome: 'bound', member: out.member };
}

/** What the group sees. Terse: this happens up to twelve times in a row. */
function replyFor(result, claim) {
  const team = m => m?.team_name || m?.display_name || `Roster ${claim.roster}`;
  switch (result.outcome) {
    case 'bound':
      return `✓ ${result.member.display_name || team(result.member)} — ${team(result.member)}`;
    case 'unchanged':
      return `Already had you as ${result.member.display_name || team(result.member)}.`;
    case 'rejected_team_taken':
      return `${team(result.existing)} is already ${result.existing.display_name || 'taken'}.`;
    case 'rejected_phone_taken':
      return `You are already down as ${result.existing.display_name || team(result.existing)}. ` +
             `Your commissioner can move that on the website.`;
    default:
      return null;   // no match: say nothing rather than argue with the chat
  }
}

function withinWindow(league, now = Date.now()) {
  if (!league?.claims_asked_at) return false;
  return now - new Date(league.claims_asked_at).getTime() < CLAIM_WINDOW_MINUTES * 60_000;
}

async function markAsked(leagueId) {
  await db.query('update leagues set claims_asked_at = now() where id = $1', [leagueId]);
}

/** Has this number been nudged recently? One per day, so it cannot become a nag. */
async function recentlyPrompted(leagueId, phone) {
  const { rows } = await db.query(
    `select 1 from identity_claims
      where league_id = $1 and phone = $2 and outcome = 'prompted'
        and created_at > now() - ($3 || ' hours')::interval limit 1`,
    [leagueId, db.normalizePhone(phone), String(PROMPT_GAP_HOURS)]
  );
  return rows.length > 0;
}

module.exports = {
  unclaimed, menuText, askText, parseClaim, cleanName, apply, replyFor,
  withinWindow, markAsked, recentlyPrompted,
  CLAIM_WINDOW_MINUTES, PROMPT_GAP_HOURS,
};
