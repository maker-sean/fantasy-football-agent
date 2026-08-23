/**
 * What the bot knows about itself.
 *
 * src/answer.js is grounded strictly in league context and is told, bluntly,
 * never to fill a gap with something plausible. That is right, and it means a
 * question about the PRODUCT rather than the league gets "I don't know":
 * how do I turn you off, when do you post, why did you not answer me. All
 * correct behaviour, and all useless to the person asking.
 *
 * So the product is described here, as facts, and handed to the model the same
 * way standings are. "Reply STOP" then comes from grounded context rather than
 * from a model improvising instructions about opting out, which is the one
 * subject where invention is genuinely dangerous.
 *
 * Static and versioned here rather than in a database or a dashboard, for the
 * same reason prompts are: an answer about how to opt out has to be traceable
 * to the text that produced it.
 *
 * Every line must be TRUE OF THE CODE. This file is a promise surface. If a
 * behaviour changes, this changes with it, and anything not built does not
 * appear here at all. It has already caught one: an earlier welcome message
 * offered a "reply with your name" path that nothing implements.
 */

/**
 * @param league  the league row, so the trigger word matches what is configured
 * @param opts.autoPost  whether recaps post without commissioner approval
 */
function selfFacts(league, { autoPost = false } = {}) {
  /*
   * EVERY accepted name, not just the first one.
   *
   * This took botNames[0] and told the model that was its name, while the reply
   * gate in src/decide.js listens for the whole list. The result was a bot that
   * answered to "Jarvis" and then corrected the person for saying it: a league
   * configured with four triggers had nearly every reply open with "wrong bot",
   * because the gate said yes and the persona said no.
   *
   * welcome.js already had this right and advertised all four in the
   * introduction, which is exactly where the mismatch became visible.
   */
  const list = require('./welcome').botNames(league);
  const name = list[0];

  return [
    list.length > 1
      ? `You are called ${orList(list)} in this chat, and you answer to ALL of them. `
        + `Saying one of those words is the only way to get your attention. Never correct `
        + `somebody for picking one of your own names, whichever they use is right.`
      : `You are called "${name}" in this chat. Saying that word is the only way to get your attention.`,
    'You reply when addressed by name. You do not join conversations you were not invited into.',
    'You post a recap once a week during the NFL season, on Tuesday mornings.',
    'You warn about a starter who is Out, IR or PUP before that specific game kicks off, not before the whole slate.',
    'You announce trades when they happen, and revisit them three weeks later with a letter grade based on points those players actually scored.',
    'You comment on waiver claims and on a manager dropping a pile of players in one week.',
    autoPost
      ? 'Recaps post to this chat automatically.'
      : 'The commissioner sees each recap before this chat does, and it only posts once they approve it.',
    'Anyone can reply STOP and will never receive another message from you. That is the whole procedure, it takes effect immediately, and it is per person rather than per league.',
    'A commissioner sets the league up on the website: they pick the league from Sleeper and enter each manager name and phone number themselves. Nobody else has to sign up or install anything.',
    'You only work with Sleeper leagues.',
    'You read this group chat and the league\'s public Sleeper data. You do not read anyone\'s other chats.',
    'You cannot change lineups, make trades, set waivers, or do anything inside Sleeper. You only read and talk.',
    'You cannot rename a team or reassign a phone number to a different roster. The commissioner does that on the website.',
  ];
}

/** The block handed to the model, in the same shape as the league sections. */
function selfBlock(league, opts) {
  return ['ABOUT YOU. True, and the only place to answer questions about how you work:',
    ...selfFacts(league, opts).map(f => `  - ${f}`)].join('\n');
}

const orList = (items) => require('./welcome').orList(items);

module.exports = { selfFacts, selfBlock };
