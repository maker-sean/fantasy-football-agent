#!/usr/bin/env node
/**
 * Waiver wire drama, and its path into the recap.
 *
 * The module was written and its thresholds calibrated against a real FAAB
 * season, then imported by nothing for months. These tests exist because
 * "calibrated" and "wired in" are different claims, and only one of them was
 * ever true.
 *
 * The case that matters most is the rolling-priority league. It must produce
 * NOTHING rather than a narrative, and it must do so without reading
 * league.settings, which older snapshots do not carry.
 */
const assert = require('assert');
const w = require('../src/waivers');
const { weekFacts } = require('../src/stats');
const { factsBlock } = require('../src/recap');

let pass = 0;
const it = (n, f) => {
  try { f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

// A waiver claim as Sleeper reports it. Losing bids come back as status
// 'failed' with the bid intact, which is the whole reason a margin exists.
const claim = (rosterId, playerId, bid, status = 'complete') => ({
  type: 'waiver',
  status,
  settings: { waiver_bid: bid },
  adds: { [playerId]: rosterId },
});

// --- contests ---------------------------------------------------------------
console.log('grouping claims into contests');

it('groups every bid for one player into a single contest', () => {
  const c = w.contests([claim(1, 'p1', 20), claim(2, 'p1', 19, 'failed')]);
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].bidders, 2);
});

it('a rolling-priority league produces no contests at all', () => {
  // No waiver_bid anywhere. This is the shape of one of the two leagues on
  // file, and the reason the recap does not read waiver_type.
  const rolling = [
    { type: 'waiver', status: 'complete', settings: { seq: 3 }, adds: { p1: 1 } },
    { type: 'waiver', status: 'complete', settings: { seq: 7 }, adds: { p2: 2 } },
  ];
  assert.deepStrictEqual(w.contests(rolling), []);
});

it('ignores transactions that are not waivers', () => {
  const tx = [{ type: 'free_agent', status: 'complete', settings: { waiver_bid: 40 }, adds: { p1: 1 } }];
  assert.deepStrictEqual(w.contests(tx), []);
});

it('an empty or missing transaction list is not an error', () => {
  assert.deepStrictEqual(w.contests([]), []);
  assert.deepStrictEqual(w.contests(undefined), []);
});

// --- findDrama --------------------------------------------------------------
console.log('\npicking out what is worth saying');

it('a one dollar win is a squeaker', () => {
  const d = w.findDrama(w.contests([claim(1, 'p1', 20), claim(2, 'p1', 19, 'failed')]));
  assert.strictEqual(d.squeakers.length, 1);
  assert.strictEqual(d.squeakers[0].margin, 1);
});

it('a comfortable win is not a squeaker and not a blowout', () => {
  const d = w.findDrama(w.contests([claim(1, 'p1', 30), claim(2, 'p1', 20, 'failed')]));
  assert.strictEqual(d.squeakers.length, 0);
  assert.strictEqual(d.blowouts.length, 0);
});

it('beating the next bid by 20 or more is a blowout', () => {
  const d = w.findDrama(w.contests([claim(1, 'p1', 40), claim(2, 'p1', 12, 'failed')]));
  assert.strictEqual(d.blowouts.length, 1);
  assert.strictEqual(d.blowouts[0].margin, 28);
});

it('an uncontested bid is only worth mentioning above the threshold', () => {
  const loud = w.findDrama(w.contests([claim(1, 'p1', 22)]));
  const quiet = w.findDrama(w.contests([claim(1, 'p1', 3)]));
  assert.strictEqual(loud.unopposed.length, 1);
  assert.strictEqual(quiet.unopposed.length, 0, '$3 nobody wanted is not a story');
});

it('an uncontested bid is never also a squeaker', () => {
  // margin is null with nobody to compare against, and null <= 1 is true in
  // JavaScript. The contested flag is what keeps that from firing.
  const d = w.findDrama(w.contests([claim(1, 'p1', 22)]));
  assert.strictEqual(d.squeakers.length, 0);
});

// --- describe ---------------------------------------------------------------
console.log('\ndeterministic prose');

const names = new Map([['p1', { full_name: 'Rome Odunze' }]]);
const teams = new Map([[1, 'Tank Commanders'], [2, 'Halcyon Kings']]);

it('a blowout states both bids and the gap between them', () => {
  const [line] = w.describe(
    w.findDrama(w.contests([claim(1, 'p1', 40), claim(2, 'p1', 12, 'failed')])),
    { names, teams });
  assert.match(line, /Tank Commanders paid \$40 for Rome Odunze/);
  assert.match(line, /Next closest was \$12/);
  assert.match(line, /\$28 more than anyone else thought he was worth/);
});

it('an unopposed bid says nobody else bid', () => {
  const [line] = w.describe(w.findDrama(w.contests([claim(1, 'p1', 22)])), { names, teams });
  assert.strictEqual(line, 'Tank Commanders bid $22 on Rome Odunze. Nobody else bid at all.');
});

it('a tie won on priority is described as such, not as a $0 win', () => {
  const [line] = w.describe(
    w.findDrama(w.contests([claim(1, 'p1', 20), claim(2, 'p1', 20, 'failed')])),
    { names, teams });
  assert.match(line, /tied and won on priority/);
});

it('an unknown player or roster degrades rather than throwing', () => {
  const [line] = w.describe(w.findDrama(w.contests([claim(9, 'ghost', 22)])), { names, teams });
  assert.match(line, /Roster 9/);
  assert.match(line, /player ghost/);
});

// --- the wiring -------------------------------------------------------------
console.log('\nreaching the recap');

const payload = (transactions) => ({
  league: { name: 'Test League', season: '2025', roster_positions: ['QB', 'RB', 'BN'] },
  week: 10,
  users: [{ user_id: 'u1', display_name: 'Tank Commanders' }],
  rosters: [{ roster_id: 1, owner_id: 'u1', settings: { wins: 5, losses: 4 } }],
  matchups: [],
  transactions,
});

it('weekFacts carries the drama, phrased', () => {
  const facts = weekFacts(payload([claim(1, 'p1', 40), claim(2, 'p1', 12, 'failed')]), names);
  assert.strictEqual(facts.waiverDrama.length, 1);
  assert.match(facts.waiverDrama[0], /\$40/);
});

it('the FACTS block puts the numbers where verify.js can see them', () => {
  // This is the point of the whole exercise: if the bid is not in the FACTS
  // text, verifyRecap treats the model repeating it as an invented number and
  // holds the recap.
  const facts = weekFacts(payload([claim(1, 'p1', 40), claim(2, 'p1', 12, 'failed')]), names);
  const block = factsBlock(facts);
  assert.match(block, /Waiver wire this week:/);
  assert.match(block, /\$40/);
  assert.match(block, /\$12/);
});

it('a league with no bids adds no waiver section to FACTS', () => {
  const facts = weekFacts(payload([]), names);
  assert.deepStrictEqual(facts.waiverDrama, []);
  assert.ok(!factsBlock(facts).includes('Waiver wire'),
    'an empty heading invites the model to fill it');
});

it('a snapshot with no transactions key at all still works', () => {
  // Every snapshot captured before waivers existed looks like this, and
  // weekSnapshot itself falls back to [] when the endpoint 404s.
  const p = payload([]);
  delete p.transactions;
  assert.deepStrictEqual(weekFacts(p, names).waiverDrama, []);
});

console.log(`\n${pass} passing`);
