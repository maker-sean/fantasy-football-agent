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

// Sonnet while the voice is being tuned — the recap is ~100 words once a week,
// so the model choice is about output quality, not cost at this volume. Bump
// back to claude-opus-4-8 before production and compare on real weeks:
//   node scripts/recap.js --week 10 --model claude-opus-4-8
const MODEL = process.env.RECAP_MODEL || 'claude-sonnet-5';

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
- One team per message. Pick the single manager whose week is most worth talking
  about and stay on them. Trying to cover the whole league in one breath is how a
  message becomes a newsletter nobody reads.
- No emoji unless it is doing real work. Never more than one.
- No em dashes, ever. Use a comma, a full stop, or a colon instead. Em dashes are
  the clearest tell that a message was machine-written, and this has to read like
  a person typing in a group chat.

Format:
- Plain text for a phone screen. No markdown, no headers, no bullet characters.
- LENGTH_RULE
- Open with the single most interesting thing that happened, not a summary of the slate.
- End on something that invites a reply: a callout, a question, a challenge. Never end with a summary sentence.
- If a second team had a week genuinely worth mentioning, write a SECOND MESSAGE
  rather than a longer one. Separate messages with a line containing only ---
  Two short texts arriving back to back read like a person typing. One long text
  reads like a newsletter, and gets scrolled past.
- At most three messages, and only if each earns its place. One is usually right.

Absolute rules:
- Every number and name you use MUST come verbatim from the FACTS provided. Do not compute, estimate, round, or infer any figure.
- If a fact is not in FACTS, you do not know it. Never invent a player, a score, a record, or a storyline.
- Do not mention that you are an AI, a bot, or that facts were provided to you.

Ranking claims — read this twice:
- Words like "only", "biggest", "closest", "worst", "blowout", "barely" are CLAIMS ABOUT RANK, not decoration. Use one only when FACTS explicitly labels that item that way.
- FACTS labels exactly one game "Biggest blowout" and exactly one "Closest game". The closest game has the SMALLEST margin of the week. Never describe a small margin as a large one, or a narrow win as decisive.
- Before you write a comparative, check it against the full results list at the bottom of FACTS. A correct number inside a false comparison is still a false statement, and the league will notice.`;

function factsBlock(facts) {
  // Hand the model a compact, unambiguous fact sheet. Anything absent from
  // here is something it is forbidden to say.
  const lines = [];
  lines.push(`Week ${facts.week} of the ${facts.season} season. League: ${facts.leagueName}.`);
  // The model needs the format to reason about lineups correctly — a swap that
  // is legal in a superflex league is nonsense in a single-QB one.
  if (facts.rules) {
    const tags = [];
    if (facts.rules.superflex) tags.push('starts more than one QB');
    if (facts.rules.idp) tags.push('starts individual defensive players (IDP)');
    lines.push(`Lineup format: ${facts.rules.summary}.${tags.length ? ' This league ' + tags.join(' and ') + '.' : ''}`);
    for (const f of facts.rules.flexTypes || []) {
      lines.push(`  ${f.slot} may be filled by: ${f.accepts.join(', ')} only.`);
    }
  }

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
    lines.push(`Worst lineup decision: ${r.team} started ${r.started} (${r.startedPoints} points) in the ${r.slot} slot while ${r.benched} (${r.benchedPosition}, ${r.benchedPoints} points) sat on their bench — a legal swap they missed, worth ${r.swing}.`);
  }
  if (facts.mostPointsLeftOnTable) {
    const t = facts.mostPointsLeftOnTable;
    lines.push(`Most points left on the table: ${t.team} started ${t.started} when their best legal lineup from the same roster was ${t.optimal} — ${t.left} wasted.`);
  }
  for (const g of facts.gooseEggs || []) {
    lines.push(`${g.team} started ${g.players.join(' and ')} for zero points.`);
  }
  for (const g of facts.games || []) {
    if (g.loserCouldHaveWon) {
      lines.push(`${g.loserCouldHaveWon.team} lost by ${g.margin} but their optimal lineup (${g.loserCouldHaveWon.optimal}) would have beaten ${g.winner}'s ${g.winnerPoints}.`);
    }
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
 * @param opts.words target length, default 100. ASSUMED, NOT MEASURED — revisit.
 *                   The reasoning: a group text is skimmed, and a wall of text
 *                   ends a conversation rather than starting one. The cost: a
 *                   12-team week has six games and 100 words covers two or
 *                   three, so real jokes get dropped. Settle it with reply rate
 *                   once the bot is posting weekly (RECAP_WORDS, or --words).
 */
async function generateRecap(facts, opts = {}) {
  const {
    spice = 1, effort = 'medium', model = MODEL,
    words = Number(process.env.RECAP_WORDS || 60),
    client = new Anthropic(),
  } = opts;

  const lo = Math.max(20, Math.round(words * 0.75));
  const hi = Math.round(words * 1.25);
  // Per MESSAGE, not per recap. Two short texts back to back beat one long one.
  const lengthRule = `${lo}-${hi} words PER MESSAGE. This is a group text, not a newsletter.`;

  const spiceNote = [
    'Keep it gentle this week. Observational, barely any edge.',
    'Normal league energy. Tease the obvious blunders.',
    'Go hard. Still never cruel, and still only about football decisions.',
  ][Math.max(0, Math.min(2, spice))];

  const response = await client.messages.create({
    model,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort },
    system: [
      // Length is part of the cached prefix, so changing it invalidates the
      // cache — fine, it changes rarely and per-league at most.
      { type: 'text', text: PERSONA.replace('LENGTH_RULE', lengthRule), cache_control: { type: 'ephemeral' } },
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
      targetWords: words,
    },
  };
}

/**
 * Split generated text into the messages it should actually be sent as.
 *
 * The model separates them with a line containing only ---. Everything is
 * tolerant of it being absent: a single message is the common case and the
 * right default.
 */
function splitMessages(text) {
  return String(text || '')
    .split(/\n\s*-{3,}\s*\n/)
    .map(t => t.trim())
    .filter(Boolean);
}

module.exports = {
  splitMessages, generateRecap, factsBlock, PERSONA, MODEL };
