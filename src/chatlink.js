/**
 * Confirming that the bot actually made it into the group chat.
 *
 * Onboarding step 6 parks a league on `awaiting_chat` and holds the screen
 * until receipt is confirmed. Confirmation cannot be a button the commissioner
 * clicks — that asserts the thing rather than verifying it, and the most common
 * onboarding failure is someone believing they added the number when they did
 * not. The only proof that works is a message arriving from the group.
 *
 * Matching an unknown group to a pending league uses the one thing already
 * known: the phone numbers bound during step 5. If a message arrives from an
 * unrecognised chat and any sender in it is a bound member of a league waiting
 * for its chat, that is the league.
 */

const db = require('./db');

/**
 * Try to bind an inbound message's chat to a league awaiting confirmation.
 *
 * Returns the linked league, or null when the message is not evidence of
 * anything — which is the overwhelmingly common case, so this stays cheap:
 * a single query that returns no rows and exits.
 */
async function tryLink(msg, { provider = 'sendblue' } = {}) {
  if (!msg || !msg.chatId || !msg.senderId) return null;

  const waiting = await db.leaguesAwaitingChat();
  if (!waiting.length) return null;

  const phone = db.normalizePhone(msg.senderId);

  const { rows } = await db.query(
    `select m.league_id
       from members m
      where m.phone = $1
        and m.league_id = any($2)
      limit 1`,
    [phone, waiting.map(l => l.id)]
  );
  if (!rows.length) return null;

  const leagueId = rows[0].league_id;

  // Another league may already hold this chat id — a commissioner reusing the
  // same group for a second league, or a retry. Refuse rather than silently
  // stealing the thread, since two leagues on one chat means every recap goes
  // to the wrong people.
  const taken = await db.leagueByChat(provider, msg.chatId);
  if (taken && taken.id !== leagueId) {
    console.warn(`[chatlink] chat ${msg.chatId} already belongs to ${taken.name} — not linking`);
    return null;
  }

  const league = await db.setOnboardingState(leagueId, 'live', { chatId: msg.chatId });
  console.log(`[chatlink] ${league.name} is live — confirmed by a message from ${msg.chatId}`);

  /*
   * This is where a promo slot is actually spent, and where the founder passes
   * are minted.
   *
   * NOT on an endpoint the browser calls. Onboarding does not complete because
   * a page said so — it completes here, when a real message arrives in the real
   * group chat, which is the one step nobody can fake by re-posting a form. A
   * client callable "complete onboarding" would let anyone holding a session
   * spend cohort slots and mint referral codes in a loop.
   *
   * Wrapped, because a promo bookkeeping failure must never stop a league going
   * live. Going live is the product; the discount is a note about billing that
   * does not exist yet. redeem() and mintFounderPasses() are both idempotent,
   * so a message that arrives twice does not spend two slots, and a failure
   * here can be repaired by replaying it.
   */
  try {
    const promo = require('./promo');
    const claimed = await promo.redeem({
      leagueId, sleeperLeagueId: league.sleeper_league_id,
    });
    if (claimed.ok && !claimed.alreadyRedeemed) {
      console.log(`[promo] ${league.name} redeemed ${claimed.claim.code}`);
      const seed = await promo.seedFor(league);
      const passes = await promo.mintFounderPasses(leagueId, { seed });
      if (passes.length) {
        console.log(`[promo] ${league.name} passes: ${passes.map(p => p.code).join(', ')}`);
      }
    }
  } catch (err) {
    console.error('[promo] redemption failed (league is live regardless):', err.message);
  }

  return league;
}

module.exports = { tryLink };
