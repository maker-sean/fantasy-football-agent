#!/usr/bin/env node
/**
 * Draft accuracy.
 *
 * Every guard in src/draftiq.js exists because a plausible version of this
 * feature produced a wrong answer on real data, and none of those answers threw
 * — they came back as confident numbers. That is what these cover:
 *
 *   - a large rank delta into a bench player is not a steal
 *   - a round 11 flier busting is not a whiff worth naming
 *   - an injury is not a whiff at all
 *   - a one pick lead over six seasons is not a leader
 *
 * Fixtures rather than the network, so this runs offline and fast. The shape of
 * the payload matches what src/sleeper.js actually stores, INCLUDING the fact
 * that picks carry no pick_no and no picked_by.
 */
const assert = require('assert');
const diq = require('../src/draftiq');

let pass = 0;
const it = (n, f) => {
  try { f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

const league = {
  total_rosters: 12,
  roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN', 'BN'],
};

/** payload in the shape a stored snapshot has. */
const payload = (picks) => ({
  league,
  rosters: [{ roster_id: 1, owner_id: 'u1' }, { roster_id: 2, owner_id: 'u2' }],
  users: [{ user_id: 'u1', display_name: 'ann' }, { user_id: 'u2', display_name: 'bo' }],
  draft: { picks },
});

const stats = m => new Map(Object.entries(m));

console.log('the startable line comes from the league, not a constant');

it('a 12 team 2RB/2WR/1TE/1FLEX league lands where it should', () => {
  const s = diq.startableLine(league);
  assert.deepStrictEqual(s, { QB: 12, RB: 29, WR: 29, TE: 14 });
});

it('superflex widens QB rather than leaving it at one per team', () => {
  const s = diq.startableLine({ total_rosters: 12,
    roster_positions: ['QB', 'SUPER_FLEX', 'RB', 'WR', 'TE'] });
  assert.strictEqual(s.QB, 24);
});

it('a 10 team league gets a tighter line than a 12', () => {
  const ten = diq.startableLine({ ...league, total_rosters: 10 });
  assert.ok(ten.WR < diq.startableLine(league).WR);
});

console.log('\npick order comes from array order, because pick_no is not stored');

it('positional rank follows the array, not the round', () => {
  const picks = [
    { player_id: 'a', roster_id: 1, round: 1 },
    { player_id: 'b', roster_id: 2, round: 1 },
    { player_id: 'c', roster_id: 1, round: 2 },
  ];
  const out = diq.annotate({ season: '2024', payload: payload(picks), stats: stats({
    a: { position: 'WR', rank: 5, points: 200, gamesPlayed: 17, name: 'A' },
    b: { position: 'WR', rank: 9, points: 180, gamesPlayed: 17, name: 'B' },
    c: { position: 'WR', rank: 2, points: 240, gamesPlayed: 17, name: 'C' },
  })});
  assert.deepStrictEqual(out.map(p => p.draftedRank), [1, 2, 3]);
  // C went third among receivers and finished WR2, so a gain of one.
  assert.strictEqual(out[2].gain, 1);
});

it('the drafter is the roster owner, since picked_by is not stored either', () => {
  const out = diq.annotate({ season: '2024', payload: payload([
    { player_id: 'a', roster_id: 2, round: 1 },
  ]), stats: stats({ a: { position: 'RB', rank: 3, points: 200, gamesPlayed: 17, name: 'A' } }) });
  assert.strictEqual(out[0].sleeperUserId, 'u2');
});

it('a player with no stats row is skipped rather than counted as a bust', () => {
  const out = diq.annotate({ season: '2024', payload: payload([
    { player_id: 'ghost', roster_id: 1, round: 14 },
    { player_id: 'a', roster_id: 1, round: 1 },
  ]), stats: stats({ a: { position: 'WR', rank: 4, points: 200, gamesPlayed: 17, name: 'A' } }) });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].draftedRank, 1);
});

it('a player who never ranked has an outcome but no delta', () => {
  const out = diq.annotate({ season: '2024', payload: payload([
    { player_id: 'a', roster_id: 1, round: 2 },
  ]), stats: stats({ a: { position: 'WR', rank: null, points: 0, gamesPlayed: 0, name: 'A' } }) });
  assert.strictEqual(out[0].gain, null);
});

console.log('\nthe three lists, and what each one refuses');

const S = diq.startableLine(league);
const pick = o => ({ season: '2024', sleeperUserId: 'u1', manager: 'ann', position: 'WR',
  player: 'X', round: 3, draftedRank: 40, finishRank: 20, gamesPlayed: 17, gain: 20, ...o });

it('a big delta into a bench player is NOT a steal', () => {
  // WR60 to WR33 is a gain of 27 and still unstartable in this league.
  const b = diq.buckets([pick({ draftedRank: 60, finishRank: 33, gain: 27 })], S);
  assert.strictEqual(b.steals.length, 0);
});

it('a smaller delta that lands startable IS a steal', () => {
  const b = diq.buckets([pick({ draftedRank: 40, finishRank: 22, gain: 18 })], S);
  assert.strictEqual(b.steals.length, 1);
});

it('a late round bust is not a whiff, because the pick cost nothing', () => {
  const b = diq.buckets([pick({ round: 11, draftedRank: 47, finishRank: 114, gain: -67 })], S);
  assert.strictEqual(b.whiffs.length, 0);
});

it('an early round bust who played the season IS a whiff', () => {
  const b = diq.buckets([pick({ round: 1, draftedRank: 5, finishRank: 41, gain: -36 })], S);
  assert.strictEqual(b.whiffs.length, 1);
});

it('an injury is never a whiff, however early the pick', () => {
  const hurt = pick({ round: 1, draftedRank: 1, finishRank: 71, gain: -70, gamesPlayed: 4 });
  const b = diq.buckets([hurt], S);
  assert.strictEqual(b.whiffs.length, 0, 'blaming a drafter for four games played');
  assert.strictEqual(b.cursed.length, 1);
});

it('cursed is variable length and empty is a real answer', () => {
  const b = diq.buckets([pick({ round: 1, gamesPlayed: 17 })], S);
  assert.deepStrictEqual(b.cursed, []);
});

it('a season is not represented twice while another has a candidate', () => {
  const rows = [
    pick({ season: '2024', draftedRank: 50, finishRank: 5, gain: 45 }),
    pick({ season: '2024', draftedRank: 50, finishRank: 8, gain: 42 }),
    pick({ season: '2023', draftedRank: 50, finishRank: 20, gain: 30 }),
  ];
  const b = diq.buckets(rows, S, { limit: 2 });
  assert.deepStrictEqual(b.steals.map(s => s.season), ['2024', '2023']);
});

console.log('\nextremes are counts, and a thin lead is not a leader');

const many = (n, o) => Array.from({ length: n }, () => pick(o));

it('one pick clear of the field is reported as too close to call', () => {
  const rows = [
    ...many(6, { sleeperUserId: 'u1', round: 2, gain: -25, finishRank: 60, gamesPlayed: 17 }),
    ...many(5, { sleeperUserId: 'u2', round: 2, gain: -25, finishRank: 60, gamesPlayed: 17 }),
  ];
  const [whiffs] = diq.extremes(rows, S);
  assert.strictEqual(whiffs.count, 6);
  assert.strictEqual(whiffs.clear, false, 'a one pick lead was crowned');
});

it('a clear lead is a clear lead', () => {
  const rows = [
    ...many(6, { sleeperUserId: 'u1', round: 2, gain: -25, finishRank: 60, gamesPlayed: 17 }),
    ...many(2, { sleeperUserId: 'u2', round: 2, gain: -25, finishRank: 60, gamesPlayed: 17 }),
  ];
  const [whiffs] = diq.extremes(rows, S);
  assert.strictEqual(whiffs.clear, true);
});

it('an exact tie names both and is never clear', () => {
  const rows = [
    ...many(4, { sleeperUserId: 'u1', round: 2, gain: -25, finishRank: 60, gamesPlayed: 17 }),
    ...many(4, { sleeperUserId: 'u2', round: 2, gain: -25, finishRank: 60, gamesPlayed: 17 }),
  ];
  const [whiffs] = diq.extremes(rows, S);
  assert.strictEqual(whiffs.holders.length, 2);
  assert.strictEqual(whiffs.clear, false);
});

it('a pick that merely underperformed does not count toward whiffs', () => {
  // Rank delta is negatively biased, so counting every gain < 0 makes almost
  // every pick a whiff and the leader meaningless.
  const rows = many(9, { sleeperUserId: 'u1', round: 2, gain: -3, finishRank: 25, gamesPlayed: 17 });
  assert.deepStrictEqual(diq.extremes(rows, S), []);
});

console.log('\nmirrors');

it('the same player up one season and down another is found', () => {
  const rows = [
    pick({ season: '2024', sleeperUserId: 'u1', player: 'Brian Thomas', draftedRank: 43, finishRank: 4, gain: 39 }),
    pick({ season: '2025', sleeperUserId: 'u2', player: 'Brian Thomas', draftedRank: 8, finishRank: 43, gain: -35, round: 2 }),
  ];
  const m = diq.mirrors(rows);
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].up.season, '2024');
  assert.strictEqual(m[0].down.season, '2025');
});

it('a down season caused by injury is not a mirror', () => {
  const rows = [
    pick({ season: '2024', player: 'P', draftedRank: 43, finishRank: 4, gain: 39 }),
    pick({ season: '2025', player: 'P', draftedRank: 8, finishRank: 99, gain: -91, gamesPlayed: 3 }),
  ];
  assert.deepStrictEqual(diq.mirrors(rows), []);
});

console.log('\nthe prompt block');

const block = (over) => diq.draftBlock({
  seasons: ['2024'], startable: S, steals: [], whiffs: [], cursed: [], mirrors: [], extremes: [], picks: [], ...over,
});

it('an empty result produces no block at all', () => {
  assert.strictEqual(block(), '');
  assert.strictEqual(diq.draftBlock(null), '');
});

it('a section with nothing in it is omitted rather than printed empty', () => {
  const b = block({ steals: [pick({})] });
  assert.ok(b.includes('BEST PICKS'));
  assert.ok(!b.includes('WORST PICKS'));
  assert.ok(!b.includes('WRECKED BY INJURY'));
});

it('it tells the model not to rank the managers', () => {
  assert.match(block({ steals: [pick({})] }), /[Dd]o not rank/);
});

it('the injury list says out loud that it is not the drafter\'s fault', () => {
  const b = block({ cursed: [pick({ gamesPlayed: 2 })] });
  assert.match(b, /NOT the drafter/);
});

it('a real name is joined to the sleeper handle, since the model will not guess', () => {
  const b = diq.draftBlock({ seasons: ['2024'], startable: S, steals: [pick({})],
    whiffs: [], cursed: [], mirrors: [], extremes: [], picks: [] },
    new Map([['u1', 'Ann']]));
  assert.match(b, /Ann \(ann\)/);
});

it('no em dashes, because a quoted line has to read like a person', () => {
  const b = block({ steals: [pick({})], whiffs: [pick({ round: 1, gain: -30, finishRank: 70 })],
    cursed: [pick({ gamesPlayed: 1 })] });
  assert.ok(!/—/.test(b), 'em dash found');
});

console.log(`\n${pass} passing`);
