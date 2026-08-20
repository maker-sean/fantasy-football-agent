#!/usr/bin/env node
/**
 * Roster teardowns and abandoned draft picks.
 *
 * This is the half of the transaction story that does NOT need FAAB, which
 * matters because both leagues on file are rolling priority and get nothing
 * from src/waivers.js. Replayed against the real 2025 season it speaks in 12 of
 * 17 weeks.
 *
 * The case worth guarding hardest is a player acquired in a trade and then cut.
 * That is somebody else's draft mistake, and attributing it to the roster that
 * dropped him would be a confident, plausible, wrong sentence in a group chat.
 */
const assert = require('assert');
const c = require('../src/churn');
const { weekFacts } = require('../src/stats');
const { factsBlock } = require('../src/recap');

let pass = 0;
const it = (n, f) => {
  try { f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

const drop = (rosterId, playerIds, status = 'complete') => ({
  type: 'free_agent',
  status,
  drops: Object.fromEntries(playerIds.map(p => [p, rosterId])),
});

const draftOf = (picks, rounds = 14) => ({
  rounds,
  picks: picks.map(([player_id, roster_id, round]) => ({ player_id, roster_id, round })),
});

// --- the early-round cutoff -------------------------------------------------
console.log('early is half the draft, not a fixed round');

it('a 14 round draft cuts at 7', () => assert.strictEqual(c.earlyRoundCutoff(14), 7));
it('a 20 round draft cuts at 10', () => assert.strictEqual(c.earlyRoundCutoff(20), 10));
it('an unknown round count never cuts below 1', () => {
  assert.strictEqual(c.earlyRoundCutoff(null), 1);
  assert.strictEqual(c.earlyRoundCutoff(0), 1);
});

// --- drops ------------------------------------------------------------------
console.log('\ncounting drops');

it('a failed transaction carries a drop that never happened', () => {
  // Reporting a cut that did not occur is the exact failure verify.js exists
  // to stop, and a failed waiver claim is full of them.
  const m = c.dropsByRoster([drop(1, ['a', 'b'], 'failed')]);
  assert.strictEqual(m.size, 0);
});

it('drops from several transactions accumulate onto one roster', () => {
  const m = c.dropsByRoster([drop(1, ['a']), drop(1, ['b', 'd']), drop(2, ['e'])]);
  assert.strictEqual(m.get(1).length, 3);
  assert.strictEqual(m.get(2).length, 1);
});

// --- teardowns --------------------------------------------------------------
console.log('\nteardowns');

it('five drops in a week is a teardown, four is a Tuesday', () => {
  const five = c.findChurn([drop(1, ['a', 'b', 'd', 'e', 'f'])]);
  const four = c.findChurn([drop(1, ['a', 'b', 'd', 'e'])]);
  assert.strictEqual(five.teardowns.length, 1);
  assert.strictEqual(five.teardowns[0].count, 5);
  assert.strictEqual(four.teardowns.length, 0);
});

it('the biggest teardown sorts first', () => {
  const r = c.findChurn([drop(1, ['a','b','d','e','f']), drop(2, ['g','h','i','j','k','l','m'])]);
  assert.strictEqual(r.teardowns[0].rosterId, 2);
});

// --- abandoned picks --------------------------------------------------------
console.log('\nabandoned draft picks');

const draft = draftOf([['star', 1, 1], ['late', 1, 12], ['theirs', 2, 2]]);

it('dropping your own early pick is the story', () => {
  const r = c.findChurn([drop(1, ['star'])], draft);
  assert.strictEqual(r.abandoned.length, 1);
  assert.strictEqual(r.abandoned[0].round, 1);
});

it('dropping your own late pick is not', () => {
  assert.strictEqual(c.findChurn([drop(1, ['late'])], draft).abandoned.length, 0);
});

it('cutting a player someone ELSE drafted is not your draft mistake', () => {
  // Roster 1 drops a player roster 2 took in round 2. Attributing that to
  // roster 1's draft would be plausible, specific, and false.
  assert.strictEqual(c.findChurn([drop(1, ['theirs'])], draft).abandoned.length, 0);
});

it('an undrafted waiver pickup being cut is nothing at all', () => {
  assert.strictEqual(c.findChurn([drop(1, ['nobody'])], draft).abandoned.length, 0);
});

it('earliest pick sorts first', () => {
  const d = draftOf([['a', 1, 6], ['b', 1, 2]]);
  const r = c.findChurn([drop(1, ['a', 'b'])], d);
  assert.strictEqual(r.abandoned[0].round, 2);
});

it('with no draft captured the teardown still fires and rounds stay silent', () => {
  const r = c.findChurn([drop(1, ['a','b','d','e','f'])], null);
  assert.strictEqual(r.teardowns.length, 1);
  assert.strictEqual(r.abandoned.length, 0);
});

// --- prose ------------------------------------------------------------------
console.log('\ndeterministic prose');

const names = new Map([['star', { full_name: 'Derrick Henry' }]]);
const teams = new Map([[1, 'Punt Intended']]);

it('an abandoned pick names the player and the round', () => {
  const [line] = c.describe(c.findChurn([drop(1, ['star'])], draft), { names, teams });
  assert.strictEqual(line, 'Punt Intended dropped Derrick Henry, their own round 1 pick.');
});

it('a teardown states the count', () => {
  const [line] = c.describe(c.findChurn([drop(1, ['a','b','d','e','f'])]), { names, teams });
  assert.strictEqual(line, 'Punt Intended dropped 5 players this week.');
});

it('an unknown team or player degrades rather than throwing', () => {
  const [line] = c.describe(c.findChurn([drop(9, ['star'])], draftOf([['star', 9, 1]])), {});
  assert.match(line, /Roster 9/);
});

// --- the wiring -------------------------------------------------------------
console.log('\nreaching the recap');

const payload = (transactions, d) => ({
  league: { name: 'Test League', season: '2025', roster_positions: ['QB', 'RB', 'BN'] },
  week: 10,
  users: [{ user_id: 'u1', display_name: 'Punt Intended' }],
  rosters: [{ roster_id: 1, owner_id: 'u1', settings: { wins: 5, losses: 4 } }],
  matchups: [],
  transactions,
  draft: d,
});

it('weekFacts carries the churn, phrased', () => {
  const f = weekFacts(payload([drop(1, ['star'])], draft), names);
  assert.strictEqual(f.rosterChurn.length, 1);
  assert.match(f.rosterChurn[0], /round 1 pick/);
});

it('the FACTS block gives the model a labelled section', () => {
  const f = weekFacts(payload([drop(1, ['star'])], draft), names);
  assert.match(factsBlock(f), /Roster moves this week:/);
});

it('a quiet week adds no heading', () => {
  const f = weekFacts(payload([], draft), names);
  assert.deepStrictEqual(f.rosterChurn, []);
  assert.ok(!factsBlock(f).includes('Roster moves'), 'an empty heading invites invention');
});

it('a snapshot predating draft capture still produces teardowns', () => {
  const p = payload([drop(1, ['a','b','d','e','f'])], undefined);
  delete p.draft;
  const f = weekFacts(p, names);
  assert.strictEqual(f.rosterChurn.length, 1);
  assert.match(f.rosterChurn[0], /dropped 5 players/);
});

console.log(`\n${pass} passing`);
