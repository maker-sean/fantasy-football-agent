#!/usr/bin/env node
/**
 * Settling a trade that is already over.
 *
 * A REDRAFT season that has ended has a final answer: those players scored what
 * they scored and no opinion moves it, so the verdict is a fact and is written
 * to the row once. Dynasty is deliberately excluded — a 2021 trade there is
 * still resolving in 2026, and freezing a grade would present a stale opinion
 * as a result.
 */
const assert = require('assert');
const path = require('path');
const trades = require(path.join(process.env.HOME, 'fantasy-agent/src/trades'));

let pass = 0;
const it = (n, f) => { try { f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; } };

/* Two rosters, one week, explicit lineups. */
const week = (w, entries) => [w, { matchups: entries }];
const mu = (rosterId, starters, points) => ({ roster_id: rosterId, starters, players_points: points });
const players = new Map([
  ['p1', { full_name: 'Bought' }],
  ['p2', { full_name: 'Sold' }],
]);

console.log('points scored in the lineup, not on the bench');

it('a benched player contributes nothing', () => {
  /*
   * The whole basis of the grade. A player who was traded for and then sat is
   * not a win, however many points he scored — the manager did not get them.
   */
  const snaps = new Map([
    week(2, [mu(1, [], { p1: 30 }), mu(2, ['p2'], { p2: 10 })]),
  ]);
  const v = trades.scoreTrade(
    { week: 1, revisit_week: 2, received: { 1: ['p1'], 2: ['p2'] }, draft_picks: [] },
    snaps, players);
  const one = v.sides.find(s => s.rosterId === 1);
  assert.strictEqual(one.startedPoints, 0, 'a benched player was counted');
  assert.strictEqual(v.sides[0].rosterId, 2, 'the winner is the side that actually scored');
});

it('a started player counts in full', () => {
  const snaps = new Map([
    week(2, [mu(1, ['p1'], { p1: 30 }), mu(2, ['p2'], { p2: 10 })]),
  ]);
  const v = trades.scoreTrade(
    { week: 1, revisit_week: 2, received: { 1: ['p1'], 2: ['p2'] }, draft_picks: [] },
    snaps, players);
  assert.strictEqual(v.margin, 20);
});

it('a player cut after the trade is marked, not silently zeroed', () => {
  // Arithmetically the same as zero and a completely different story.
  const snaps = new Map([
    week(2, [mu(1, [], {}), mu(2, ['p2'], { p2: 10 })]),
  ]);
  const v = trades.scoreTrade(
    { week: 1, revisit_week: 2, received: { 1: ['p1'], 2: ['p2'] }, draft_picks: [] },
    snaps, players);
  const one = v.sides.find(s => s.rosterId === 1);
  assert.strictEqual(one.players[0].droppedAfterTrade, true);
});

console.log('\nthe window and the disclosure');

it('scoring starts the week AFTER the trade', () => {
  // The week it was made is already in the books for both sides.
  const snaps = new Map([
    week(1, [mu(1, ['p1'], { p1: 99 }), mu(2, ['p2'], { p2: 0 })]),
    week(2, [mu(1, ['p1'], { p1: 5 }), mu(2, ['p2'], { p2: 0 })]),
  ]);
  const v = trades.scoreTrade(
    { week: 1, revisit_week: 2, received: { 1: ['p1'], 2: ['p2'] }, draft_picks: [] },
    snaps, players);
  assert.strictEqual(v.weeks.from, 2);
  assert.strictEqual(v.sides.find(s => s.rosterId === 1).startedPoints, 5,
    'counted the week the trade happened');
});

it('draft picks are disclosed rather than quietly ignored', () => {
  const snaps = new Map([week(2, [mu(1, ['p1'], { p1: 10 }), mu(2, ['p2'], { p2: 5 })])]);
  const v = trades.scoreTrade(
    { week: 1, revisit_week: 2, received: { 1: ['p1'], 2: ['p2'] }, draft_picks: [{ round: 1 }] },
    snaps, players);
  assert.strictEqual(v.hasPicks, true,
    'a pick trade would be graded as if the pick did not exist');
});

it('a grade is retrospective only, and a wash is a wash', () => {
  assert.deepStrictEqual(trades.gradeFor(2), ['C', 'C']);
  assert.deepStrictEqual(trades.gradeFor(60), ['A+', 'F']);
});

console.log('\ntwo measures, because neither settles it alone');

it('best-against-best strips the volume from an uneven trade', () => {
  /*
   * The real case: 2023 week 10. Danner got Gibbs (98.0) and Addison (47.6),
   * Brennan got Ekeler (51.5). Summing everything says 94.1; comparing the best
   * of each side says 46.5. Danner won either way — but by half as much.
   */
  const snaps = new Map([week(2, [
    mu(1, ['a', 'b'], { a: 98, b: 47.6 }),
    mu(2, ['c'], { c: 51.5 }),
  ])]);
  const named = new Map([['a', { full_name: 'Gibbs' }], ['b', { full_name: 'Addison' }],
                         ['c', { full_name: 'Ekeler' }]]);
  const v = trades.scoreTrade(
    { week: 1, revisit_week: 2, received: { 1: ['a', 'b'], 2: ['c'] }, draft_picks: [] },
    snaps, named);
  assert.strictEqual(v.margin, 94.1);
  assert.strictEqual(v.bestMargin, 46.5);
  assert.strictEqual(v.uneven, true);
});

it('on an even trade the two measures agree', () => {
  const snaps = new Map([week(2, [mu(1, ['a'], { a: 30 }), mu(2, ['c'], { c: 10 })])]);
  const named = new Map([['a', { full_name: 'A' }], ['c', { full_name: 'C' }]]);
  const v = trades.scoreTrade(
    { week: 1, revisit_week: 2, received: { 1: ['a'], 2: ['c'] }, draft_picks: [] },
    snaps, named);
  assert.strictEqual(v.margin, v.bestMargin);
  assert.strictEqual(v.uneven, false);
});

console.log('\na handcuff is a hedge, not a loss');

it('a same-team, same-position back-up is flagged in the current season', () => {
  const snaps = new Map([week(2, [
    // roster 1 already holds 'starter'; 'backup' arrives in the trade
    { roster_id: 1, starters: [], players: ['starter', 'backup'], players_points: { backup: 0 } },
    { roster_id: 2, starters: ['other'], players: ['other'], players_points: { other: 10 } },
  ])]);
  const named = new Map([
    ['starter', { full_name: 'Starter', position: 'RB', team: 'DEN' }],
    ['backup', { full_name: 'Backup', position: 'RB', team: 'DEN' }],
    ['other', { full_name: 'Other', position: 'WR', team: 'KC' }],
  ]);
  const v = trades.scoreTrade(
    { week: 1, revisit_week: 2, received: { 1: ['backup'], 2: ['other'] }, draft_picks: [] },
    snaps, named, { season: String(new Date().getFullYear()) });
  const got = v.sides.find(s => s.rosterId === 1).players[0];
  assert.strictEqual(got.handcuffOf, 'Starter');
});

it('a player arriving in the SAME trade is not his own handcuff', () => {
  // Otherwise a two-back package flags itself and reads as a hedge.
  const snaps = new Map([week(2, [
    { roster_id: 1, starters: [], players: ['rb1', 'rb2'], players_points: { rb1: 5, rb2: 5 } },
    { roster_id: 2, starters: ['other'], players: ['other'], players_points: { other: 10 } },
  ])]);
  const named = new Map([
    ['rb1', { full_name: 'One', position: 'RB', team: 'DEN' }],
    ['rb2', { full_name: 'Two', position: 'RB', team: 'DEN' }],
    ['other', { full_name: 'Other', position: 'WR', team: 'KC' }],
  ]);
  const v = trades.scoreTrade(
    { week: 1, revisit_week: 2, received: { 1: ['rb1', 'rb2'], 2: ['other'] }, draft_picks: [] },
    snaps, named, { season: String(new Date().getFullYear()) });
  assert.ok(v.sides.find(s => s.rosterId === 1).players.every(p => !p.handcuffOf));
});

it('no handcuff is claimed for a past season, because teams have changed since', () => {
  /*
   * players.team is TODAY's team, refreshed nightly with no history. Asking
   * whether two men were teammates in 2020 gets an answer about 2026, and free
   * agency moves half the league every spring.
   */
  const snaps = new Map([week(2, [
    { roster_id: 1, starters: [], players: ['starter', 'backup'], players_points: { backup: 0 } },
    { roster_id: 2, starters: ['other'], players: ['other'], players_points: { other: 10 } },
  ])]);
  const named = new Map([
    ['starter', { full_name: 'Starter', position: 'RB', team: 'DEN' }],
    ['backup', { full_name: 'Backup', position: 'RB', team: 'DEN' }],
    ['other', { full_name: 'Other', position: 'WR', team: 'KC' }],
  ]);
  const v = trades.scoreTrade(
    { week: 1, revisit_week: 2, received: { 1: ['backup'], 2: ['other'] }, draft_picks: [] },
    snaps, named, { season: '2020' });
  assert.ok(!v.sides.find(s => s.rosterId === 1).players[0].handcuffOf,
    'asserted a 2020 handcuff from 2026 rosters');
});

console.log('\nvalue over replacement');

const bl = { QB: 100, RB: 50, WR: 40, TE: 20 };
const withPos = new Map([
  ['star', { full_name: 'Star', position: 'RB' }],
  ['filler', { full_name: 'Filler', position: 'WR' }],
  ['solid', { full_name: 'Solid', position: 'RB' }],
]);

it('a player who scored below replacement is worth nothing', () => {
  /*
   * The floor, and the whole reason VORP answers the uneven-trade question. If
   * a freely available player at that position produced more, acquiring this
   * one added nothing — his equal was on the waiver wire for free.
   */
  const snaps = new Map([week(2, [
    mu(1, ['filler'], { filler: 25 }),     // WR replacement is 40
    mu(2, ['solid'], { solid: 70 }),
  ])]);
  const v = trades.scoreTrade(
    { week: 1, revisit_week: 2, received: { 1: ['filler'], 2: ['solid'] }, draft_picks: [] },
    snaps, withPos, { baselines: bl });
  const got = v.sides.find(s => s.rosterId === 1).players[0];
  assert.strictEqual(got.vorp, 0, 'a below-replacement player carried value');
  assert.strictEqual(v.sides.find(s => s.rosterId === 2).players[0].vorp, 20);
});

it('VORP deflates a two-for-one built on filler', () => {
  /*
   * The filler has to be genuinely below replacement or he legitimately counts.
   * WR replacement is 40 here and he scored 30, so he is a man anybody could
   * have had for nothing.
   *
   * Raw points: 100 against 70, a 30-point win. In value: 20 against 20, a
   * wash — which is the honest reading of a star plus a body for a star.
   */
  const snaps = new Map([week(2, [
    mu(1, ['star', 'filler'], { star: 70, filler: 30 }),
    mu(2, ['solid'], { solid: 70 }),
  ])]);
  const v = trades.scoreTrade(
    { week: 1, revisit_week: 2, received: { 1: ['star', 'filler'], 2: ['solid'] }, draft_picks: [] },
    snaps, withPos, { baselines: bl });
  assert.strictEqual(v.margin, 30);
  assert.strictEqual(v.vorpMargin, 0, 'volume still flattered the bigger side');
});

it('and INFLATES a fair-looking trade for a genuine star', () => {
  // Not a shrink factor. Everything the other side got sat near replacement.
  const snaps = new Map([week(2, [
    mu(1, ['star'], { star: 200 }),
    mu(2, ['filler', 'solid'], { filler: 45, solid: 55 }),
  ])]);
  const v = trades.scoreTrade(
    { week: 1, revisit_week: 2, received: { 1: ['star'], 2: ['filler', 'solid'] }, draft_picks: [] },
    snaps, withPos, { baselines: bl });
  assert.strictEqual(v.margin, 100);
  // star 200 - 50 = 150; filler 45 - 40 = 5, solid 55 - 50 = 5, so 150 - 10.
  assert.strictEqual(v.vorpMargin, 140, 'VORP failed to show the star was the whole trade');
});

it('a position with no baseline yields no VORP rather than a guess', () => {
  // Too few rostered at that position to reach the replacement rank.
  const snaps = new Map([week(2, [mu(1, ['star'], { star: 90 }), mu(2, ['solid'], { solid: 60 })])]);
  const v = trades.scoreTrade(
    { week: 1, revisit_week: 2, received: { 1: ['star'], 2: ['solid'] }, draft_picks: [] },
    snaps, withPos, { baselines: { RB: null } });
  assert.strictEqual(v.sides[0].players[0].vorp, null);
  assert.strictEqual(v.vorpMargin, null, 'invented a margin from a missing baseline');
});

it('the baseline is the last STARTABLE player, set by the league lineup', () => {
  /*
   * Twelve teams starting one QB means QB12 is the last startable one and QB13
   * is free. Two RB slots plus two flex means the rank runs far deeper.
   */
  const players = new Map();
  const matchups = [];
  for (let i = 1; i <= 30; i++) {
    players.set('rb' + i, { full_name: 'RB' + i, position: 'RB' });
    matchups.push({ roster_id: i, starters: [], players_points: { ['rb' + i]: 100 - i } });
  }
  const snaps = new Map([[1, { matchups }]]);
  const base = trades.replacementBaselines(snaps, players, ['RB', 'RB'], 12, 1, 1);
  // 12 teams x 2 dedicated RB slots = rank 24; the 24th best scored 100-24.
  assert.strictEqual(base.RB, 76);
});

console.log(`\n${pass} passing`);
