/**
 * How hard the bot punches, in one place.
 *
 * The dial already existed as leagues.config.spice, 0 to 2, and it was wired
 * into recaps from the start on the reasoning that tone is far harder to
 * retrofit than to carry through. Two things were missing: it had no NAME
 * anybody could pick from — the settings screen offered an unlabelled slider —
 * and it did nothing at all to conversational replies, which are most of what a
 * league actually hears.
 *
 * Stored as a number rather than a string because config.spice is already that,
 * in a live database, read by recap.js and weekly.js. Renaming the stored value
 * to buy a nicer-looking column would be a migration in exchange for nothing.
 *
 * THE GUARDRAIL IS NOT PART OF THE DIAL. Every level, including the loudest, is
 * about football decisions and never about the person. That is not primness: a
 * bot on an A2P-registered number being cruel to somebody in their own group
 * chat is how a number gets reported, and the people in these chats did not
 * choose to be here — the commissioner added them.
 */

const LEVELS = [
  {
    spice: 0,
    key: 'nice',
    label: 'Nice',
    blurb: 'Observational. Notices things, never needles anybody.',
    recap: 'Keep it gentle this week. Observational, barely any edge.',
    reply: 'Warm and dry. Point things out, do not needle anybody.',
  },
  {
    spice: 1,
    key: 'snarky',
    label: 'Snarky',
    blurb: 'League-group-chat normal. Teases the obvious blunders.',
    recap: 'Normal league energy. Tease the obvious blunders.',
    reply: 'Normal league energy. Tease an obvious blunder when there is one.',
  },
  {
    spice: 2,
    key: 'unhinged',
    label: 'Unhinged',
    blurb: 'Swings hard at bad lineup decisions. Still never at the person.',
    recap: 'Go hard. Still never cruel, and still only about football decisions.',
    reply: 'Go hard. Still never cruel, and still only about football decisions.',
  },
];

const clamp = n => Math.max(0, Math.min(2, Number.isFinite(Number(n)) ? Math.round(Number(n)) : 1));

/** Accepts a number, a key, or a whole league. Defaults to snarky. */
function level(input) {
  if (input && typeof input === 'object') {
    return level(input.config ? input.config.spice : input.spice);
  }
  if (typeof input === 'string') {
    const byKey = LEVELS.find(l => l.key === input.toLowerCase());
    if (byKey) return byKey;
  }
  return LEVELS[clamp(input ?? 1)];
}

const recapNote = input => level(input).recap;
const replyNote = input => level(input).reply;

module.exports = { LEVELS, level, recapNote, replyNote, clamp };
