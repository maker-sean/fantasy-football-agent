#!/usr/bin/env node
/**
 * Who scores the most, computed rather than left to the model.
 *
 * career() has summed points and points-against per manager since it was
 * written, and careerBlock never printed either of them. So the fact sheet
 * carried records, titles, finishes and the toilet bowl, and not one scoring
 * number — and asked "who is statistically scoring the most points every
 * season" the bot said the maths was not in front of it. It was right, and
 * nobody had noticed the number was being computed and dropped.
 *
 * The ranking is done here for the reason the whole context block is: a model
 * handed twelve rows and asked which is biggest gave two different wrong
 * answers to the same question minutes apart.
 */
const assert = require('assert');
const { scoringBlock } = require('../src/history');

let pass = 0;
const it = (n, f) => { try { f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; } };

const mgr = (name, points, seasons, against = 0) =>
  ({ userId: 'u-' + name, name, points, seasons, against });

console.log('ranking by what is comparable');

it('the leader is stated outright, not left to be worked out', () => {
  const t = scoringBlock([mgr('Ada', 1200, 1), mgr('Bo', 900, 1)]);
  assert.match(t, /Highest scoring per season: Ada, 1,200\.0\./);
});

it('a long career does not outrank a better one', () => {
  /*
   * The whole reason per-season is the ranking. Bo has six mediocre years and
   * five times the career total; calling him the highest scorer is wrong in the
   * way that sounds authoritative, and it is exactly what ranking on the total
   * would produce.
   */
  const t = scoringBlock([mgr('Bo', 6000, 6), mgr('Ada', 1500, 1)]);
  assert.match(t, /Highest scoring per season: Ada/);
  assert.match(t, /Most points all told: Bo, 6,000\.0 over 6 seasons/);
  assert.match(t, /more years, not a better team/);
});

it('when the same person leads both ways, it is only said once', () => {
  const t = scoringBlock([mgr('Ada', 6000, 3), mgr('Bo', 2000, 2)]);
  assert.doesNotMatch(t, /Most points all told/,
    'repeated the same manager as if it were a second finding');
});

it('a tie is called a tie', () => {
  // Crowning one of two equal managers is the kind of wrong that gets argued
  // with in the chat, which is the whole audience for this number.
  const t = scoringBlock([mgr('Ada', 3000, 2), mgr('Bo', 1500, 1)]);
  assert.match(t, /tied on 1,500\.0/);
  assert.match(t, /Ada and Bo|Bo and Ada/);
});

it('every manager is listed, so a named question can always be answered', () => {
  const t = scoringBlock([mgr('Ada', 1200, 1), mgr('Bo', 900, 1), mgr('Cy', 800, 1)]);
  for (const who of ['Ada', 'Bo', 'Cy']) assert.match(t, new RegExp(who + ' = '));
});

it('points against is carried, since a scoring question often means the other one', () => {
  const t = scoringBlock([mgr('Ada', 1200, 1, 1100)]);
  assert.match(t, /1,100\.0 against/);
});

it('a manager with no seasons or no points is left out rather than shown as zero', () => {
  // A roster that ended a season unowned drops out of career entirely; showing
  // it as 0.0 per season would read as the worst scorer in league history.
  const t = scoringBlock([mgr('Ada', 1200, 1), mgr('Ghost', 0, 0)]);
  assert.doesNotMatch(t, /Ghost/);
});

it('no career at all produces nothing, not an empty heading', () => {
  assert.strictEqual(scoringBlock([]), '');
});

it('the header says which number is the ranking', () => {
  // Without this the model picks whichever column suits the sentence, which is
  // the failure this block exists to prevent.
  const t = scoringBlock([mgr('Ada', 1200, 1)]);
  assert.match(t, /points per season is the ranking/);
});

console.log(`\n${pass} passing`);
