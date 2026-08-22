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
function welcomeText(league, { needsBinding = false, known = [], unknown = 0 } = {}) {
  const name = botName(league);
  const triggers = orList(botNames(league));

  const first =
    `Alright. I am ${name}, and I have already read every box score this league has ever produced.\n\n` +
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
    // No "reply with your name" line, though an earlier version had one.
    // db.renameMember exists and NOTHING calls it: there is no code path that
    // reads a name out of a group chat and binds it to a roster. The roll call
    // above replaces it, and points at the commissioner, who is the only one
    // who can actually change anything.
    ''  +
    // STOP only. An earlier draft promised "HELP brings this back", which is
    // not true and could not be made true: src/signup.js deliberately never
    // replies to a reserved keyword, because the provider suppresses outbound
    // to that number as soon as it sees one. Promising a reply that the
    // carrier swallows is worse than not offering it.
    `Reply STOP and you will never hear from me again.`;

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

  const text = welcomeText(league, { needsBinding, known: roll.known, unknown: roll.unknown });

  if (dryRun) {
    console.log(`[welcome] DRY RUN, would introduce to ${league.name}`);
    return { welcomed: false, sent: false, text };
  }

  try {
    await send(league.chat_id, text);
  } catch (err) {
    console.error(`[welcome] send failed for ${league.name}:`, err.message);
    return { welcomed: false, sent: false };
  }

  await db.query('update leagues set welcomed_at = now() where id = $1 and welcomed_at is null', [league.id]);
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
  const { rows } = await db.query(
    `select display_name, phone from members where league_id = $1 order by display_name`,
    [leagueId]
  );
  const known = rows.filter(r => r.phone && r.display_name).map(r => r.display_name);
  const unknown = rows.length - known.length;
  return { known, unknown, needsBinding: unknown > 0 };
}

/** Kept for callers that only want the boolean. */
async function needsBinding(leagueId) {
  return (await roster(leagueId)).needsBinding;
}

module.exports = { welcomeText, ensureWelcomed, needsBinding, roster, botName, botNames, orList, andList };
