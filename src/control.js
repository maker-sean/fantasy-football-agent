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
const welcome = require('./welcome');

const APPROVE = /^(send|send it|post|post it|yes|y|yep|yeah|ship|ship it|go|approve|do it|👍|🚀)[.!]*$/i;
const REJECT  = /^(no|nope|n|kill|kill it|skip|reject|nah|don'?t|delete|👎)[.!]*$/i;
const STATUS  = /^(status|pending|queue|what'?s pending|drafts?)[.!?]*$/i;

/*
 * Approving a SIGNUP, which is a different thing from approving a recap.
 *
 * A recap is approved by a league owner; a signup has no league yet, so this is
 * scoped to OPERATOR_PHONE instead. Same shape otherwise: 1:1 only, a short
 * command, ahead of the reply gate so it cannot be swallowed by mention rules
 * or rate limits.
 *
 * The trailing ref is optional and becomes required when more than one signup
 * is waiting. src/invites.js refuses rather than guessing, because inviting the
 * wrong league sends a stranger a link that signs them into an account.
 */
const INVITE  = /^invite(?:\s+([0-9]{2,10}))?[.!]*$/i;
const IGNORE  = /^(ignore|skip|no thanks|not yet)(?:\s+([0-9]{2,10}))?[.!]*$/i;

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

  /*
   * Signup approval, before recap approval.
   *
   * Checked first because INVITE cannot collide with the recap commands, and
   * because it is scoped to a different person: OPERATOR_PHONE rather than a
   * league owner. A signup has no league yet, so there is no owner to be.
   */
  const inviteHit = INVITE.exec(text);
  const ignoreHit = IGNORE.exec(text);
  if (inviteHit || ignoreHit) {
    const notify = require('./notify');
    const operator = notify.operatorPhone();
    // Not the operator: fall through rather than claim the message, the same
    // way a stranger texting "yes" gets the normal reply path.
    if (!operator || sender !== operator) return null;

    const invites = require('./invites');
    const ref = (inviteHit || ignoreHit)[1] || null;
    const found = await invites.resolve(ref).catch(() => ({ error: 'lookup_failed' }));

    const say = async (msg) => {
      if (!dryRun && provider) await provider.send(sender, msg).catch(() => {});
      return msg;
    };

    if (found.error === 'none_pending') {
      return { handled: true, action: 'invite_none', reply: await say('Nothing on the waitlist.') };
    }
    if (found.error === 'ambiguous') {
      /*
       * Refused, not guessed. Sean asked what happens when two land close
       * together, and this is the answer: the last four digits of their number,
       * which is stable no matter what else arrives, unlike a menu position.
       */
      const list = found.waiting
        .map(s => `  ${s.ref}  ${s.league_name || 'no league'}${s.total_rosters ? `, ${s.total_rosters} teams` : ''}`)
        .join('\n');
      return { handled: true, action: 'invite_ambiguous',
        reply: await say(`${found.waiting.length} waiting, so I need the number:\n\n${list}\n\ne.g. INVITE ${found.waiting[0].ref}`) };
    }
    if (found.error) {
      return { handled: true, action: 'invite_no_match',
        reply: await say(`Nothing on the waitlist matches ${ref}.`) };
    }

    if (ignoreHit) {
      await db.query(`update signups set status = 'declined', updated_at = now() where id = $1`,
        [found.signup.id]).catch(() => {});
      return { handled: true, action: 'invite_ignored',
        reply: await say(`Left ${found.signup.league_name || 'them'} on the shelf.`) };
    }

    const res = await invites.send(found.signup.id, { provider, dryRun });
    if (res.error === 'localhost_base_url') {
      return { handled: true, action: 'invite_failed',
        reply: await say('PUBLIC_BASE_URL is localhost on this worker, so the link would be dead. Not sending.') };
    }
    /*
     * The pre-flight gate, said in a sentence rather than an error code.
     *
     * This path is somebody standing in a kitchen with a phone. "preflight_no_run"
     * is a correct answer to the wrong question; what they need is which of the
     * two things to do next, and neither is doable from here — the run and the
     * override both live on /admin.
     */
    if (!res.sent && String(res.error || '').startsWith('preflight_')) {
      const why = {
        preflight_no_run: 'I have not checked whether I can answer questions about their league yet.',
        preflight_running: 'The onboarding check on their league is still running.',
        preflight_stale: 'The onboarding check on their league died partway through.',
        preflight_thin: 'Their league has no completed seasons, so I would have nothing historical to say.',
        preflight_failed: 'The onboarding check on their league failed.',
      }[res.error] || 'The onboarding check has not passed.';
      const next = res.overridable
        ? 'Send it anyway from /admin if that is fine with you.'
        : 'Run Onboard league on /admin first.';
      return { handled: true, action: 'invite_blocked', reply: await say(`${why} ${next}`) };
    }

    if (!res.sent) {
      return { handled: true, action: 'invite_failed',
        reply: await say(`Could not send that: ${res.error || 'unknown'}.`) };
    }
    return { handled: true, action: 'invite_sent',
      reply: await say(`Sent. ${found.signup.league_name || 'They'} have their setup link, good for 7 days.`) };
  }

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
    // Same precondition on the approval path. A commissioner replying SEND
    // is not evidence the group has been introduced to us.
    const league = await db.leagueById(draft.league_id).catch(() => null);
    if (league) {
      const intro = await welcome.ensureWelcomed(league, {
        send: (chat, text) => drafts.sendRecap(provider, chat, text),
        needsBinding: await welcome.needsBinding(league.id).catch(() => false),
      });
      if (!intro.welcomed) {
        await say('Could not introduce myself to the group yet, so I am holding the recap.');
        return { handled: true, action: 'approve_failed', draftId: draft.id };
      }
    }

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

module.exports = { handleControl, APPROVE, REJECT, STATUS, INVITE, IGNORE };
