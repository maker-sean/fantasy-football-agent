/**
 * The introduction, and the rule that nothing goes out before it.
 *
 * This is the first message a group ever receives, which makes it two things at
 * once: the bot explaining itself, and the message an A2P reviewer is most
 * likely to read. It therefore identifies the sender and carries STOP, and
 * those are not decoration on the end, they are the reason it exists.
 *
 * STATIC, never generated. Every other message goes through src/verify.js
 * because a model can invent numbers. This one contains no facts, so generating
 * it would buy variety on the single message where variety is worthless and the
 * downside is a compliance problem. Hard-coded means testable and known.
 *
 * Sent as two texts rather than one. A hundred and twenty words arriving as a
 * wall reads like a terms of service popup; two short ones back to back read
 * like someone who just joined and had something to say. Same --- convention
 * the recap uses, so drafts.sendRecap can deliver it unchanged.
 */

const db = require('./db');

const capitalise = n => String(n).charAt(0).toUpperCase() + String(n).slice(1);

/**
 * The NAME it introduces itself by — not the same thing as a trigger.
 *
 * These were the same value and should not have been. A trigger is matched
 * (case-insensitively, so its stored case is irrelevant); a name is read, and
 * "Alright. I am bot" looks like a bug. So the first configured trigger is
 * capitalised for this one sentence, and an unconfigured league introduces
 * itself as Commish — which is a name, and is separate from the question of
 * whether it ANSWERS to "commish". It does not by default, because in most
 * leagues that word means a person. See DEFAULT_BOT_NAMES in decide.js.
 */
function botName(league) {
  const raw = league?.config?.botNames;
  const list = (Array.isArray(raw) ? raw : [raw])
    .map(n => (n == null ? '' : String(n).trim())).filter(Boolean);
  return list.length ? capitalise(list[0]) : 'Commish';
}

/**
 * EVERY configured trigger, not just the first.
 *
 * A league can register several: FF Test answers to both "bot" and "jarvis".
 * Advertising one of them means half the ways people will actually try to get
 * its attention look broken, and the gate is the thing that decides, so the
 * introduction has to read from the same list the gate reads.
 */
function botNames(league) {
  const raw = league?.config?.botNames;
  const list = (Array.isArray(raw) ? raw : [raw])
    .map(n => (n == null ? '' : String(n).trim()))
    .filter(Boolean);
  // The same list the reply gate falls back to. A hardcoded 'Commish' here
  // is what let the introduction advertise a trigger the gate ignored.
  return list.length ? list : require('./decide').DEFAULT_BOT_NAMES;
}

/** a  |  a or b  |  a, b or c */
function orList(items, joiner = 'or') {
  const q = items.map(i => `"${i}"`);
  if (q.length <= 1) return q[0] || '';
  if (q.length === 2) return `${q[0]} ${joiner} ${q[1]}`;
  return `${q.slice(0, -1).join(', ')} ${joiner} ${q[q.length - 1]}`;
}

/** a  |  a and b  |  a, b and c */
function andList(items) {
  if (items.length <= 1) return items[0] || '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * @param league        the league row, for its configured name
 * @param needsBinding  true when rosters are not fully bound, which turns the
 *                      introduction into the fix for that as well: a league
 *                      that never binds gets recaps naming "Roster 7"
 */
/**
 * @param opts.known    display names of members we can actually reach, i.e.
 *                      the ones with a phone number attached
 * @param opts.unknown  how many rosters have nobody attached yet
 */
function welcomeText(league, { needsBinding = false, known = [], unknown = 0, menu = '' } = {}) {
  const name = botName(league);
  const triggers = orList(botNames(league));

  /*
   * The product gets named, then the bot does.
   *
   * "Alright. I am Bot" introduced a bot and nothing else, so thirteen people
   * met a number with a personality and no idea what it was part of. Every
   * other first contact this product makes already leads with the brand: the
   * signup confirmation opens "Welcome to Commish AI", and so does the invite.
   * The one message that actually lands in the group chat was the exception.
   *
   * Both names stay, because they answer different questions. Commish AI is
   * what this is; ${name} is what you say out loud to get its attention.
   */
  const first =
    `Welcome to Commish AI. I am ${name}, and I have already read every box score ` +
    `this league has ever produced.\n\n` +
    `Tuesday mornings you get a recap, and it names names. Before kickoff I will tell you if you are ` +
    `starting someone who is Out, including the 9:30am games nobody remembers until it is too late.`;

  const second =
    `Say ${triggers} and I answer. Ask who won in 2023, who has the worst bench luck, whatever you think ` +
    `you can prove. Do not say it and I stay quiet, which is most of the time.\n\n` +
    /*
     * The roll call. Only members with a phone number, because the point is to
     * verify the mapping between a person and a number, and a roster with
     * nobody attached has no mapping to verify.
     *
     * Names, never numbers. Everyone here is already in this chat, so the names
     * tell them nothing new, while reading somebody's mobile number aloud to
     * twelve people would be a genuinely bad way to introduce yourself.
     */
    (known.length
      ? `I have you as ${andList(known)}.` +
        (unknown ? ` ${unknown} more ${unknown === 1 ? 'roster is' : 'rosters are'} still just a team name to me.` : '') +
        ` Your commissioner can fix any of that on the website.\n\n`
      : '') +
    /*
     * The ask, which an earlier version made and then withdrew.
     *
     * That comment used to say there was no code path reading a name out of a
     * group chat, so the line was removed rather than left as a promise nothing
     * kept. src/claims.js is that path, so the line is back — but it asks for a
     * TEAM NUMBER, not a name. Sleeper has never heard of Marcus; the join this
     * needs is phone to roster, and a name on its own cannot supply it.
     */
    (menu
      ? `Which of you is which? Reply with your team's number and I will remember ` +
        `— add your name and I will use that too:\n\n${menu}\n\n`
      : '') +
    /*
     * The rates line belongs HERE most of all.
     *
     * It was on the signup confirmation and on the invite and not on this one,
     * which is exactly inverted: those two go to the commissioner, who has read
     * the terms and ticked the box, and this goes to eleven people who signed up
     * for nothing and are meeting the number for the first time. The only person
     * getting the disclosure was the one who least needed it.
     *
     * STILL NO HELP. An earlier draft promised "HELP brings this back", which is
     * not true and could not be made true: src/signup.js deliberately never
     * replies to a reserved keyword, because the provider suppresses outbound to
     * that number as soon as it sees one. Promising a reply the carrier swallows
     * is worse than not offering it, and HANDOFF.md still lists HELP returning
     * silence as open. src/signup.js and src/invites.js both advertise it and
     * should not until it answers.
     */
    /*
     * The feedback line, because a channel nobody knows about is not a channel.
     * This is the only message everybody in the league reads, so it is the only
     * place worth spending a sentence on it.
     */
    `Something wrong or missing? Say "${name} bug ..." or "${name} idea ..." and it goes `
    + `straight to the people building this.\n\n`
    + `Msg & data rates may apply. Reply STOP and you will never hear from me again.`;

  return `${first}\n---\n${second}`;
}

/**
 * Send the introduction if this group has not had it, and report whether it is
 * now safe to send anything else.
 *
 * Returns { welcomed, sent }. `welcomed` false means the caller must NOT send:
 * either the send failed or replies are paused, and in both cases leading with
 * a roast is worse than staying quiet for another cycle.
 *
 * welcomed_at is stamped only AFTER a successful send. Stamping first would
 * mark a league introduced on a send that never landed, and it would never be
 * introduced again. That is the same shape as the poller cursor bug this repo
 * already paid for: commit after the work, never before it.
 */
async function ensureWelcomed(league, { send, needsBinding = false, known, unknown, dryRun = false } = {}) {
  if (!league) return { welcomed: false, sent: false };
  if (league.welcomed_at) return { welcomed: true, sent: false };
  if (!league.chat_id) return { welcomed: false, sent: false };

  // Looked up here when the caller did not supply it, so no call site can
  // accidentally introduce the bot to a league without its roll call.
  let roll = { known: known || [], unknown: unknown || 0 };
  if (known === undefined) {
    roll = await roster(league.id).catch(() => ({ known: [], unknown: 0 }));
  }

  /*
   * The menu of unclaimed rosters, if there are any.
   *
   * Built here rather than inside welcomeText so that function stays pure and
   * testable without a database — it is the most-tested string in the codebase
   * and it should stay that way.
   */
  let menu = '';
  try {
    const claims = require('./claims');
    const rows = await claims.unclaimed(league.id);
    if (rows.length) menu = claims.menuText(rows);
  } catch (err) {
    // A missing menu costs the group one convenience. A failed introduction
    // costs them the whole product, so this must never be the thing that
    // stops it going out.
    console.error('[welcome] could not build the roster menu:', err.message);
  }

  const text = welcomeText(league, { needsBinding, known: roll.known, unknown: roll.unknown, menu });

  if (dryRun) {
    console.log(`[welcome] DRY RUN, would introduce to ${league.name}`);
    return { welcomed: false, sent: false, text };
  }

  /*
   * The contact card rides along with the introduction.
   *
   * This is the exact moment it is worth anything: twelve people are looking at
   * a message from a number none of them recognise. A card sent later is an
   * interruption; a card sent now is the answer to the question they are
   * already asking.
   *
   * Refused when the base URL is local, for the same reason scripts/invite.js
   * refuses to text a localhost link: an unreachable attachment on somebody's
   * phone cannot be taken back.
   */
  let mediaUrl = null;
  try {
    const base = require('./onboardlink').baseUrl();
    if (!/localhost|127\.0\.0\.1/.test(base)) mediaUrl = `${base}/contact.vcf`;
  } catch { /* no secret configured; the introduction still goes out */ }

  let res;
  try {
    res = await send(league.chat_id, text, { mediaUrl });
  } catch (err) {
    console.error(`[welcome] send failed for ${league.name}:`, err.message);
    return { welcomed: false, sent: false };
  }

  /*
   * The handle, so this stamp can be TAKEN BACK.
   *
   * Not throwing means Sendblue answered 200, which is acceptance and not
   * delivery — Sigma Chi Dynasty was stamped welcomed on 2026-08-24 at 01:45:29
   * on a send that failed at the device layer seconds later, and because
   * welcomed_at is the guard against introducing a league twice, it was never
   * introduced at all.
   *
   * Blocking here on confirmed delivery is the wrong cure: reconciliation is a
   * poll on a six minute cron, and holding the reply path open for that turns
   * every first message into a timeout. So the stamp still goes down
   * optimistically, and src/delivery.js lifts it when this handle comes back
   * failed. Optimistic is fine as long as something is watching.
   */
  /*
   * TWO SHAPES, because every real caller goes through drafts.sendRecap.
   *
   * The introduction is split into parts, so sendRecap returns { parts, sent }
   * with an array of provider responses — not a response. Reading
   * res.message_handle off that is undefined on every path that matters, which
   * made the un-welcome mechanism dead code the first time it shipped: the
   * handle stayed null, the sweep had nothing to match, and welcomed_at could
   * never be taken back.
   *
   * The FIRST part is the one tracked. It carries the contact card, and if it
   * landed the league has met the bot — a second part failing is a worse
   * introduction, not an absent one, and resending the whole thing over the top
   * would be worse still.
   */
  const first = Array.isArray(res?.sent) ? res.sent[0] : res;
  const handle = first?.message_handle || first?.id || null;
  await db.query(
    'update leagues set welcomed_at = now(), welcome_message_handle = $2 where id = $1 and welcomed_at is null',
    [league.id, handle]);
  // Start the clock the moment the menu is actually in front of them, so a
  // bare "3" is read as an answer to a question they can still see.
  if (menu) await db.query('update leagues set claims_asked_at = now() where id = $1', [league.id]).catch(() => {});
  console.log(`[welcome] introduced to ${league.name}`);
  return { welcomed: true, sent: true, text };
}

/**
 * Who the introduction can name, and how many it cannot.
 *
 * "Reachable" means a phone number is attached. A roster with no number is not
 * a person as far as this bot is concerned: it cannot be messaged, it cannot
 * trigger a reply, and naming it in a roll call would claim a mapping that does
 * not exist.
 *
 * The names come from members.display_name, which is what the commissioner
 * typed on the roster screen. Be aware that the daily Sleeper reconcile also
 * writes this column and fills it with TEAM names, so an un-onboarded league
 * reads like "Big Yardage" and "Punt Intended" rather than people. Filtering on
 * a phone number happens to avoid that too, since only the commissioner's path
 * sets both.
 */
async function roster(leagueId) {
  /*
   * ROWS ARE NOT ROSTERS, and counting the former is how the introduction ended
   * up saying "3 more rosters are still just a team name to me" while the menu
   * underneath it offered exactly one, in a twelve team league, above a list of
   * twelve names. Twelve plus three is not twelve, and it is the first thing
   * thirteen people read.
   *
   * The members table accumulates partial rows: a phone bound before a Sleeper
   * link, a roster shell with nothing on it, leftovers from merging two halves
   * of the same person. Every one of those inflated the count by one. So the
   * arithmetic is done over DISTINCT ROSTERS, which is the thing being counted,
   * and duplicate rows can no longer move it.
   */
  const { rows } = await db.query(
    `select display_name, phone, sleeper_roster_id from members where league_id = $1
      order by display_name`,
    [leagueId]
  );

  return countRoster(rows);
}

/**
 * The arithmetic, separated from the query so it can be tested with the messy
 * row shapes that caused the bug rather than only with tidy ones.
 */
function countRoster(rows) {
  const reachable = new Set();
  const names = new Map();
  for (const r of rows) {
    if (!r.phone) continue;
    if (r.display_name) names.set(r.display_name, true);
    if (r.sleeper_roster_id != null) reachable.add(Number(r.sleeper_roster_id));
  }
  const allRosters = new Set(
    rows.filter(r => r.sleeper_roster_id != null).map(r => Number(r.sleeper_roster_id)));

  const known = [...names.keys()].sort();
  const unknown = Math.max(0, allRosters.size - reachable.size);
  return { known, unknown, needsBinding: unknown > 0 };
}

/** Kept for callers that only want the boolean. */
async function needsBinding(leagueId) {
  return (await roster(leagueId)).needsBinding;
}

module.exports = { welcomeText, ensureWelcomed, needsBinding, roster, countRoster,
  botName, botNames, orList, andList };
