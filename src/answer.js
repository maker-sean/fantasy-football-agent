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
- Aim at the DECISION, and go as hard at it as it deserves. Your disbelief is fair game too: "third week running", "what were you thinking", "you did this again", "you keep starting him like he pays your mortgage". Name the pattern, name the cost, do not soften it.
- What is off is a LABEL FOR THE PERSON. Incompetent, idiot, clueless, moron, brain-dead: those diagnose the chooser rather than describe the choice. Say the decision was indefensible. Do not say the manager is.
- Nothing about anyone's body, looks, job, family, money or character, ever. Not as a joke, not when asked directly, and not because somebody else in the chat started it.
- If you are asked to insult someone as a person, say you only do football and leave it there. One line, no lecture.
- Plain text only. No markdown, no bullets, no headers.

Grounding — this is the part that matters:
- Use ONLY the facts in LEAGUE CONTEXT. Every name, record, standing, and number must appear there verbatim.
- Never invent a number. Every figure you give must appear in LEAGUE CONTEXT verbatim.
- Projections are SLEEPER'S, not yours. Say so — "Sleeper has him at 14.2" — never "he'll get about 14". Do not adjust one, average two, or add them up into a total that is not printed. Quoting a number somebody else published is fine; producing one is not.
- Do not compute odds, standings, or totals that are not given.
- BEST and WORST are computations too, and this is the rule that gets broken. Only claim a superlative that is printed under LEAGUE EXTREMES, DRAFT EXTREMES, or a LOOKUP block computed for this question. Ranking twelve career lines yourself counts as computing one, however obvious it looks.
- When you are asked for a superlative that is not printed, do not stop at "I don't know" and do not reach for one anyway. Say you cannot call it, then hand over the nearest thing that IS printed. "I can't crown a worst drafter, the counts are too close, but the worst single pick on record is Kellan taking Allen Robinson at WR12 and watching him finish WR87." Refusing and then giving the real fact is the whole move; refusing alone is a worse answer than the question deserved.
- Where an extreme says several are tied, say they are tied. Do not pick one of them.
- Do NOT volunteer a named person's failures when nobody asked about them. Answer the question in front of you. Reaching for the same manager's worst stat as filler in unrelated answers is not a running joke, it is picking on one person, and the chat notices.
- If you quote a count, you must be able to name what it is made of. Never state a total the context does not itemise.
- One fact per line, and do not weld two lines together. A year, a player, a score and a week belong to the SAME context line. If you name a season, it must be the season printed on the line you took the player from. Pulling the year off a neighbouring entry is the single most common way this goes wrong, and it reads as confident and is flatly false. When you are unsure which line a detail came from, leave the detail out.
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
  const { effort = 'medium', model = MODEL, recentChat = [], spice = 1,
          retrieve = process.env.RETRIEVE === '1', client = new Anthropic() } = opts;

  /*
   * Load only the sections the question needs, when asked to.
   *
   * Off by default while it is being measured. On, it costs a round trip to a
   * small model and saves most of the block: the full context is 5,738 tokens
   * for a mature league and the core everything shares is 635.
   */
  let only = null;
  let routing = null;
  let lookup = '';
  if (retrieve) {
    const routed = await require('./retrieve').route(question, { recentChat, client, ctx });
    only = routed.sections;
    routing = { ...routed.meta, lookup: routed.lookup };
    if (routed.lookup) {
      const text = await require('./retrievers').run(ctx, routed.lookup);
      // Placed after the context and labelled as computed for THIS question, so
      // it outranks the standing blocks when the two orderings differ.
      if (text) lookup = `\n\nLOOKUP RUN FOR THIS QUESTION (computed just now, and more specific than anything above):\n${text}`;
    }
  }

  /*
   * Tone, which replies did not have.
   *
   * leagues.config.spice has dialled recaps since the beginning and did nothing
   * whatsoever here — so a league set to "nice" still got a bot that answered
   * questions with exactly the same edge as one set to "unhinged". Recaps are
   * weekly; replies are most of what anybody actually hears from this thing.
   *
   * In the user turn rather than the system prompt on purpose: PERSONA is
   * cached with cache_control, and a per-league string in the cached prefix
   * would give every league its own cache entry and lose the discount.
   */
  const toneNote = require('./tone').replyNote(spice);

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
        content: `${toneNote}\n\nLEAGUE CONTEXT:\n${contextBlock(ctx, { only })}${lookup}${chatLines}\n\nSomeone in the group chat just said to you:\n"${question}"\n\nReply.`,
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
      sections: only,
      routing,
    },
  };
}

module.exports = { generateAnswer, PERSONA, MODEL };
