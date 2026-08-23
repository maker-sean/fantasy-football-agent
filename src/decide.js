/**
 * Should the bot reply to this burst of messages?
 *
 * Layers run in order; the first one to return a verdict settles it. Adding
 * Layer 2 (heuristics) or Layer 3 (a gate model) means appending a function to
 * LAYERS — nothing else changes. That is the whole point of the shape.
 *
 * The default is SILENCE. The two failure modes are not symmetric: too chatty
 * gets the number muted or removed, which you are never told about and cannot
 * undo; too quiet costs nothing and is a one-line change next week. Every reply
 * has to earn its way past the bar.
 *
 * Currently enabled: Layer 0 (hard suppression) and Layer 1 (direct address).
 */

/**
 * What a league answers to before anybody chooses.
 *
 * 'commish' is deliberately NOT in here, and it is worth writing down why since
 * it looks like an obvious omission: in every league that word is a HUMAN.
 * "commish can you fix the waiver order" and "commish is asleep at the wheel
 * again" are people talking to and about a real person, and a bot that answers
 * to it barges into both. There is a test.
 *
 * Onboarding OFFERS it, because a commissioner knows whether their league uses
 * the word that way and is entitled to choose. It is offered unticked. The
 * difference between offering and defaulting is the whole point.
 */
/**
 * A tapback, not a message.
 *
 * Sendblue does not mark these. A reaction arrives with message_type "group"
 * and an empty send_style, identical to somebody typing, and its body is the
 * reaction word wrapped around a QUOTE of what it reacted to. That quote is the
 * problem: 47 reactions in this league's first night, 19 of which carried a bot
 * name inside the quoted text, so reacting to something the bot said addressed
 * the bot and it answered its own echo.
 *
 * They are still real chat and stay in the history, because "glad it landed" is
 * a reasonable thing to say next. They just must not be the reason to speak.
 */
const REACTION = /^\s*(?:(?:laughed at|liked|loved|disliked|emphasi[sz]ed|questioned)\s+[“"]|reacted\s+\S+\s+to\s+[“"]|removed a\s+.+\s+from\s+[“"])/i;

const isReaction = text => REACTION.test(String(text || ''));

const DEFAULT_BOT_NAMES = ['bot'];

const DEFAULTS = {
  // Names that count as addressing the bot. Word-boundary matched, so "robot"
  // and "botched" do not trigger it.
  //
  // "commish" was here and was removed: in a fantasy league the commissioner is
  // a real person, so "commish can you fix the waiver order" is addressed to a
  // human and would have made the bot interrupt every message aimed at them.
  // Any trigger word that doubles as a league role or a common noun will do the
  // same — pick a distinctive name per league via leagues.config.botNames.
  //
  // Shared with welcome.js. The two used to disagree — the introduction
  // advertised "Commish" while this gate listened only for "bot" — so the first
  // real "Hi Commish" in a live league was received, matched nothing, and was
  // silently ignored. One list, exported, so they cannot drift again.
  botNames: DEFAULT_BOT_NAMES,

  // Only answer people bound to a roster in this league.
  //
  // The phone number is the thing that leaks — it gets forwarded, screenshotted,
  // pasted into another chat. Without this, anyone holding it has an
  // unmetered Claude endpoint that answers in the product's voice. Caps alone
  // do not fix that: they bound the bill, not who is talking.
  //
  // Membership is the natural gate because it is already earned elsewhere — a
  // binding requires a roster in a real league, so the population of possible
  // abusers is exactly "people the commissioner let in".
  //
  // Cost of a false positive is real, though: a member whose number changed
  // gets silence with no explanation. The verdict log below is how you find
  // them — reason 'unbound_sender' with the number attached.
  requireBoundSender: true,

  // Volume limits. Two sets, because being asked something is not the same as
  // deciding to speak.
  //
  // A group actively talking TO the bot is engagement, not runaway — and an
  // hour where six people ask it things is precisely when it should not go
  // silent. Observed live: the bot capped out mid-conversation and ignored four
  // direct questions in a row, which reads as broken.
  //
  // The runaway guard is maxBotStreak below, not these.
  minGapMs: 60 * 1000,          // pacing for unprompted replies only
  maxPerHour: 6,                // unprompted
  maxPerDay: 20,                // unprompted
  maxPerHourAddressed: 15,      // when someone actually asked
  maxPerDayAddressed: 40,

  // Consecutive bot messages with no human in between. Three is already a bot
  // talking to itself in front of an audience. THIS is the runaway guard —
  // it binds even on a direct mention, because a bot answering itself twice
  // over is the failure that gets a number muted.
  maxBotStreak: 2,

  // Ignore anything older than this when a burst is evaluated — protects
  // against replying to backlog after a restart or a long outage.
  maxMessageAgeMs: 10 * 60 * 1000,
};

function config(league = {}, overrides = {}) {
  return { ...DEFAULTS, ...(league.config || {}), ...overrides };
}

/** Word-boundary mention match; tolerates a leading @ and trailing punctuation. */
function mentionsBot(text, botNames) {
  if (!text) return null;
  for (const name of botNames) {
    const re = new RegExp(`(^|[^\\w])@?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(text)) return name;
  }
  return null;
}

// ---------------------------------------------------------------- layers ---

/**
 * Layer 0 — hard suppression. Nothing downstream should ever see these.
 * Ordered cheapest and most dangerous first.
 */
function layerSuppress(ctx) {
  const { burst, state, cfg, league, addressed } = ctx;

  // A bot replying to its own message is a runaway loop in a real group chat.
  // The poller already filters outbound; this is the second lock.
  if (burst.some(m => m.direction === 'outbound' || m.isOutbound)) {
    return { layer: 'suppress', reply: false, reason: 'own_message' };
  }

  if (!burst.length) return { layer: 'suppress', reply: false, reason: 'empty_burst' };

  // Nothing here but tapbacks. Somebody laughing is not a question.
  if (burst.every(m => isReaction(m.text) || !String(m.text || '').trim())) {
    return { layer: 'suppress', reply: false, reason: 'reaction_only' };
  }

  if (league?.config?.paused) {
    return { layer: 'suppress', reply: false, reason: 'league_paused' };
  }

  const newest = Math.max(...burst.map(m => m.timestamp || 0));
  const age = state.now - newest;
  if (age > cfg.maxMessageAgeMs) {
    return { layer: 'suppress', reply: false, reason: 'stale_backlog', detail: { ageMs: age } };
  }

  if (state.botStreak >= cfg.maxBotStreak && state.humansSinceBot === 0) {
    return {
      layer: 'suppress', reply: false, reason: 'bot_streak',
      detail: { botStreak: state.botStreak, max: cfg.maxBotStreak },
    };
  }

  // PACING, not safety — and it does not apply to someone talking to us.
  //
  // Observed in a live group: the bot answered, and 40 seconds later a second
  // person asked "Jarvis who won last year?" and got silence. Being ignored
  // when you ask a direct question is far worse than a bot that speaks twice in
  // a minute, and this rule adds nothing the streak and hourly caps above do
  // not already cover. It exists to pace UNPROMPTED interjection (Layer 2).
  if (!addressed && state.msSinceLastBot != null && state.msSinceLastBot < cfg.minGapMs) {
    return {
      layer: 'suppress', reply: false, reason: 'min_gap',
      detail: { msSinceLastBot: state.msSinceLastBot, minGapMs: cfg.minGapMs },
    };
  }

  const hourCap = addressed ? cfg.maxPerHourAddressed : cfg.maxPerHour;
  if (state.sentInLastHour >= hourCap) {
    return {
      layer: 'suppress', reply: false, reason: 'hourly_cap',
      detail: { sentInLastHour: state.sentInLastHour, cap: hourCap, addressed },
    };
  }

  const dayCap = addressed ? cfg.maxPerDayAddressed : cfg.maxPerDay;
  if (state.sentToday >= dayCap) {
    return {
      layer: 'suppress', reply: false, reason: 'daily_cap',
      detail: { sentToday: state.sentToday, cap: dayCap, addressed },
    };
  }

  return null; // pass
}

/**
 * Layer 1 — direct address. The only thing that currently makes the bot speak.
 *
 * Unambiguous by design: no false positives, no model cost, and it produces the
 * measurement that decides whether Layers 2+ are worth building at all. If
 * nobody addresses the bot, unprompted interjection has no demand.
 */
function layerMention(ctx) {
  const { burst, cfg } = ctx;

  // `bound` is stamped on each message by the caller, which is where the
  // database lives. Only an explicit false blocks: undefined means nobody
  // resolved membership (no database — tests, dry runs), and in that mode
  // there is no answer generation to protect anyway.
  const blocked = m => cfg.requireBoundSender && m.bound === false;

  // Remembered rather than returned immediately: a bound member later in the
  // same burst still deserves an answer, so an unbound mention only settles the
  // verdict once nobody else has addressed us.
  let unbound = null;

  for (const m of burst) {
    const hit = mentionsBot(m.text, cfg.botNames);
    if (!hit) continue;
    if (blocked(m)) {
      unbound = unbound || { matched: hit, messageId: m.messageId, sender: m.senderId };
      continue;
    }
    return {
      layer: 'mention', reply: true, reason: 'direct_mention',
      detail: { matched: hit, messageId: m.messageId, sender: m.senderId },
    };
  }

  // Someone replying directly to a bot message counts as addressing it. Not all
  // providers expose a reply-to reference; when absent this simply never fires.
  const replyToBot = burst.find(m => m.raw?.reply_to_bot || m.replyToBot);
  if (replyToBot && !blocked(replyToBot)) {
    return {
      layer: 'mention', reply: true, reason: 'reply_to_bot',
      detail: { messageId: replyToBot.messageId },
    };
  }
  if (replyToBot && blocked(replyToBot)) {
    unbound = unbound || { messageId: replyToBot.messageId, sender: replyToBot.senderId };
  }

  // Addressed by someone we cannot place. Logged as its own reason so that
  // "why did the bot ignore me" is one query, not a guess.
  if (unbound) {
    return { layer: 'mention', reply: false, reason: 'unbound_sender', detail: unbound };
  }

  return null;
}

/**
 * Layer 2 — heuristic interjection. NOT ENABLED.
 *
 * Deliberately unbuilt until mention rate says there is demand. When it lands,
 * this is where thread temperature earns its keep: reply into a cold thread,
 * stay out of a hot one. `state.temperature` is already computed for it.
 */
function layerHeuristic(ctx) {
  if (!ctx.cfg.enableHeuristics) return null;
  throw new Error('Layer 2 not implemented — see the reply-decision design notes');
}

/**
 * Layer 3 — gate model. NOT ENABLED.
 *
 * A cheap model returning structured {reply, kind, reason} over recent history.
 * Needs an explicit bias toward silence: a model asked "should you reply?"
 * wants to be helpful and will say yes far too often, so it must be calibrated
 * against real threads before it ever runs live.
 */
function layerGate(ctx) {
  if (!ctx.cfg.enableGate) return null;
  throw new Error('Layer 3 not implemented — see the reply-decision design notes');
}

const LAYERS = [layerSuppress, layerMention, layerHeuristic, layerGate];

/**
 * @param burst   normalized inbound events (see provider.parseInbound)
 * @param state   output of convo.conversationState
 * @param league  league row (config drives per-league overrides)
 */
function decide({ burst, state, league = {}, overrides = {} }) {
  const started = Date.now();
  const cfg = config(league, overrides);
  // Whether we were spoken to is computed up front, because the hard limits and
  // the pacing limit treat it differently.
  /*
   * Reactions never count as being addressed.
   *
   * A tapback quotes the message it reacts to, so a laugh at one of the bot's
   * own replies contains the bot's name and used to read as a fresh question.
   * The burst is still delivered intact to the model, which can mention the
   * laugh if it is relevant. It just does not get to be the trigger.
   */
  const spoken = burst.filter(m => !isReaction(m.text));
  const addressed = spoken.some(m => mentionsBot(m.text, cfg.botNames)) ||
    spoken.some(m => m.raw?.reply_to_bot || m.replyToBot);
  const ctx = { burst, state, league, cfg, addressed };

  for (const layer of LAYERS) {
    const verdict = layer(ctx);
    if (verdict) {
      return {
        ...verdict,
        detail: verdict.detail || {},
        messageCount: burst.length,
        triggerMessageId: burst[burst.length - 1]?.messageId || null,
        latencyMs: Date.now() - started,
      };
    }
  }

  // Nothing claimed it. Silence is the default, and most bursts land here.
  return {
    layer: 'default', reply: false, reason: 'not_addressed',
    detail: { temperature: state.temperature },
    messageCount: burst.length,
    triggerMessageId: burst[burst.length - 1]?.messageId || null,
    latencyMs: Date.now() - started,
  };
}

module.exports = {
  DEFAULT_BOT_NAMES, decide, mentionsBot, isReaction, config, DEFAULTS, LAYERS };
