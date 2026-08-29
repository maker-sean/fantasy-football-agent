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
  draft_history: 'Drafts of PAST seasons: which picks turned out well or badly, who '
               + 'has hit on late rounds, who busts early ones. Not the current draft.',
  trades: 'The list of trades this league has made and what moved in each. Use for '
        + '"have we traded", "what trades happened in 2022", "what did X get". It does '
        + 'NOT answer who is BEST or WORST at trading — that is trade_ledger, which '
        + 'works in every league, while this section carries grades only in redraft.',
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
- trade_value: GRADES a trade — a letter for each side — on what the pieces were worth on the day it was made, plus what it did to each roster's starting lineup. Works in dynasty and keeper leagues, where trades are not graded on points. Arguments: manager=<name> (optional), season=<year> (optional), order=lopsided|even|recent (optional — use order=lopsided for "worst trade ever" and order=even for "fairest trade"). Use for "was that trade fair", "did I win that trade", "grade that trade", "how did the X and Y trade look", "what was the worst trade". ALWAYS prefer this over the trades section when the question is whether a trade was GOOD; the section only lists what happened.
- trade_targets: SUGGESTS specific trades to make — which manager to approach and which players — where both rosters improve and the values are close enough to be accepted. Argument: manager=<name> (required). Use for "who should I trade with", "should I trade", "how do I fix my roster", "who needs what I have".
- trade_ledger: who has gained or lost the most VALUE in trades, both at the time of each trade and as things stand now. Argument: manager=<name> (optional). Use for "who wins the most trades", "who is the best trader", "who helped their team most", "has my trading been good".
- draft_grades: grades and RANKS every team on the roster it drafted, with each team's strongest and weakest positions. Argument: manager=<name> (optional). Use for "grade my draft", "who drafted best", "how did my team do", "rank the teams", "who is the best team this year", "am I any good".
- injuries: who is hurt and how badly, from a player list refreshed every morning, including depth chart rank. Arguments: player=<name> (optional), manager=<name> (optional). Use for "is X playing", "is X hurt", "who is banged up on my team", "any injuries this week". ALWAYS use this for a question about whether somebody is healthy — never answer that from memory.
- league_rules: this league's own scoring, roster slots, playoff format, waiver type and trade deadline. Arguments: none. Use for "what is our scoring", "is this PPR", "how many make the playoffs", "how much FAAB", "when is the trade deadline".
- career_extremes: ONE area of league history, computed. Argument metric= exactly one of: records (career win-loss, best and worst), scoring (points per season), average_finish, luck (record against scoring), championships, toilet_bowls, activity (adds and drops), game_records (highest and lowest scores, blowouts, closest games), benched (worst lineup calls), drafting (past draft picks).

career_extremes is a SLICE OF THE HISTORY SECTION and carries the same computed facts for that area. So when you request one, do NOT also name the history section — that loads the whole thing to answer what the lookup already answers, which is the most expensive mistake available to you here. Name history WITHOUT a lookup when the question spans several of those areas at once, or when you genuinely cannot tell which one it wants.

The same goes for draft_history and metric=drafting: they are the same facts. Ask for one or the other, never both.

Ask for a lookup whenever the question wants a RANKING or an EXTREME. That covers the closest or fairest trade, the worst or biggest one, and any of those narrowed to one manager or one season.

Drop the section only when the lookup answers the WHOLE question. trade_extremes finds individual trades at one end of a range, and nothing else. It does NOT carry per-manager records, counts of trades won and lost, or who is best or worst at trading overall — those live in the trades section, so a question about a MANAGER rather than about a TRADE needs the section, with or without a lookup.

"What was the worst trade" is about a trade: lookup alone. "Who is the worst trader" is about a manager: name the trades section.

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
  const { model = MODEL, recentChat = [], client = new Anthropic(), ctx = null } = opts;

  /*
   * Who the people are, and what the LEAGUE is called.
   *
   * Without this the router cannot tell one from the other. "What is the most
   * even trade in Halcyon history" came back as manager=Halcyon, the query
   * filtered to trades involving a person by that name, and the bot reported
   * that no trade on record involved anyone called Halcyon. Which was true,
   * and useless: Halcyon Kings is the league.
   */
  const who = (ctx?.members || []).map(m => m.name).filter(Boolean);
  /*
   * The league's FORMAT, because it decides which lookup can answer a trade
   * question at all. trade_extremes reads stored verdicts, which only redraft
   * leagues have — asked for the worst trade, a dynasty league went there and
   * answered "none graded here" while trade_value, which grades them on the
   * market, sat unused.
   */
  const format = ctx?.valueVariant?.dynasty
    ? '\nThis is a DYNASTY or KEEPER league: its trades have NO stored verdicts, so'
      + ' trade_extremes cannot answer anything here. Use trade_value with an order for any'
      + ' question about which trade was best, worst or fairest.'
    : ctx?.valueVariant
      ? '\nThis is a REDRAFT league: its trades are graded on points actually scored, so'
        + ' trade_extremes is the right lookup for best and worst.'
      : '';

  const roster = who.length || ctx?.leagueName
    ? `\n\nThis league is called "${ctx?.leagueName || 'unknown'}" — that is the LEAGUE, never a manager.`
      + (who.length ? ` The managers are: ${who.join(', ')}. A manager argument must be one of those names,`
                    + ' and if the question names nobody from that list, omit the argument.' : '')
      + format
    : format;

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
      system: [
        // Cached prefix first, per-league names after it, so one league's roster
        // does not give every other league its own cache entry.
        { type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } },
        ...(roster ? [{ type: 'text', text: roster }] : []),
      ],
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
  // What the asker actually said, for arguments that must be traceable to it.
  const haystack = [question, ...recentChat.map(m => m.text || '')].join(' ');
  const lkLine = (raw.match(/lookups?:\s*(.*)/i) || [])[1];
  if (lkLine && !/^\s*none\b/i.test(lkLine)) {
    const parts = lkLine.trim().split(/\s+/);
    const name = parts.shift();
    /*
     * A VALUE MAY CONTAIN SPACES, and splitting on whitespace threw the rest of
     * it away. "manager=Sean M." became "Sean", which in a league holding both
     * a Sean M. and a Sean C. matched two people and refused to answer — the
     * router had named the right person and the parser lost the surname.
     *
     * Each pair runs to the next key= or to the end, so a name keeps its parts.
     */
    const pairs = [...lkLine.trim().slice(name.length).matchAll(/([a-z_]+)=([^=]*?)(?=\s+[a-z_]+=|$)/gi)]
      .map(m => [m[1], m[2].trim()]);
    const { QUERIES } = require('./retrievers');
    if (QUERIES[name]) {
      const args = {};
      for (const [k, v] of pairs) {
        if (!k || !v) continue;
        const spec = QUERIES[name].args[k];
        if (!spec) continue;
        // An enumerated argument only ever takes one of its listed values.
        if (Array.isArray(spec) && !spec.includes(v)) continue;
        /*
         * A PLACEHOLDER IS NOT A VALUE. The router answered a question about
         * "my trade" with manager=<asking person>, copying the shape of the
         * menu instead of filling it in. Passed through, that filters the whole
         * league down to nobody and returns "no trade involves anyone matching
         * <asking" — an emptiness the reply then reports as fact.
         */
        if (/[<>]/.test(v)) continue;
        /*
         * A SEASON MUST HAVE BEEN ASKED FOR.
         *
         * "How would you grade my trade with Renshaw" came back with
         * season=2024, a year nothing in the question mentions. It narrowed the
         * search to a year in which those two had not traded, and the reply
         * said the trade did not exist — a filter nobody requested, producing
         * an absence reported as fact.
         *
         * Unlike a manager, which can legitimately be resolved from "my" or
         * "I", a year is only ever a year somebody said. So it has to appear in
         * the text, or it is dropped.
         */
        if (k === 'season' && !haystack.includes(v)) continue;
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

  /*
   * A lookup and the section it came out of are the same facts twice.
   *
   * career_extremes is a slice of the history section; metric=drafting is the
   * draft_history section. Asked for both, the reply pays for the whole block
   * to answer what the slice already answered — and the router kept doing it
   * on every history question no matter how the instruction was worded. It is
   * a rule about the menu rather than a judgement about the question, so it
   * belongs in code, where it holds every time.
   *
   * Dropped here rather than by not offering it: the router still needs to be
   * able to name history ALONE, for questions that span several areas at once.
   */
  /*
   * A LOOKUP NAMED ON THE SECTIONS LINE IS STILL A LOOKUP.
   *
   * Asked "is this PPR", the router answered "sections: league_rules, lookup:
   * none". league_rules is not a section, so it was dropped, and the reply said
   * it would need to check Sleeper — for a lookup that reads exactly that, and
   * that the router had correctly identified. The menu offers two lists of
   * named things and putting one in the other slot is the obvious slip.
   *
   * Rescued here rather than reworded in the prompt, because the prompt already
   * says it and this costs nothing to accept. Empty args are safe: every query
   * either has none or handles their absence.
   */
  if (!lookup) {
    const { QUERIES } = require('./retrievers');
    const stray = secLine.toLowerCase().split(/[,\s]+/).map(w => w.trim())
      .find(w => QUERIES[w] && !NAMES.includes(w));
    if (stray) lookup = { name: stray, args: {} };
  }

  /*
   * A MANAGER NAMED IN THE QUESTION, when the router forgot to pass one.
   *
   * "What should Tyler do with his roster" came back as a lookup with no
   * arguments — the name was right there in the sentence and the reply asked
   * whose roster it should look at. This is not guessing: it matches only
   * against the managers this league actually has, so an unknown name stays
   * unknown, and it never overrides an argument the router did supply.
   */
  if (lookup && !lookup.args.manager) {
    const { QUERIES } = require('./retrievers');
    if (QUERIES[lookup.name]?.args?.manager) {
      const hay = haystack.toLowerCase();
      const named = (ctx?.members || [])
        .map(m => m.name)
        .filter(Boolean)
        .filter(n => hay.includes(n.toLowerCase()));
      // Exactly one match, or it is ambiguous and the query says so itself.
      if (named.length === 1) lookup.args.manager = named[0];
    }
  }

  let sections = [...new Set(picked)];
  if (lookup?.name === 'career_extremes') {
    const covers = lookup.args.metric === 'drafting' ? 'draft_history' : 'history';
    sections = sections.filter(n => n !== covers);
  }
  /*
   * trade_value searches every trade on record; the trades section carries the
   * most recent 25. Loaded together, the SHORTER list wins — asked whether Sean
   * had ever traded with Brennan, the reply said no while a priced 2024 trade
   * between exactly those two sat in the lookup directly beneath it. A section
   * that lists a subset reads as the complete set, so it goes.
   */
  if (lookup?.name === 'trade_value') sections = sections.filter(n => n !== 'trades');
  /*
   * Same collision, later discovery. The trades section used to advertise a
   * per-manager win-loss record, so "who is the best trader" went there — and
   * in a dynasty league it holds no grades at all, so the reply said it could
   * not say, with a ledger that answers exactly that sitting unused.
   */
  if (lookup?.name === 'trade_ledger') sections = sections.filter(n => n !== 'trades');

  return {
    sections,
    lookup,
    meta: { raw, ms: Date.now() - started, model: response.model, usage: response.usage },
  };
}

module.exports = { route, SECTIONS, NAMES, MODEL };
