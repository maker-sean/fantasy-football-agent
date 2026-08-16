#!/usr/bin/env node
/**
 * Pre-kickoff injury alerts.
 *
 * The first feature where being wrong costs more than staying quiet: a false
 * alarm makes someone bench a healthy starter, and a late one is useless. Most
 * of these assert that the bot does NOT alert.
 */
const assert = require('assert');
const { isCertainOut, composeAlert, CERTAIN_OUT } = require('../src/injuries');

let pass = 0;
const it = (n, f) => {
  try { f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

console.log('who counts as a certain zero');
for (const s of ['Out', 'IR', 'PUP', 'Sus', 'DNR', 'COV'])
  it(`${s} is a certain zero`, () => assert.strictEqual(isCertainOut({ injury_status: s }), true));

console.log('\nwho does NOT — these are where a bot becomes noise');
it('Questionable is not alerted (381 players carry it; most play)', () =>
  assert.strictEqual(isCertainOut({ injury_status: 'Questionable' }), false));
it('NA is not alerted', () => assert.strictEqual(isCertainOut({ injury_status: 'NA' }), false));
it('a healthy player is not alerted', () =>
  assert.strictEqual(isCertainOut({ injury_status: null, player_status: 'Active' }), false));
it('inactive with no injury flag is not alerted', () =>
  assert.strictEqual(isCertainOut({ player_status: 'Inactive', injury_status: null }), false));
it('inactive WITH an injury flag is a zero', () =>
  assert.strictEqual(isCertainOut({ player_status: 'Inactive', injury_status: 'Out' }), true));
it('a missing player is not alerted', () => assert.strictEqual(isCertainOut(null), false));

console.log('\nmessage shape');
const risk = (over = {}) => ({
  team: 'Bay Watchers', minutesToKickoff: 60,
  player: { full_name: 'Alec Pierce', injury_status: 'PUP', injury_body_part: 'Ankle' },
  game: { short_name: 'ATL VS IND' }, ...over,
});
it('one player reads as a sentence', () => {
  const t = composeAlert([risk()]);
  assert.ok(t.includes('Alec Pierce'), 'names the player');
  assert.ok(t.includes('PUP'), 'states the status');
  assert.ok(t.includes('ATL VS IND'), 'names the game');
  assert.ok(!t.includes('•'), 'no bullets for a single item');
});
it('several players become a list', () => {
  const t = composeAlert([risk(), risk({ team: 'Big Yardage' })]);
  assert.ok(t.includes('•'), 'bulleted');
  assert.ok(t.includes('Big Yardage'), 'names each team');
});
it('minutes stay minutes under an hour', () =>
  assert.ok(composeAlert([risk({ minutesToKickoff: 25 })]).includes('25m')));
it('nothing to say produces nothing', () => assert.strictEqual(composeAlert([]), null));

console.log('\nthe alert window (documented behavior of findRisks)');
it('excludes Questionable from the certain-out set', () =>
  assert.strictEqual(CERTAIN_OUT.has('Questionable'), false));
it('the certain-out set is exactly the non-playing statuses', () =>
  assert.deepStrictEqual([...CERTAIN_OUT].sort(),
    ['COV', 'DNR', 'IR', 'NFI', 'Out', 'PUP', 'Sus']));

console.log(`\n${pass} passing`);
