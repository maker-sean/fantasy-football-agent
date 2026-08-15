/**
 * The agent brain — weekly roast recap.
 *
 * Division of labor, deliberately strict:
 *   src/stats.js  computes every number (deterministic, testable, no API key)
 *   this file     turns those numbers into voice
 *
 * The model is told, explicitly, that it may not invent or recompute a figure.
 * Language models are confidently wrong at arithmetic, and a bot that misreports
 * a margin of victory in a league chat loses credibility permanently — the one
 * thing a trash-talk bot cannot afford.
 *
 * Returns { text, audience } rather than a bare string. The audience field is
 * the seam that keeps the 1:1-concierge pivot cheap: if group size turns out to
 * cap below league size, a delivery layer fans the same content out to members
 * individually without the agent changing at all.
 */

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.RECAP_MODEL || 'claude-opus-4-8';

/**
 * Stable across every league and week — this is the cache prefix. Nothing
 * volatile (week number, team names, timestamps) belongs in here, or prompt
 * caching silently stops working. See shared/prompt-caching.md.
 */
const PERSONA = `You are the resident bot in a long-running fantasy football league group chat. You have been in this league's group thread for years and you talk like it.

Your job each week is a short recap that makes people want to reply.

Voice:
- You are a league member, not a broadcaster. No "folks", no "let's dive in", no segment transitions.
- Dry and specific. The joke is always in the detail, never in the adjective.
- Punch at decisions, not people. Benching a 27-point QB is fair game; someone's job or family is not.
- Confidence is funnier than cruelty. Never pile on the same manager twice in one recap.
- No emoji unless it is doing real work. Never more than one.

Format:
- Plain text for a phone screen. No markdown, no headers, no bullet characters.
- 60-110 words. This is a group text, not a newsletter.
- Open with the single most interesting thing that happened, not a summary of the slate.
- End on something that invites a reply — a callout, a question, a challenge. Never end with a summary sentence.

Absolute rules:
- Every number and name you use MUST come verbatim from the FACTS provided. Do not compute, estimate, round, or infer any figure.
- If a fact is not in FACTS, you do not know it. Never invent a player, a score, a record, or a storyline.
- Do not mention that you are an AI, a bot, or that facts were provided to you.`;

function factsBlock(facts) {
  // Hand the model a compact, unambiguous fact sheet. Anything absent from
  // here is something it is forbidden to say.
  const lines = [];
  lines.push(`Week ${facts.week} of the ${facts.season} season. League: ${facts.leagueName}.`);

  if (facts.highScore) lines.push(`High score: ${facts.highScore.team} with ${facts.highScore.points}.`);
  if (facts.lowScore) lines.push(`Low score: ${facts.lowScore.team} with ${facts.lowScore.points}.`);

  if (facts.blowout) {
    lines.push(`Biggest blowout: ${facts.blowout.winner} beat ${facts.blowout.loser}, ${facts.blowout.winnerPoints} to ${facts.blowout.loserPoints}, margin ${facts.blowout.margin}.`);
  }
  if (facts.nailbiter && facts.nailbiter !== facts.blowout) {
    lines.push(`Closest game: ${facts.nailbiter.winner} beat ${facts.nailbiter.loser}, ${facts.nailbiter.winnerPoints} to ${facts.nailbiter.loserPoints}, margin ${facts.nailbiter.margin}.`);
  }

  if (facts.biggestRegret) {
    const r = facts.biggestRegret;
    lines.push(`Worst lineup decision: ${r.team} benched ${r.benched} (${r.benchedPoints} points) and started ${r.started} (${r.startedPoints} points), a swing of ${r.swing}${r.samePosition ? ' at the same position' : ''}.`);
  }
  if (facts.mostBenchPoints) {
    lines.push(`Most points left on the bench: ${facts.mostBenchPoints.team} with ${facts.mostBenchPoints.points}.`);
  }
  for (const g of facts.gooseEggs || []) {
    lines.push(`${g.team} started ${g.players.join(' and ')} for zero points.`);
  }

  lines.push('');
  lines.push('All results this week:');
  for (const g of facts.games || []) {
    lines.push(`  ${g.winner} ${g.winnerPoints} def. ${g.loser} ${g.loserPoints} (margin ${g.margin})`);
  }

  return lines.join('\n');
}

/**
 * @param facts      output of stats.weekFacts
 * @param opts.spice 0-2 — how hard the bot punches. The "spiciness dial" from
 *                   the product plan, wired in from the start because it is far
 *                   harder to retrofit tone than to carry it through.
 */
async function generateRecap(facts, opts = {}) {
  const { spice = 1, effort = 'medium', client = new Anthropic() } = opts;

  const spiceNote = [
    'Keep it gentle this week. Observational, barely any edge.',
    'Normal league energy. Tease the obvious blunders.',
    'Go hard. Still never cruel, and still only about football decisions.',
  ][Math.max(0, Math.min(2, spice))];

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort },
    system: [
      { type: 'text', text: PERSONA, cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      {
        role: 'user',
        content: `${spiceNote}\n\nFACTS:\n${factsBlock(facts)}\n\nWrite this week's recap.`,
      },
    ],
  });

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();

  return {
    text,
    audience: 'group',
    meta: {
      model: response.model,
      stopReason: response.stop_reason,
      usage: response.usage,
      week: facts.week,
      season: facts.season,
    },
  };
}

module.exports = { generateRecap, factsBlock, PERSONA, MODEL };
