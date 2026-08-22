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
    /*
     * "Go hard" was too vague to do anything, and the clause after it undid
     * what little it did — the result read as snarky with more adjectives.
     *
     * The headroom that does not touch the guardrail is escalation, memory and
     * theatre: refuse to let it go, reach back into their career for ammunition,
     * and be dramatic about your own reaction. None of that is a remark about a
     * person. All of it is what makes somebody read it twice.
     */
    recap: 'MAXIMUM. Do not soften, do not hedge, do not settle it in one line. ' +
      'Escalate: name the mistake, then what it cost, then the pattern it fits, then pass a verdict. ' +
      'Reach into their history — career record, title drought, the last time they did exactly this. ' +
      'Theatrical is good: declare things, hand out awards nobody wanted, act personally inconvenienced ' +
      'by their lineup. You may stay on one manager for the whole recap if they earned it. ' +
      'The target never moves: the decision and the record. Never a label for the person. ' +
      'If nobody in the chat would go "damn", you were not going hard enough.',
    reply: 'MAXIMUM. Do not soften and do not hedge. Escalate past the obvious point: what it cost, ' +
      'the pattern it fits, and a verdict. Reach into their career record for ammunition. ' +
      'Theatrical is good — be dramatic about your own reaction to their lineup. ' +
      'The target never moves: the decision and the record, never a label for the person. ' +
      'If nobody would go "damn", you were not going hard enough.',
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
