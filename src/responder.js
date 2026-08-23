/**
 * Inbound → burst → decide → (maybe) reply, with every decision logged.
 *
 * Owns the reactive path so the worker stays a scheduler and src/inbound.js
 * stays persistence. The generation step is deliberately a thin seam: what the
 * bot SAYS when addressed is a separate problem from WHETHER it speaks, and
 * conflating them is how the reply logic ends up untunable.
 */

const { BurstCollector } = require('./burst');
const { conversationState } = require('./convo');
const { decide, mentionsBot } = require('./decide');
const flags = require('./flags');
const welcome = require('./welcome');
const drafts = require('./drafts');
const { handleControl } = require('./control');

const PERSIST = Boolean(process.env.DATABASE_URL);
const db = PERSIST ? require('./db') : null;

class Responder {
  /**
   * @param provider   MessagingProvider for sending
   * @param generate   async ({burst, state, league, verdict}) => string|null
   * @param opts.dryRun  decide and log, never send
   */
  constructor(provider, generate, opts = {}) {
    this.provider = provider;
    this.generate = generate;
    this.providerName = opts.providerName || 'sendblue';
    this.dryRun = Boolean(opts.dryRun);
    this.onDecision = opts.onDecision || (() => {});

    this.collector = new BurstCollector({
      quietMs: Number(process.env.BURST_QUIET_MS || 8000),
      maxWaitMs: Number(process.env.BURST_MAX_WAIT_MS || 30000),
      onBurst: (chatId, messages, meta) => this.handleBurst(chatId, messages, meta),
    });
  }

  /** Feed one normalized inbound message in. */
  observe(msg) {
    if (!msg || msg.direction === 'outbound') return;   // never react to ourselves
    this.collector.add(msg);
  }

  /**
   * Bind whoever just said which team is theirs, and nudge whoever tried to
   * talk to the bot without ever having done so.
   *
   * Returns a verdict when it acted, null to let the ordinary path continue.
   * Acting means the message WAS a claim, so falling through afterwards would
   * hand the same text to decide() and risk a second, unrelated reply to it.
   */
  /**
   * Answer a request to change who owns a team by sending the commissioner a
   * link, and never by doing it.
   *
   * The request is legitimate and common. The authority to grant it is what is
   * missing, and only the league's owner has that — so the link is minted for
   * them and texted to them, never to the person who asked. Anybody in a group
   * chat can type "somebody took my account"; acting on that would be the
   * takeover 0004 exists to prevent, and it would be exploitable by simply
   * asking.
   */
  /**
   * Send, unless an operator has paused replies.
   *
   * The kill switch used to be applied only after decide(), and both handlers
   * below return before reaching it — so pausing replies stopped the bot
   * answering questions while leaving it free to announce roster claims and
   * text commissioners. The one control an operator has must cover everything
   * that speaks.
   *
   * Paused still DECIDES and still logs, matching the main path: the whole
   * reason to pause is to watch without being posted to, and a silent hole in
   * the trace is indistinguishable from a crashed worker.
   */
  async sendUnlessPaused(chatId, text, label) {
    if (this.dryRun) return false;
    const paused = await flags.repliesPaused().catch(() => true);
    if (paused) {
      console.warn(`[${label}] PAUSED — composed but not sent.`);
      return false;
    }
    await this.provider.send(chatId, text).catch(err => {
      console.error(`[${label}] send failed:`, err.message);
    });
    return true;
  }

  async handleHelp(chatId, burst, league) {
    const claims = require('./claims');
    const botNames = (league.config?.botNames || []).map(String);

    // Only ever on a message that named the bot. Two people discussing
    // co-owning a team are having a conversation, not filing a request.
    const asker = burst.find(m => mentionsBot(m.text, botNames));
    if (!asker) return null;
    const intent = claims.helpIntent(asker.text);
    if (!intent) return null;

    const { rows: [owner] } = await db.query(
      `select a.* from accounts a join leagues l on l.account_id = a.id where l.id = $1`,
      [league.id]
    );

    let text = intent.reply();
    let sentLink = false;

    const paused = this.dryRun || await flags.repliesPaused().catch(() => true);
    if (owner?.phone && !paused && !(await claims.recentlyLinked(league.id))) {
      const url = require('./onboardlink').rosterLinkFor(league.id);
      try {
        await this.provider.send(owner.phone,
          `Someone in ${league.name} asked to be added or moved. Open the roster and fix it:\n${url}\n\n` +
          `Only you can change this. The link expires in 3 days.`);
        sentLink = true;
      } catch (err) {
        console.error('[help] could not text the commissioner:', err.message);
      }
    } else if (!owner?.phone) {
      // Nobody to text. Saying "your commissioner is getting a link" would be
      // a promise nothing keeps, which is worse than pointing at the website.
      text = intent.reply().replace(/is getting a link[^.]*\./,
        'can fix that on the website.');
    }

    await this.sendUnlessPaused(chatId, text, 'help');
    if (sentLink) {
      await db.recordClaim({
        leagueId: league.id, phone: asker.senderId, claimedText: asker.text,
        outcome: 'prompted', detail: { kind: 'roster_link', intent: intent.key },
      }).catch(() => {});
    }

    const verdict = { layer: 'help', reply: true, reason: intent.key,
      detail: { sentLink }, messageCount: burst.length, triggerMessageId: asker.messageId };
    await this.log(chatId, league, verdict, text).catch(() => {});
    return { verdict, replied: text };
  }

  async handleClaims(chatId, burst, league) {
    const claims = require('./claims');
    const rosters = await claims.unclaimed(league.id);
    if (!rosters.length) return null;          // everyone is bound; nothing to claim

    const botNames = (league.config?.botNames || []).map(String);
    const fresh = claims.withinWindow(league);
    const acted = [];

    for (const m of burst) {
      if (m.bound) continue;                   // already somebody
      const claim = claims.parseClaim(m.text, {
        rosters, addressed: false, withinWindow: fresh, botNames,
      });
      if (!claim) continue;

      const result = await claims.apply(league.id, m.senderId, claim);
      await db.recordClaim({
        leagueId: league.id, phone: m.senderId, claimedText: m.text,
        matchedUser: result.member?.sleeper_username || null,
        matchedTeam: result.member?.team_name || result.existing?.team_name || null,
        outcome: result.outcome === 'unchanged' ? 'bound' : result.outcome,
        detail: { how: claim.how, roster: claim.roster },
      }).catch(() => {});

      const reply = claims.replyFor(result, claim);
      if (reply) acted.push(reply);
      // A successful claim removes that roster from the menu for the rest of
      // this burst, so two people cannot both claim it in the same flurry.
      if (result.outcome === 'bound') {
        const i = rosters.findIndex(r => r.roster === claim.roster);
        if (i !== -1) rosters.splice(i, 1);
      }
    }

    if (acted.length) {
      const text = acted.join('\n');
      await this.sendUnlessPaused(chatId, text, 'claims');
      const verdict = { layer: 'claim', reply: true, reason: 'roster_claimed',
        detail: { count: acted.length }, messageCount: burst.length,
        triggerMessageId: burst[0].messageId };
      await this.log(chatId, league, verdict, text).catch(() => {});
      return { verdict, replied: text };
    }

    /*
     * Nobody claimed anything. If an unbound person ADDRESSED the bot, they
     * just got ignored by the gate — which is the exact moment to explain why,
     * and the only moment they will care.
     */
    const asker = burst.find(m => !m.bound && mentionsBot(m.text, botNames));
    if (!asker) return null;
    if (await claims.recentlyPrompted(league.id, asker.senderId)) return null;

    const text = claims.askText(rosters, botNames[0] || 'bot');
    const asked = await this.sendUnlessPaused(chatId, text, 'claims');
    // Only start the 60 minute window if the menu actually went out. Starting
    // it on a paused send would make a bare "3" bindable against a menu nobody
    // ever saw.
    if (asked) await claims.markAsked(league.id).catch(() => {});
    await db.recordClaim({
      leagueId: league.id, phone: asker.senderId, claimedText: asker.text,
      outcome: 'prompted', detail: { reason: 'unbound_addressed_the_bot' },
    }).catch(() => {});

    const verdict = { layer: 'claim', reply: true, reason: 'asked_who_they_are',
      messageCount: burst.length, triggerMessageId: asker.messageId };
    await this.log(chatId, league, verdict, text).catch(() => {});
    return { verdict, replied: text };
  }

  async handleBurst(chatId, burst, meta = {}) {
    // Operator commands first. Approving a recap is not a conversational reply
    // and must not be gated by mention rules or rate limits — otherwise the one
    // message that has to get through is the one suppressed.
    if (db) {
      try {
        const ctl = await handleControl({
          burst, provider: this.provider,
          providerName: this.providerName, dryRun: this.dryRun,
        });
        if (ctl?.handled) {
          console.log(`[control] ${ctl.action}${ctl.draftId ? ` draft=${ctl.draftId}` : ''}`);
          return { verdict: { layer: 'control', reply: false, reason: ctl.action }, replied: null };
        }
      } catch (err) {
        console.error('[control] threw, falling through:', err.message);
      }
    }

    // Signups run before the reply gate. A stranger texting START is precisely
    // the unbound sender that gate exists to silence, and silencing them would
    // break the website's only call to action.
    if (db && burst.length === 1 && !burst[0].isGroup) {
      try {
        const signup = require('./signup');
        const res = await signup.handle(burst[0], this.provider, { dryRun: this.dryRun });
        if (res) {
          // Log it like any other decision. This branch used to return early,
          // so a signup that was processed but not sent left no trace anywhere
          // — the only evidence was a used code in another table.
          const verdict = {
            layer: 'signup',
            reply: Boolean(res.reply),
            reason: res.conversational ? 'signup_conversation' : 'signup',
            detail: { created: res.created ?? null, dryRun: this.dryRun },
            messageCount: burst.length,
            triggerMessageId: burst[0].messageId,
          };
          if (this.dryRun) {
            console.warn('[signup] DRY RUN — reply composed but NOT sent. REPLY_DRY_RUN/ECHO are on.');
          }
          await this.log(chatId, null, verdict, res.reply);
          return { verdict, replied: res.reply };
        }
      } catch (err) {
        /*
         * Record WHY, not just that it happened.
         *
         * This used to log to the console and fall through, so the message
         * landed in the ordinary reply gate and was written down as
         * layer:'default', reason:'not_addressed' — a perfectly plausible row
         * describing something that never happened. The real cause, a 403 on a
         * retired from_number, existed only in Sendblue's API and in a console
         * line nobody was reading.
         */
        console.error('[signup] failed:', err.message);
        if (db) {
          await this.log(chatId, null, {
            layer: 'signup',
            reply: false,
            reason: 'signup_failed',
            detail: { error: err.message },
            messageCount: burst.length,
            triggerMessageId: burst[0].messageId,
          }, null).catch(() => { /* logging a failure must not fail louder */ });
        }
        return { verdict: { layer: 'signup', reply: false, reason: 'signup_failed' }, replied: null };
      }
    }

    const league = db ? await db.leagueByChat(this.providerName, chatId).catch(() => null) : null;
    const state = db
      ? await conversationState(chatId, this.providerName).catch(() => emptyState(chatId, this.providerName))
      : emptyState(chatId, this.providerName);

    // Resolve membership before deciding. decide() stays pure — it reads a
    // boolean per message and never touches the database, which is what keeps
    // it testable without one.
    if (db && league) {
      const bound = await db.boundPhones(league.id).catch(err => {
        console.error('[responder] bound lookup failed:', err.message);
        return null;
      });
      // A failed lookup leaves membership unresolved, which the gate treats as
      // "not blocked". That is deliberate and safe here rather than a hole: an
      // attacker cannot induce it, and answering needs the same database, so a
      // real outage produces no answer regardless of this gate.
      if (bound) {
        for (const m of burst) m.bound = bound.has(db.normalizePhone(m.senderId));
      }
    }

    /*
     * "I co-own this" and "somebody took my team".
     *
     * Checked for EVERYONE, bound or not — the person whose team was taken is
     * usually already bound, so putting this inside the unbound-only branch
     * below would miss the case it exists for.
     */
    if (db && league) {
      const helped = await this.handleHelp(chatId, burst, league)
        .catch(err => { console.error('[help] failed:', err.message); return null; });
      if (helped) return helped;
    }

    /*
     * Roster claims, before the gate.
     *
     * Same reason the signup branch sits above it: boundPhones silences unbound
     * senders by design, and somebody saying which team is theirs is precisely
     * the unbound sender it silences. Unlike signup this must run on GROUP
     * messages, because the group chat is where the twelve people are.
     *
     * It runs on every message from an unbound person, so parseClaim has to
     * return null for anything that is not unmistakably a claim. Silence is the
     * right answer to ordinary chat.
     */
    /*
     * Mute and wake, ahead of everything.
     *
     * A wake has to land while paused, which is the same rule control.js states
     * for recap approval: the one message that must get through is the one a
     * paused bot suppresses. So this sends through the provider directly rather
     * than sendUnlessPaused, which consults the very flag it is clearing.
     */
    if (db && league) {
      const mute = await require('./mute').handleMute({
        burst, league,
        send: text => (this.dryRun ? null : this.provider.send(chatId, text)),
      }).catch(err => { console.error('[mute] failed:', err.message); return null; });

      if (mute) {
        const verdict = { layer: 'mute', reply: true,
          reason: mute.paused ? 'muted' : 'woken',
          messageCount: burst.length, triggerMessageId: mute.triggerMessageId };
        await this.log(chatId, league, verdict, mute.reply).catch(() => {});
        return { verdict, replied: mute.reply };
      }

      /*
       * Muted means MUTED, including the paths that skip decide().
       *
       * league.config.paused is enforced in decide.js layer 0, but help and
       * claims both return before decide is ever called and send through
       * sendUnlessPaused, which consults the GLOBAL kill switch and knows
       * nothing about this league's flag. Without this, a league that told the
       * bot to be quiet would still get roster prompts and help replies, which
       * is the same shape of bug as the welcome sitting below two early
       * returns. Stopped here, once, above all of them.
       */
      if (league.config?.paused) {
        const verdict = { layer: 'suppress', reply: false, reason: 'league_paused',
          messageCount: burst.length, triggerMessageId: burst[0]?.messageId };
        await this.log(chatId, league, verdict, null).catch(() => {});
        return { verdict, replied: null };
      }
    }

    /*
     * Telling us something, ahead of the reply gate.
     *
     * Feedback from an unbound person is still feedback, and decide() silences
     * unbound senders by design — the same reason claims sits up here. It also
     * must not be rate limited: the one message you actually want is the one a
     * busy hour would drop.
     */
    if (db && league) {
      const fb = require('./feedback');
      const botNames = (league.config?.botNames || []).map(String);
      for (const m of burst) {
        const parsed = fb.parse(m.text, { botNames, isGroup: Boolean(m.isGroup) });
        if (!parsed) continue;

        const saidBy = m.senderName
          || (await db.query('select display_name from members where league_id=$1 and phone=$2',
               [league.id, db.normalizePhone(m.senderId)]).then(r => r.rows[0]?.display_name).catch(() => null));

        const row = await fb.record({
          leagueId: league.id, phone: m.senderId, saidBy,
          kind: parsed.kind, body: parsed.body, inGroup: Boolean(m.isGroup),
        }).catch(err => { console.error('[feedback] could not store:', err.message); return null; });

        if (!row) break;

        // Straight to the operator's phone. A dashboard nobody opens loses the
        // signal, and this is worth most while the context is fresh.
        await require('./notify').operator(this.provider,
          fb.alertText({ ...parsed, saidBy, inGroup: Boolean(m.isGroup), leagueName: league.name }),
          { dryRun: this.dryRun }).catch(() => {});

        const reply = fb.thanks(parsed.kind);
        await this.sendUnlessPaused(chatId, reply, 'feedback');
        const verdict = { layer: 'feedback', reply: true, reason: parsed.kind,
          messageCount: burst.length, triggerMessageId: m.messageId };
        await this.log(chatId, league, verdict, reply).catch(() => {});
        return { verdict, replied: reply };
      }
    }

    /*
     * Somebody who is ALREADY bound saying who they are.
     *
     * Whitlock texted "I am Whitlock and I am the manager of Ruizs Onside Bandits" and
     * got back "Noted, Whitlock runs Ruiz's Onside Bandits". Nothing was noted: no
     * claim parsed, no attempt logged, his row untouched. It was true by luck,
     * and the identical sentence would have come out if he were on the wrong
     * roster. A confident wrong statement about who somebody is is precisely
     * what the identity system exists to prevent.
     *
     * So this states what IS recorded and who can change it, and never implies
     * anything was written. Above the claims path because that one is gated on
     * being unbound and would skip these people entirely.
     */
    if (db && league) {
      const claimsMod = require('./claims');
      const botNames = (league.config?.botNames || []).map(String);
      const { rows: members } = await db.query(
        'select phone, display_name, team_name, sleeper_roster_id from members where league_id = $1',
        [league.id]);
      const known = members.flatMap(m => [m.display_name, m.team_name]).filter(Boolean);

      for (const m of burst) {
        if (!m.bound) continue;
        if (!claimsMod.looksLikeSelfIntro(m.text, { botNames, known })) continue;

        const me = members.find(x => x.phone === db.normalizePhone(m.senderId));
        if (!me) continue;
        // Once is informative, twice is nagging.
        if (await claimsMod.recentlyToldBound(league.id, m.senderId).catch(() => true)) break;

        const text = claimsMod.alreadyBoundReply({
          displayName: me.display_name, teamName: me.team_name, rosterId: me.sleeper_roster_id,
        });
        await this.sendUnlessPaused(chatId, text, 'identity');
        await db.recordClaim({
          leagueId: league.id, phone: m.senderId, claimedText: m.text,
          outcome: 'already_bound', detail: { roster: me.sleeper_roster_id },
        }).catch(() => {});
        const verdict = { layer: 'identity', reply: true, reason: 'already_bound',
          messageCount: burst.length, triggerMessageId: m.messageId };
        await this.log(chatId, league, verdict, text).catch(() => {});
        return { verdict, replied: text };
      }
    }

    if (db && league && burst.some(m => !m.bound)) {
      const handled = await this.handleClaims(chatId, burst, league)
        .catch(err => { console.error('[claims] failed:', err.message); return null; });
      if (handled) return handled;
    }

    const verdict = decide({ burst, state, league: league || {} });
    verdict.trigger = meta.trigger;
    verdict.waitedMs = meta.waitedMs;

    /*
     * The kill switch, applied AFTER the gate rather than before it.
     *
     * Deciding first and then refusing to send means the decisions table still
     * records what the bot would have done while it was paused, which is the
     * whole reason an operator pauses: to watch without being posted to. Short
     * circuiting above decide() would leave a silent hole in the trace, and a
     * silent hole is indistinguishable from a crashed worker, which is the
     * ambiguity this system exists to remove.
     */
    if (verdict.reply && await flags.repliesPaused().catch(() => true)) {
      verdict.reply = false;
      verdict.layer = 'suppress';
      verdict.reason = 'replies_paused';
      verdict.detail = { ...verdict.detail, wouldHaveReplied: true, pausedBy: 'control_plane' };
    }

    /*
     * The introduction, before anything else this league hears.
     *
     * Placed after the kill switch so a paused bot introduces nothing either,
     * and before generate() so the first mention produces the welcome rather
     * than an answer. Two model-shaped things arriving together muddies the
     * introduction, and a first mention is almost always "welcome commish" or
     * "is this thing on", which has no answer worth generating.
     */
    if (verdict.reply && league && !league.welcomed_at) {
      const needs = await welcome.needsBinding(league.id).catch(() => false);
      const res = await welcome.ensureWelcomed(league, {
        send: (chat, text, opts) => drafts.sendRecap(this.provider, chat, text, opts),
        needsBinding: needs,
        dryRun: this.dryRun,
      });
      /*
       * A PREFIX, not a replacement.
       *
       * The introduction goes out first and then the request is answered, which
       * is what a person would do when joining a group and being asked
       * something. An earlier version consumed the mention and replied with
       * only the introduction, which meant "Commish who won in 2023" got a
       * greeting and no answer. That contradicted the precondition idea it was
       * meant to implement: first, not instead.
       *
       * The one case that still suppresses is a FAILED introduction. If the
       * group could not be told who we are, answering anyway means a roast from
       * an unknown number, which is the thing this exists to prevent.
       */
      verdict.detail = { ...verdict.detail, welcomed: res.sent };
      if (!res.welcomed) {
        verdict.reply = false;
        verdict.layer = 'welcome';
        verdict.reason = 'introduction_failed';
      }
    }

    let replied = null;
    if (verdict.reply) {
      try {
        replied = await this.generate({ burst, state, league, verdict });
      } catch (err) {
        console.error('[responder] generate failed:', err.message);
        verdict.detail.generateError = err.message;
      }

      if (replied && !this.dryRun) {
        try {
          await this.provider.send(chatId, replied);
          // Record our own message immediately. The Phase 2 metric is human
          // replies PER BOT MESSAGE, and the denominator has to exist before
          // the next poll cycle reads state back.
          if (db) {
            await db.recordMessage({
              leagueId: league?.id || null,
              provider: this.providerName,
              providerMessageId: null,
              direction: 'outbound',
              chatId,
              senderPhone: null,
              isGroup: burst[0]?.isGroup ?? true,
              protocol: burst[0]?.protocol || null,
              body: replied,
              raw: { reply_to: verdict.triggerMessageId, reason: verdict.reason },
              occurredAt: Date.now(),
            });
          }
        } catch (err) {
          console.error('[responder] send failed:', err.message);
          verdict.detail.sendError = err.message;
          replied = null;
        }
      }
    }

    await this.log(chatId, league, verdict, replied);
    this.onDecision(verdict, burst, replied);
    return { verdict, replied };
  }

  async log(chatId, league, verdict, replied) {
    const line = `[decide] ${verdict.reply ? 'REPLY ' : 'silent'} ${verdict.layer}/${verdict.reason}` +
      `  burst=${verdict.messageCount}  ${chatId}`;
    console.log(line);

    if (!db) return;
    try {
      await db.query(
        `insert into decisions
           (league_id, provider, chat_id, trigger_message_id, message_count,
            layer, decision, reason, detail, latency_ms, replied_text)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (provider, trigger_message_id) where trigger_message_id is not null
         do nothing`,
        [
          league?.id || null, this.providerName, chatId,
          verdict.triggerMessageId, verdict.messageCount,
          verdict.layer, verdict.reply ? 'reply' : 'silent', verdict.reason,
          verdict.detail || {}, verdict.latencyMs || null, replied || null,
        ]
      );
    } catch (err) {
      console.error('[decide] log failed:', err.message);
    }
  }

  async shutdown() {
    await this.collector.flushAll();
    this.collector.stop();
  }
}

function emptyState(chatId, provider) {
  return {
    chatId, provider, now: Date.now(), totalSeen: 0,
    lastBotAt: null, msSinceLastBot: null, botStreak: 0, humansSinceBot: 0,
    sentInLastHour: 0, sentToday: 0,
    inbound5: 0, inbound60: 0, distinctSpeakers60: 0, temperature: 'cold',
  };
}

module.exports = { Responder };
