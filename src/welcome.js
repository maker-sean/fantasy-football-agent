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

/** Whatever the league configured, falling back to what the site advertises. */
function botName(league) {
  const names = league?.config?.botNames;
  const first = Array.isArray(names) ? names[0] : names;
  return (first && String(first).trim()) || 'Commish';
}

/**
 * @param league        the league row, for its configured name
 * @param needsBinding  true when rosters are not fully bound, which turns the
 *                      introduction into the fix for that as well: a league
 *                      that never binds gets recaps naming "Roster 7"
 */
function welcomeText(league, { needsBinding = false } = {}) {
  const name = botName(league);

  const first =
    `Alright. I am ${name}, and I have already read every box score this league has ever produced.\n\n` +
    `Tuesday mornings you get a recap, and it names names. Before kickoff I will tell you if you are ` +
    `starting someone who is Out, including the 9:30am games nobody remembers until it is too late.`;

  const second =
    `Say "${name}" and I answer. Ask who won in 2023, who has the worst bench luck, whatever you think ` +
    `you can prove. Do not say it and I stay quiet, which is most of the time.\n\n` +
    (needsBinding
      ? `Reply with your name so I know which roster is yours, otherwise you are "Roster 7" to me forever.\n\n`
      : '') +
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
async function ensureWelcomed(league, { send, needsBinding = false, dryRun = false } = {}) {
  if (!league) return { welcomed: false, sent: false };
  if (league.welcomed_at) return { welcomed: true, sent: false };
  if (!league.chat_id) return { welcomed: false, sent: false };

  const text = welcomeText(league, { needsBinding });

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

/** Are there members on this league with no phone bound to a roster yet? */
async function needsBinding(leagueId) {
  const { rows } = await db.query(
    `select count(*) filter (where phone is null or sleeper_user_id is null)::int as unbound,
            count(*)::int as total
       from members where league_id = $1`,
    [leagueId]
  );
  const r = rows[0] || { unbound: 0, total: 0 };
  return r.total > 0 && r.unbound > 0;
}

module.exports = { welcomeText, ensureWelcomed, needsBinding, botName };
