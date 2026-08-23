#!/usr/bin/env node
/**
 * Somebody already bound saying who they are.
 *
 * Whitlock texted "I am Whitlock and I am the manager of Ruizs Onside Bandits" and got
 * "Noted, Whitlock runs Ruiz's Onside Bandits". Nothing was noted: no claim parsed,
 * no attempt logged, his row untouched. It was true by luck, and the identical
 * sentence would have come out if he were on the wrong roster.
 *
 * The risk in fixing it is the opposite one. A matcher loose enough to catch
 * "I am Whitlock" also catches "I am winning", and lecturing somebody about the
 * commissioner because they said they were winning is worse than the bug. So
 * the weak forms have to land on a name this league actually has.
 */
const assert = require('assert');
const claims = require('../src/claims');

let pass = 0;
const it = (n, f) => {
  try { f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

const N = ['bot', 'commish', 'jarvis'];
const known = ['Whitlock', 'Marek', 'Sean', 'Ruiz’s Onside Bandits', 'Bay Watchers', 'Big Yardage'];
const saw = t => claims.looksLikeSelfIntro(t, { botNames: N, known });

console.log('stating who you are');

it('the real message that started this is caught', () => {
  assert.ok(saw('Commish I am Whitlock and I am the manager of Ruizs Onside Bandits'));
});

it('accents and punctuation do not have to match', () => {
  // "Ruizs Onside Bandits" has to find "Ruiz's Onside Bandits".
  assert.ok(saw("I'm the manager of Ruizs Onside Bandits"));
  assert.ok(saw('bot my team is champa bay'));
});

it('the strong forms stand on their own', () => {
  for (const t of ["I'm the manager of Big Yardage", 'my team is Bay Watchers', 'I run Big Yardage']) {
    assert.ok(saw(t), `missed: ${t}`);
  }
});

console.log('\nordinary chat is not an identity claim');

it('"I am" followed by anything that is not a name is left alone', () => {
  // This is the failure that would be worse than the bug: telling somebody
  // their commissioner owns the roster because they said they were winning.
  for (const t of ['I am winning', "I'm out this week", 'this is ridiculous',
                   'this is the worst week ever', 'I am 3 points behind']) {
    assert.ok(!saw(t), `wrongly treated as an identity claim: ${t}`);
  }
});

it('a question is never an identity claim', () => {
  assert.ok(!saw('bot who won in 2023'));
  assert.ok(!saw('commish what is our closest game'));
});

it('with no known names, only the strong forms match', () => {
  // The safe direction: a missed self-intro gets an ordinary answer.
  const bare = t => claims.looksLikeSelfIntro(t, { botNames: N, known: [] });
  assert.ok(!bare('I am Whitlock'));
  assert.ok(bare("I'm the manager of anything"));
});

console.log('\nwhat it says back');

it('it states what is recorded, and never says noted', () => {
  const r = claims.alreadyBoundReply({ displayName: 'Whitlock', teamName: "Ruiz’s Onside Bandits", rosterId: 8 });
  assert.match(r, /Ruiz’s Onside Bandits/);
  assert.match(r, /Whitlock/);
  assert.ok(!/noted/i.test(r), 'implies something was recorded');
});

it('it says who CAN change it, since the bot cannot', () => {
  const r = claims.alreadyBoundReply({ displayName: 'Whitlock', teamName: 'X', rosterId: 8 });
  assert.match(r, /commissioner/i);
  assert.match(r, /cannot|can'?t/i);
});

it('a missing team name degrades to the roster rather than to nothing', () => {
  assert.match(claims.alreadyBoundReply({ displayName: 'Ivers', teamName: null, rosterId: 5 }),
    /roster 5/);
});

console.log(`\n${pass} passing`);
