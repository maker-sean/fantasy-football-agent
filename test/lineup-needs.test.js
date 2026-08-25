#!/usr/bin/env node
/**
 * What a roster is actually short of, once the FLEX is counted.
 *
 * The first version compared the BEST player at each position and called the
 * worst of those the need. That reads a league starting QB/RB/RB/WR/WR/TE as
 * needing two receivers, and it does not: two more slots take RB, WR or TE, so
 * depth at any of them is STARTING depth. A roster with WR3 and WR6 and nothing
 * behind them looked finished at receiver and started a replacement-level
 * player every Sunday.
 *
 * The second problem was comparing ranks across positions. QB16 and RB22 are
 * not the same distance from useless: twelve quarterbacks start in a 1QB
 * league, and up to forty-eight running backs do.
 */
const assert = require('assert');
const path = require('path');
const ctx = require(path.join(process.env.HOME, 'fantasy-agent/src/context'));

let pass = 0;
const it = (n, f) => { try { f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; } };

const POSITIONS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'FLEX', 'BN', 'BN'];
const p = (id, position, posRank, points) => ({ playerId: id, name: id, position, posRank, points });

/* Twelve rosters so replacement level lands where a real league puts it. */
const rows = (players) => {
  const out = [{ roster_id: 1, players: players.map(x => x.playerId) }];
  for (let i = 2; i <= 12; i++) out.push({ roster_id: i, players: [] });
  return out;
};
const projOf = players => new Map(players.map(x => [x.playerId, x]));
const needs = players => ctx.draftNeeds(rows(players), projOf(players), 1,
  { rosterPositions: POSITIONS });

console.log('the flex is a starting slot');

it('two good receivers do not finish the receiver room', () => {
  // Dedicated WR slots filled, but both FLEX slots still want bodies.
  const squad = [
    p('qb1', 'QB', 3, 300), p('rb1', 'RB', 5, 250), p('rb2', 'RB', 9, 230),
    p('wr1', 'WR', 3, 260), p('wr2', 'WR', 6, 240), p('te1', 'TE', 4, 200),
  ];
  const n = needs(squad);
  const flex = n.lineup.filter(s => s.slot === 'FLEX');
  assert.strictEqual(flex.length, 2);
  assert.ok(flex.every(s => !s.player), 'a flex slot was filled from thin air');
  assert.strictEqual(n.need.empty, true, 'an empty starting slot is not the top need');
});

it('a fourth receiver fills a flex rather than sitting on the bench', () => {
  const squad = [
    p('qb1', 'QB', 3, 300), p('rb1', 'RB', 5, 250), p('rb2', 'RB', 9, 230),
    p('wr1', 'WR', 3, 260), p('wr2', 'WR', 6, 240), p('wr3', 'WR', 20, 190),
    p('te1', 'TE', 4, 200),
  ];
  const n = needs(squad);
  const flex = n.lineup.find(s => s.slot === 'FLEX' && s.player);
  assert.ok(flex, 'the extra receiver never reached the lineup');
  assert.strictEqual(flex.player.playerId, 'wr3');
});

console.log('\nranks are not comparable across positions');

it('QB16 is below replacement where only twelve quarterbacks start', () => {
  const squad = [
    p('qb1', 'QB', 16, 240), p('rb1', 'RB', 4, 272), p('rb2', 'RB', 15, 220),
    p('wr1', 'WR', 16, 227), p('wr2', 'WR', 18, 220), p('te1', 'TE', 9, 171),
    p('rb3', 'RB', 20, 210), p('rb4', 'RB', 22, 205),
  ];
  const n = needs(squad);
  assert.strictEqual(n.replacement.QB, 12);
  assert.strictEqual(n.replacement.RB, 48, 'two RB slots plus two flex, twelve teams');
  assert.strictEqual(n.need.pos, 'QB', 'named a flex running back over a backup quarterback');
  assert.strictEqual(n.need.overReplacement, -4);
});

it('RB22 is a fine starter, because forty-eight running backs start', () => {
  const squad = [
    p('qb1', 'QB', 2, 340), p('rb1', 'RB', 4, 272), p('rb2', 'RB', 15, 220),
    p('wr1', 'WR', 16, 227), p('wr2', 'WR', 18, 220), p('te1', 'TE', 9, 171),
    p('rb3', 'RB', 20, 210), p('rb4', 'RB', 22, 205),
  ];
  const n = needs(squad);
  assert.ok(n.lineup.every(s => !s.player || s.overReplacement >= 0),
    'a legitimate starter was called below replacement');
});

console.log('\nfilling the lineup');

it('a dedicated slot is filled before a flex takes the same player', () => {
  // A single tight end must start at TE, not be spent on a FLEX.
  const squad = [
    p('qb1', 'QB', 3, 300), p('rb1', 'RB', 5, 250), p('rb2', 'RB', 9, 230),
    p('wr1', 'WR', 3, 260), p('wr2', 'WR', 6, 240), p('te1', 'TE', 1, 280),
  ];
  const n = needs(squad);
  assert.strictEqual(n.lineup.find(s => s.slot === 'TE').player.playerId, 'te1');
});

it('an empty slot outranks any weak starter', () => {
  const squad = [p('rb1', 'RB', 60, 90)];   // no quarterback at all
  const n = needs(squad);
  assert.strictEqual(n.need.empty, true);
});

console.log(`\n${pass} passing`);
