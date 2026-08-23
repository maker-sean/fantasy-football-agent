#!/usr/bin/env node
/**
 * Asked for and missing.
 *
 * A feature list written by the league, and the thing that ruins it is
 * conflating two different kinds of no. "I don't have game logs" is a request.
 * "I can't crown a worst drafter, the counts are too close" is the bot working
 * exactly as designed, and building something for it would be the wrong
 * response. A backlog with both in it is a backlog nobody reads.
 *
 * Every string below is real output from the league chat.
 */
const assert = require('assert');
const { isGap } = require('../src/gaps');

let pass = 0;
const it = (n, f) => {
  try { f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

console.log('missing data is a feature request');

it('it catches the plain forms', () => {
  for (const t of [
    "Don't have game-by-game scores or dates, just season totals and career records.",
    "Top 3 average finishes isn't a stat I've got printed anywhere.",
    'No league data captured yet, so I have nothing on Marlow.',
    "Ivers isn't in the draft history, whiffs or steals.",
    "Don't have that. I've got total points for/against for four managers.",
  ]) assert.ok(isGap(t), `missed: ${t}`);
});

it('it catches "zero" and "nothing", which mean the same thing', () => {
  // Both appeared in the corpus, next to each other, and only one was matched.
  assert.ok(isGap("I've got zero league data captured yet, so I can't back that up."));
  assert.ok(isGap("Flattering, but I've got no season captured, so that stays hypothetical."));
});

console.log('\na deliberate refusal is NOT a feature request');

it('the counts being too close is the bot working correctly', () => {
  assert.ok(!isGap("Can't crown one worst, the whiff counts are too tight to call: Kellan on 6, next on 5."));
  assert.ok(!isGap('most titles: nobody leads, 6 are tied on 1.'));
});

it('out of scope by policy is not a gap', () => {
  for (const t of [
    'I only do football.',
    "Not my department, I only read and talk.",
    "Draft order's a commissioner setting on the Sleeper website, not something I control.",
  ]) assert.ok(!isGap(t), `wrongly listed as a gap: ${t}`);
});

console.log('\nthe ambiguous middle');

it('a refusal CAUSED by missing data is a gap, not a refusal', () => {
  // "can't crown" used to be an exclusion and threw this away. The refusal is
  // identifiable by its REASON — too close, out of scope — not by the verb.
  assert.ok(isGap("Zero data loaded, zero seasons on record, so I can't crown a worst drafter yet."));
});

it('an ordinary answer is not a gap', () => {
  for (const t of [
    '2025 week 1: Kellan 115.12 beat Danner 114.98, by 0.14.',
    'Marlow won it in 2023.',
    '✓ Sean — Bay Watchers',
  ]) assert.ok(!isGap(t), `wrongly listed as a gap: ${t}`);
});

it('empty text is not a gap', () => {
  assert.ok(!isGap(''));
  assert.ok(!isGap(null));
});

console.log(`\n${pass} passing`);
