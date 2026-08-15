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

const DEFAULTS = {
  // Names that count as addressing the bot. Word-boundary matched, so "robot"
  // and "botched" do not trigger it.
  //
  // "commish" was here and was removed: in a fantasy league the commissioner is
  // a real person, so "commish can you fix the waiver order" is addressed to a
  // human and would have made the bot interrupt every message aimed at them.
  // Any trigger word that doubles as a league role or a common noun will do the
  // same — pick a distinctive name per league via leagues.config.botNames.
  botNames: ['bot'],

  // Hard rate limits. These are survival, not politeness — a number that talks
  // constantly gets carrier-flagged and league-muted.
  minGapMs: 60 * 1000,        // never two bot messages inside a minute
  maxPerHour: 6,
  maxPerDay: 20,

  // Consecutive bot messages with no human in between. Three is already a bot
  // talking to itself in front of an audience.
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
  const { burst, state, cfg, league } = ctx;

  // A bot replying to its own message is a runaway loop in a real group chat.
  // The poller already filters outbound; this is the second lock.
  if (burst.some(m => m.direction === 'outbound' || m.isOutbound)) {
    return { layer: 'suppress', reply: false, reason: 'own_message' };
  }

  if (!burst.length) return { layer: 'suppress', reply: false, reason: 'empty_burst' };

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

  if (state.msSinceLastBot != null && state.msSinceLastBot < cfg.minGapMs) {
    return {
      layer: 'suppress', reply: false, reason: 'min_gap',
      detail: { msSinceLastBot: state.msSinceLastBot, minGapMs: cfg.minGapMs },
    };
  }

  if (state.sentInLastHour >= cfg.maxPerHour) {
    return { layer: 'suppress', reply: false, reason: 'hourly_cap', detail: { sentInLastHour: state.sentInLastHour } };
  }

  if (state.sentToday >= cfg.maxPerDay) {
    return { layer: 'suppress', reply: false, reason: 'daily_cap', detail: { sentToday: state.sentToday } };
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

  for (const m of burst) {
    const hit = mentionsBot(m.text, cfg.botNames);
    if (hit) {
      return {
        layer: 'mention', reply: true, reason: 'direct_mention',
        detail: { matched: hit, messageId: m.messageId, sender: m.senderId },
      };
    }
  }

  // Someone replying directly to a bot message counts as addressing it. Not all
  // providers expose a reply-to reference; when absent this simply never fires.
  const replyToBot = burst.find(m => m.raw?.reply_to_bot || m.replyToBot);
  if (replyToBot) {
    return {
      layer: 'mention', reply: true, reason: 'reply_to_bot',
      detail: { messageId: replyToBot.messageId },
    };
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
  const ctx = { burst, state, league, cfg };

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

module.exports = { decide, mentionsBot, config, DEFAULTS, LAYERS };
