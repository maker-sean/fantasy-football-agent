/**
 * Owner control channel: approve or kill a pending recap from your phone.
 *
 * Runs BEFORE the reply decision and short-circuits it. Approving a draft is an
 * operator action, not a conversational reply — it must not inherit mention
 * rules, rate limits, or the bot-streak cap, or the one message you actually
 * need to go through would be the one suppressed.
 *
 * Scoped tightly on purpose: 1:1 only, from a phone listed as an owner of a
 * league, matching a short command. A group message never reaches this path, so
 * nobody can approve a recap by saying "send" in the league thread.
 */

const db = require('./db');
const drafts = require('./drafts');

const APPROVE = /^(send|send it|post|post it|yes|y|yep|yeah|ship|ship it|go|approve|do it|👍|🚀)[.!]*$/i;
const REJECT  = /^(no|nope|n|kill|kill it|skip|reject|nah|don'?t|delete|👎)[.!]*$/i;
const STATUS  = /^(status|pending|queue|what'?s pending|drafts?)[.!?]*$/i;

/**
 * @param burst        normalized inbound events
 * @param provider     MessagingProvider, for sending
 * @param providerName 'sendblue'
 * @returns {handled, action, reply} or null to fall through to the reply decision
 */
async function handleControl({ burst, provider, providerName = 'sendblue', dryRun = false }) {
  if (!burst?.length) return null;

  // Group traffic never controls anything. Otherwise "send it" in the league
  // thread would publish a draft the league has not seen.
  if (burst.some(m => m.isGroup)) return null;

  const sender = db.normalizePhone(burst[0].senderId);
  if (!sender) return null;

  const text = burst.map(m => m.text).filter(Boolean).join(' ').trim();
  if (!text) return null;

  const isApprove = APPROVE.test(text);
  const isReject = REJECT.test(text);
  const isStatus = STATUS.test(text);
  if (!isApprove && !isReject && !isStatus) return null;

  let pending;
  try {
    pending = await drafts.pendingForOwner(sender);
  } catch (err) {
    console.error('[control] lookup failed:', err.message);
    return null;
  }

  // Not an owner, or nothing queued — fall through rather than claiming the
  // message. A stranger texting "yes" should get the normal reply path.
  if (!pending.length && !isStatus) return null;

  const say = async (msg) => {
    if (dryRun) { console.log(`[control] (dry run) would reply: ${msg}`); return; }
    try { await provider.send(sender, msg); }
    catch (err) { console.error('[control] reply failed:', err.message); }
  };

  if (isStatus) {
    if (!pending.length) {
      await say('Nothing waiting for you.');
      return { handled: true, action: 'status', count: 0 };
    }
    const lines = pending.map(d =>
      `${d.league_name} week ${d.week} — expires ${new Date(d.expires_at).toLocaleString('en-US', { timeZone: process.env.CRON_TZ || 'America/New_York' })}`
    );
    await say(`Waiting on you:\n${lines.join('\n')}\n\nReply SEND to post, NO to kill.`);
    return { handled: true, action: 'status', count: pending.length };
  }

  const draft = pending[0];

  if (isReject) {
    await drafts.markRejected(draft.id, { by: sender });
    await say(`Killed. ${draft.league_name} week ${draft.week} won't post.`);
    console.log(`[control] ${sender} rejected draft ${draft.id}`);
    return { handled: true, action: 'reject', draftId: draft.id };
  }

  // Approve: post to the league thread, then confirm to the owner.
  if (!draft.chat_id) {
    await say(`${draft.league_name} has no chat thread linked, so there's nowhere to post it.`);
    return { handled: true, action: 'approve_failed', draftId: draft.id };
  }

  if (dryRun) {
    console.log(`[control] (dry run) would post draft ${draft.id} to ${draft.chat_id}`);
    await say('(dry run) would have posted it.');
    return { handled: true, action: 'approve_dry', draftId: draft.id };
  }

  try {
    // Same split as the auto-post path: an approved recap posts exactly as it
    // would have unattended.
    const { sent } = await drafts.sendRecap(provider, draft.chat_id, draft.body);
    const res = sent[0];
    await drafts.markSent(draft.id, { by: sender, messageId: res?.message_handle || null });

    // Record our own message — the engagement metric counts human replies per
    // bot message, so the denominator has to exist immediately.
    await db.recordMessage({
      leagueId: draft.league_id,
      provider: providerName,
      providerMessageId: res?.message_handle || null,
      direction: 'outbound',
      chatId: draft.chat_id,
      senderPhone: null,
      isGroup: true,
      protocol: null,
      body: draft.body,
      raw: { source: 'recap_draft', draft_id: draft.id, approved_by: sender },
      occurredAt: Date.now(),
    });

    await say(`Posted to ${draft.league_name}.`);
    console.log(`[control] ${sender} approved draft ${draft.id} -> ${draft.chat_id}`);
    return { handled: true, action: 'approve', draftId: draft.id };
  } catch (err) {
    console.error('[control] post failed:', err.message);
    await say(`Couldn't post it: ${err.message.slice(0, 80)}. It's still pending.`);
    return { handled: true, action: 'approve_failed', draftId: draft.id, error: err.message };
  }
}

module.exports = { handleControl, APPROVE, REJECT, STATUS };
