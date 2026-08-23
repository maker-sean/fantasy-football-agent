#!/usr/bin/env node
/**
 * What the bot knows about itself.
 *
 * This file is a PROMISE SURFACE. src/answer.js is grounded strictly in
 * context and told never to fill a gap, so anything written here becomes an
 * answer the bot will give with confidence. A line that is not true of the code
 * is therefore worse than a missing line: the model will state it plainly to a
 * league member who then acts on it.
 *
 * Two promises have already had to be withdrawn from this product's copy for
 * exactly that reason: a HELP reply the provider swallows, and a "reply with
 * your name" path that db.renameMember exposes and nothing calls. These cases
 * guard the same class of mistake.
 */
const assert = require('assert');
const { selfFacts, selfBlock } = require('../src/selfknowledge');

let pass = 0;
const it = (n, f) => {
  try { f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

const league = (config = { botNames: ['Commish'] }) => ({ name: 'Test', config });
const text = (l, o) => selfFacts(l, o).join('\n');

console.log('it describes the trigger that actually works');

it('it names the configured trigger, not the brand', () => {
  // FF Test is configured as "bot". A bot that tells people to say "Commish"
  // while the gate listens for "bot" is worse than one that says nothing.
  assert.match(text(league({ botNames: ['bot', 'jarvis'] })), /called "bot"/);
  assert.ok(!/called "Commish"/.test(text(league({ botNames: ['bot'] }))));
});

it('it falls back to the name the GATE actually answers to', () => {
  // This asserted "Commish" and was wrong in the way this file exists to catch.
  // decide.DEFAULT_BOT_NAMES is ['bot'] and mentionsBot returns null for
  // "Commish" on an unconfigured league, so announcing Commish advertised a
  // trigger nothing listened for. welcome.js hit the same bug and fixed it by
  // routing through botNames(); this now does the same.
  assert.match(text(league({})), /called "bot"/);
  assert.match(text(league(null)), /called "bot"/);
  assert.ok(!/called "Commish"/.test(text(league({}))));
});

it('it announces EVERY name it answers to, not just the first', () => {
  // A league with four triggers had the gate reply to "jarvis" and the persona
  // correct the person for saying it, so nearly every answer opened with
  // "wrong bot".
  const t = text(league({ botNames: ['bot', 'commish', 'jarvis'] }));
  for (const n of ['bot', 'commish', 'jarvis']) {
    assert.ok(t.includes(`"${n}"`), `${n} is accepted by the gate but never mentioned`);
  }
});

it('it is told not to correct somebody for using one of its own names', () => {
  assert.match(text(league({ botNames: ['bot', 'jarvis'] })), /[Nn]ever correct/);
});

console.log('\nevery line is true of the code');

it('it tells people to reply STOP, which is the only opt-out that exists', () => {
  assert.match(text(league()), /reply STOP/i);
});

it('it does NOT promise a HELP reply', () => {
  // signup.js never replies to a reserved keyword: the provider suppresses
  // outbound to that number the moment it sees one.
  assert.ok(!/HELP/.test(text(league())), 'HELP cannot be answered, so do not offer it');
});

it('it does NOT promise that texting your name binds you to a roster', () => {
  // db.renameMember exists and nothing calls it. The commissioner binds
  // everyone on the website; there is no chat path.
  const t = text(league());
  assert.ok(!/reply with your name/i.test(t), 'no chat path binds a name to a roster');
  assert.match(t, /commissioner .*(website|enter each manager)/i,
    'it should point at the path that does exist');
});

it('it says plainly what it cannot do, since a model would rather agree', () => {
  const t = text(league());
  assert.match(t, /cannot change lineups/i);
  assert.match(t, /cannot rename a team/i);
});

it('it does not claim to work with ESPN or Yahoo', () => {
  const t = text(league());
  assert.match(t, /only work with Sleeper/i);
  assert.ok(!/ESPN|Yahoo/i.test(t));
});

it('it does not claim to read anything beyond this chat and public data', () => {
  assert.match(text(league()), /do not read anyone's other chats/i);
});

console.log('\nit reflects the league it is in');

it('approval versus auto-post is stated correctly, not guessed', () => {
  assert.match(text(league(), { autoPost: false }), /commissioner sees each recap/i);
  assert.match(text(league(), { autoPost: true }), /post to this chat automatically/i);
  assert.ok(!/commissioner sees each recap/i.test(text(league(), { autoPost: true })),
    'both cannot be true at once');
});

console.log('\nthe block is shaped like the rest of the context');

it('it is labelled so the model knows it may answer from it', () => {
  const b = selfBlock(league());
  assert.match(b, /^ABOUT YOU/m);
  assert.match(b, /^ {2}- /m, 'facts should be bulleted like the other sections');
});

it('no em dashes, because these lines can be quoted straight into a text', () => {
  assert.ok(!/—/.test(selfBlock(league())), 'em dash found');
});

console.log(`\n${pass} passing`);
