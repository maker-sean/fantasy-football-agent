#!/usr/bin/env node
/**
 * Telling us something, as opposed to asking us something.
 *
 * A keyword rather than detection, because guessing which messages are feedback
 * means either missing most of them or filing jokes as product requests, and a
 * twelve person chat produces a great many jokes. Everything below is about
 * that line: what counts, and what is just people talking.
 */
const assert = require('assert');
const fb = require('../src/feedback');

let pass = 0;
const it = (n, f) => {
  try { f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

const N = ['bot', 'commish', 'jarvis'];
const inGroup = t => fb.parse(t, { botNames: N, isGroup: true });
const direct = t => fb.parse(t, { botNames: N, isGroup: false });

console.log('the word they use is the queue');

it('bug and broken file as a bug', () => {
  assert.strictEqual(inGroup('bot bug the recap said Kellan was 11-3').kind, 'bug');
  assert.strictEqual(inGroup('jarvis broken: it calls me the wrong name').kind, 'bug');
});

it('idea, suggestion and feature all file as an idea', () => {
  for (const t of ['bot idea let us mute you on sundays',
                   'bot suggestion - add head to head',
                   'commish feature request: weekly power rankings']) {
    assert.strictEqual(inGroup(t).kind, 'idea', `not an idea: ${t}`);
  }
});

it('the body is what they actually said, without the keyword', () => {
  assert.strictEqual(inGroup('bot idea let us mute you on sundays').body,
    'let us mute you on sundays');
  assert.strictEqual(inGroup('commish feedback: the tuesday recap is too long').body,
    'the tuesday recap is too long');
});

console.log('\nin a group the bot has to be named');

it('two people saying "that\'s a bug" to each other is a conversation', () => {
  assert.strictEqual(inGroup('bug the recap is wrong'), null);
  assert.strictEqual(inGroup('that was a bug last week'), null);
  assert.strictEqual(inGroup('honestly the whole idea is stupid'), null);
});

it('1:1 does not need the name, since there is nobody else to address', () => {
  assert.ok(direct('bug: the recap is wrong'));
  assert.strictEqual(direct('bug: the recap is wrong').kind, 'bug');
});

console.log('\nwhat is not feedback');

it('an ordinary question is not feedback', () => {
  assert.strictEqual(inGroup('bot who won in 2023'), null);
  assert.strictEqual(inGroup('commish what is our closest game'), null);
});

it('a bare keyword with nothing after it is somebody testing', () => {
  assert.strictEqual(inGroup('bot feedback'), null);
  assert.strictEqual(inGroup('bot bug'), null);
});

it('empty and junk are ignored', () => {
  assert.strictEqual(inGroup(''), null);
  assert.strictEqual(inGroup(null), null);
});

console.log('\nwhat each side is told');

it('the reply names the queue it went to', () => {
  assert.match(fb.thanks('bug'), /bug/i);
  assert.match(fb.thanks('idea'), /built/i);
});

it('the alert carries who, where and what', () => {
  const t = fb.alertText({ kind: 'bug', body: 'the recap is wrong', saidBy: 'Chris',
    inGroup: true, leagueName: 'Halcyon Kings' });
  assert.match(t, /BUG/);
  assert.match(t, /Chris/);
  assert.match(t, /Halcyon Kings/);
  assert.match(t, /in the group/);
  assert.match(t, /the recap is wrong/);
});

it('a private one reads differently from a public one', () => {
  // In-group feedback is often performative, a private one is considered, and
  // knowing which changes how much weight it gets.
  const priv = fb.alertText({ kind: 'idea', body: 'x', saidBy: 'Chris', inGroup: false });
  assert.ok(!/in the group/.test(priv));
});

console.log(`\n${pass} passing`);
