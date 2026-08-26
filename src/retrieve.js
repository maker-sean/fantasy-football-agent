/**
 * Decide which context sections a question actually needs.
 *
 * Every reply used to carry the whole league: standings, careers, extremes,
 * every graded trade, the draft board. For Halcyon that is 5,738 tokens paid
 * on every message whether or not anybody asked, and 65% of it is career
 * history that most questions never touch. For a league with a hundred and
 * seventy-seven trades it does not fit at all.
 *
 * So a small model reads the question first and names the sections. What it
 * CANNOT do is write the lookup. The sections are fixed, their contents are
 * computed in code, and this pass is pure classification — pick from a menu.
 * That distinction is the whole design: the recurring failure in this codebase
 * is the model deriving a fact it should have been handed, and a router that
 * composed its own query would put it right back in that business.
 *
 * Failure is open, never closed. A router that errors, times out, or answers
 * with nonsense loads everything, which is exactly the behaviour that shipped
 * before this file existed. Being slow and expensive is a bad outcome; being
 * wrong because a section was missing is a much worse one.
 */

const Anthropic = require('@anthropic-ai/sdk');

// Cheap and fast on purpose. This pass adds a round trip to a reply that a
// group chat is waiting on, so it gets the small model and no thinking budget.
const MODEL = process.env.ROUTER_MODEL || 'claude-haiku-4-5-20251001';

/*
 * The menu.
 *
 * Written for the router, not for a human: each line says what QUESTIONS the
 * section answers, because that is what the model is matching against. Naming
 * the tables it came from would be describing the plumbing to something that
 * only ever sees the question.
 */
const SECTIONS = {
  history: 'Past seasons: final standings, career win-loss records, championships, '
         + 'head-to-head, highest and lowest scores ever, biggest blowouts, closest '
         + 'games, worst benched players. ANY question about a previous year, about '
         + 'who is best or worst all time, about records, or about what usually '
         + 'happens. Also needed for "who is good at this" and rivalry questions.',
  trades: 'Every settled trade, who won and lost each, by points and by value over '
        + 'replacement, what each side gave up and got, and each manager\'s trade '
        + 'win-loss record. Any question about trading, fleecing, a specific past '
        + 'trade, or whether a deal was fair.',
  draft: 'The draft: whether it is live, who is on the clock, what they should take, '
       + 'who picked last and whether it made sense, roster needs by position, best '
       + 'players available. Any question about drafting or picks.',
  roster: 'Sleeper projections for THIS WEEK for the person asking, and who is in '
        + 'their starting lineup. Start-sit questions, "who should I play", waiver '
        + 'and pickup questions about their own team.',
};

const NAMES = Object.keys(SECTIONS);

const MENU = NAMES.map(n => `- ${n}: ${SECTIONS[n]}`).join('\n');

const SYSTEM = `You route questions in a fantasy football group chat to the reference sections needed to answer them.

Sections:
${MENU}

Some facts are always present and are NEVER a reason to name a section: the league name, this season's standings, who is in the league, and who each chat participant is.

You may also request ONE lookup, which runs a real query and computes an answer that is not in any section. Lookups available:
- trade_extremes: the fairest or the most lopsided trades. Arguments: order=even or order=lopsided (required), manager=<name> (optional), season=<year> (optional).

Ask for a lookup whenever the question wants a RANKING or an EXTREME. That covers the closest or fairest trade, the worst or biggest one, and any of those narrowed to one manager or one season.

When you ask for a lookup that fully answers the question, do NOT also name the section it came from. The lookup is computed for this exact question and is more precise than the standing block, and loading both costs more and answers no better.

Reply in exactly this shape and nothing else:
sections: <comma separated names, or none>
lookup: <name arg=value ..., or none>

Name a section when the answer would DRAW ON it, not only when the question names it. "Did I get fleeced" is trades. "Am I any good" is history. "Who should I start" is roster. When a question could plausibly need a section, include it — a section that goes unused is cheap, a missing one makes the answer wrong. Never name more than three.`;

/**
 * @param question   the text that addressed the bot
 * @param opts.recentChat  last few messages, for pronouns and follow-ups
 * @returns {sections, meta} — sections is an array for contextBlock's `only`
 */
async function route(question, opts = {}) {
  const { model = MODEL, recentChat = [], client = new Anthropic() } = opts;

  /*
   * Recent chat matters more here than it does when answering. "Was that a
   * good one?" names nothing at all; the message before it is the only thing
   * that says whether "that" was a trade or a draft pick.
   */
  const chat = recentChat.length
    ? 'Recent messages before it:\n' + recentChat.map(m => `  ${m.who}: ${m.text}`).join('\n') + '\n\n'
    : '';

  const started = Date.now();
  let response;
  try {
    response = await client.messages.create({
      model,
      max_tokens: 64,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `${chat}Someone said to the bot:\n"${question}"\n\nSections:` }],
    });
  } catch (err) {
    return { sections: NAMES, lookup: null, meta: { fellBack: 'error', error: err.message, ms: Date.now() - started } };
  }

  const raw = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();

  const secLine = (raw.match(/sections?:\s*(.*)/i) || [, raw])[1] || '';
  const picked = secLine.toLowerCase().split(/[,\s]+/).map(w => w.trim()).filter(w => NAMES.includes(w));

  /*
   * The lookup, parsed strictly and validated against the registry before it
   * can reach a query. Anything unrecognised is dropped rather than guessed at:
   * a malformed lookup costs one missing block, a wrongly-coerced one costs a
   * wrong answer stated with confidence.
   */
  let lookup = null;
  const lkLine = (raw.match(/lookups?:\s*(.*)/i) || [])[1];
  if (lkLine && !/^\s*none\b/i.test(lkLine)) {
    const parts = lkLine.trim().split(/\s+/);
    const name = parts.shift();
    const { QUERIES } = require('./retrievers');
    if (QUERIES[name]) {
      const args = {};
      for (const kv of parts) {
        const [k, v] = kv.split('=');
        if (!k || !v) continue;
        const spec = QUERIES[name].args[k];
        if (!spec) continue;
        // An enumerated argument only ever takes one of its listed values.
        if (Array.isArray(spec) && !spec.includes(v)) continue;
        args[k] = v;
      }
      lookup = { name, args };
    }
  }

  /*
   * "none" is a real answer and has to survive the empty check, or every
   * standings question would fall back to loading the entire league.
   */
  const saidNone = /\bnone\b/i.test(raw);
  if (!picked.length && !saidNone) {
    return { sections: NAMES, lookup, meta: { fellBack: 'unparsed', raw, ms: Date.now() - started } };
  }

  return {
    sections: [...new Set(picked)],
    lookup,
    meta: { raw, ms: Date.now() - started, model: response.model, usage: response.usage },
  };
}

module.exports = { route, SECTIONS, NAMES, MODEL };
