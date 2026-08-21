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
const { decide } = require('./decide');
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
        console.error('[signup] failed:', err.message);
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
        send: (chat, text) => drafts.sendRecap(this.provider, chat, text),
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
