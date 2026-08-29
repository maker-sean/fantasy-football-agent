/**
 * Which messaging provider a given league is actually on.
 *
 * THE PROBLEM THIS FIXES. `leagues.provider` has been a column since
 * 0001_init.sql and every message records the provider it came through, but
 * nothing ever resolved it at send time. The worker builds one SendblueProvider
 * and threads that same instance through every job — gameday.tick(sendblue),
 * trades.poll(sendblue), and so on — so the data model said "per league" while
 * the code said "one, globally". That difference is invisible while there is
 * exactly one provider and is the whole problem the moment there are two.
 *
 * WHY A REGISTRY RATHER THAN 33 NEW SIGNATURES. Every one of those jobs takes a
 * provider argument, and threading a second one through all of them means every
 * caller decides which provider a league is on — which is how the answer starts
 * differing between call sites. The league row already knows. So the jobs keep
 * their argument as a default, and the per-league send sites ask here instead.
 *
 * A MISSING PROVIDER IS AN ERROR, NOT SILENCE. If a league is on Discord and
 * Discord is not configured, this throws. The alternative is a send that
 * returns without sending, which is the failure mode this codebase keeps
 * writing comments about: nothing errors, the messages just stop arriving.
 */

/** Built once each, on demand. Constructing a client is cheap but not free. */
const cache = new Map();

/** What a league with no provider recorded is assumed to be on. */
const DEFAULT = 'sendblue';

const BUILDERS = {
  sendblue() {
    const id = process.env.SENDBLUE_API_KEY_ID;
    const secret = process.env.SENDBLUE_API_SECRET_KEY;
    if (!id || !secret) return null;
    const { SendblueProvider } = require('./sendblue');
    return new SendblueProvider(id, secret, { fromNumber: process.env.SENDBLUE_FROM_NUMBER });
  },

  discord() {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) return null;
    const { DiscordProvider } = require('./discord');
    return new DiscordProvider(token);
  },
};

/**
 * The instance for a provider name, or null when it is not configured.
 *
 * Null rather than a throw, because "is Discord set up on this deployment"
 * is a legitimate question with a legitimate no — the worker asks it at boot
 * to decide what to log. Callers that need one call `require` instead.
 */
function get(name) {
  const key = String(name || DEFAULT).toLowerCase();
  if (cache.has(key)) return cache.get(key);
  const build = BUILDERS[key];
  const made = build ? build() : null;
  cache.set(key, made);
  return made;
}

/** Like get(), but says what is wrong instead of returning nothing. */
function require_(name) {
  const key = String(name || DEFAULT).toLowerCase();
  if (!BUILDERS[key]) throw new Error(`unknown messaging provider: ${key}`);
  const made = get(key);
  if (!made) {
    throw new Error(
      `${key} is not configured on this deployment. `
      + (key === 'discord'
        ? 'Set DISCORD_BOT_TOKEN.'
        : 'Set SENDBLUE_API_KEY_ID and SENDBLUE_API_SECRET_KEY.'));
  }
  return made;
}

/** The provider a league row is on. */
function forLeague(league) {
  return require_(league?.provider || DEFAULT);
}

/**
 * Send to a league's own thread, over that league's own provider.
 *
 * The call the per-league jobs should be making. `league.chat_id` and
 * `league.provider` travel together on the same row, so taking the league
 * rather than a chat id removes the case where one is resolved from the row
 * and the other from whatever was passed in.
 */
function sendToLeague(league, text, opts = {}) {
  if (!league?.chat_id) {
    return Promise.reject(new Error(`league ${league?.id || '?'} has no chat_id`));
  }
  return forLeague(league).send(league.chat_id, text, { leagueId: league.id, ...opts });
}

/** Which providers this deployment could actually use. For boot logging. */
function configured() {
  return Object.keys(BUILDERS).filter(name => get(name));
}

/** Tests build providers from env; this lets them change it. */
function reset() { cache.clear(); }

module.exports = { get, require: require_, forLeague, sendToLeague, configured, reset, DEFAULT };
