/**
 * "bot stop" is a mute, not an opt-out.
 *
 * These are two different things and conflating them is the mistake worth
 * avoiding. STOP, on its own, is a legal opt-out: it stops all messages to that
 * number permanently and it is what carriers audit. "bot stop" is somebody in a
 * group chat saying shut up, and they will want the bot back before the end of
 * the day. Wiring the second into the first would take five minutes of
 * irritation and turn it into a compliance record — and in a group it would
 * either silence the bot for twelve other people or unsubscribe one of them,
 * neither of which is what was meant.
 *
 * So this sets league.config.paused, which src/decide.js already honours as
 * league_paused, and STOP is left entirely alone to the provider.
 *
 * WHAT FOLLOWS THE WORD IS THE WHOLE TRICK. An imperative "stop" with nothing
 * after it is a mute; "stop" with a complement is a sentence about something.
 *
 *   bot stop                        -> mute
 *   bot please stop                 -> mute
 *   bot stop please                 -> mute
 *   bot stop picking on Kellan        -> NOT a mute, there is an object
 *   bot why don't you stop picking  -> NOT a mute, it does not open with the name
 *
 * The regex is anchored at both ends for exactly that reason, and the failure
 * direction is deliberate: an unrecognised mute leaves the bot talking, which
 * somebody can repeat, while a false positive silences a league that has to
 * work out why.
 */

const db = require('./db');
const { DEFAULT_BOT_NAMES } = require('./decide');

const QUIET = '(stop|shut\\s*up|be\\s+quiet|quiet|pause|shush|enough)';
const WAKE = '(start|resume|unpause|unmute|wake\\s*up|come\\s+back)';

const escape = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function namesFor(league) {
  const raw = league?.config?.botNames;
  const list = (Array.isArray(raw) ? raw : [raw])
    .map(n => (n == null ? '' : String(n).trim())).filter(Boolean);
  return (list.length ? list : DEFAULT_BOT_NAMES).map(escape).join('|');
}

const build = (names, verbs) => new RegExp(
  `^\\s*(?:${names})\\b[\\s,:.!-]*(?:please\\s+)?${verbs}(?:\\s+please)?[\\s.!]*$`, 'i');

const isMute = (text, league) => build(namesFor(league), QUIET).test(String(text || ''));
const isWake = (text, league) => build(namesFor(league), WAKE).test(String(text || ''));

/**
 * Handle a mute or a wake. Returns null when the burst is neither.
 *
 * A WAKE MUST GET THROUGH WHILE PAUSED. That is the same rule control.js states
 * for recap approval: the one message that has to land is the one a paused bot
 * would suppress. So this runs before the reply gate and sends directly rather
 * than through anything that consults the flag it is trying to clear.
 */
async function handleMute({ burst, league, send }) {
  if (!burst?.length || !league) return null;

  const muted = Boolean(league.config?.paused);
  const hit = burst.find(m => (muted ? isWake(m.text, league) : isMute(m.text, league)));
  if (!hit) return null;

  const paused = !muted;
  await db.query(
    `update leagues set config = coalesce(config, '{}'::jsonb) || $2::jsonb where id = $1`,
    [league.id, JSON.stringify({ paused })]
  );

  /*
   * A mute CONFIRMS, unlike STOP, which deliberately says nothing.
   *
   * Silence after being told to be quiet is indistinguishable from the bot
   * having broken, and "is it off or is it dead" is the exact ambiguity this
   * system keeps trying to remove. It also has to say how to undo it, or the
   * league has muted something with no visible way back.
   */
  const name = (league.config?.botNames || DEFAULT_BOT_NAMES)[0] || 'bot';
  const text = paused
    ? `Quiet. Say "${name} start" when you want me back.`
    : `Back. Say "${name} stop" if you regret it.`;

  if (send) await send(text);
  return { handled: true, paused, reply: text, triggerMessageId: hit.messageId };
}

module.exports = { handleMute, isMute, isWake, QUIET, WAKE };
