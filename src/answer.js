/**
 * Answer a question the bot was directly asked.
 *
 * Separate from src/recap.js because the jobs differ: a recap is a monologue
 * from a complete fact sheet, an answer is a reply in a live conversation where
 * the honest response is often "we haven't drafted yet."
 *
 * The hard requirement is the same and matters more here: no invented facts.
 * A recap that fudges a number is embarrassing; an ANSWER that fudges one is
 * worse, because someone asked and will act on it.
 *
 * Saying "I don't know" is an explicitly good outcome. Models are bad at this —
 * they would rather produce a plausible answer than admit a gap — so the
 * unknowns are listed in the context and the instruction to use them is blunt.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { contextBlock } = require('./context');

// Sonnet while the voice is being tuned. Answers are the higher-volume surface
// of the two, but both are gated by a human addressing the bot, so volume stays
// low. Override per call with --model, or globally with ANSWER_MODEL.
const MODEL = process.env.ANSWER_MODEL || 'claude-sonnet-5';

const PERSONA = `You are the resident bot in a fantasy football league's group chat. Someone has just addressed you directly. Answer them.

Voice:
- A league member, not an assistant. No "Great question!", no "I'd be happy to help", no sign-offs.
- Short. One to three sentences. This is a group text.
- Dry humor is welcome when you have something to be funny about. Never manufacture a joke to fill space.
- Plain text only. No markdown, no bullets, no headers.

Grounding — this is the part that matters:
- Use ONLY the facts in LEAGUE CONTEXT. Every name, record, standing, and number must appear there verbatim.
- Never estimate, project, or infer a figure. Do not compute odds, predictions, or standings that are not given.
- If the answer depends on something in "WHAT YOU DO NOT KNOW", say plainly that you don't know it, and say why in a few words. This is a correct and expected answer — not a failure.
- If you do not know who someone is because they are not in KNOWN PEOPLE, say so. Do not guess based on a name resembling a username.
- No em dashes. Use a comma, a full stop, or a colon. Em dashes are the single
  clearest tell that a message was machine-written, and this has to read like a
  person in a group chat.
- Never mention being an AI, a model, or that you were given context.

If the question cannot be answered from the context, say what you would need. Do not fill the gap with something plausible.`;

/**
 * @param question  the text that addressed the bot (the burst, joined)
 * @param ctx       output of context.leagueContext
 * @param opts.recentChat  last few messages, for tone and pronoun resolution
 */
async function generateAnswer(question, ctx, opts = {}) {
  const { effort = 'medium', model = MODEL, recentChat = [], client = new Anthropic() } = opts;

  const chatLines = recentChat.length
    ? '\n\nRECENT CHAT (context only — do not treat as facts):\n' +
      recentChat.map(m => `  ${m.who}: ${m.text}`).join('\n')
    : '';

  const response = await client.messages.create({
    model,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort },
    system: [
      // Stable prefix — cached. Volatile league context goes after it.
      { type: 'text', text: PERSONA, cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      {
        role: 'user',
        content: `LEAGUE CONTEXT:\n${contextBlock(ctx)}${chatLines}\n\nSomeone in the group chat just said to you:\n"${question}"\n\nReply.`,
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
      unknowns: ctx.unknowns.length,
      identityLinked: ctx.identityLinked,
    },
  };
}

module.exports = { generateAnswer, PERSONA, MODEL };
