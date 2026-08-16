#!/usr/bin/env node
/**
 * Trade announcements, scheduling, and the retrospective grade.
 *
 * Two things here cannot be tested against real data and so carry the most
 * risk: no pending or vetoed trade has ever been captured, because the only
 * league on file runs trade_review_days = 0. Those paths are exercised with
 * fixtures, and "it deploys clean" is not evidence they work.
 */
const assert = require('assert');
const t = require('../src/trades');

let pass = 0;
const it = (n, f) => {
  try { f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

// --- scheduling -------------------------------------------------------------
console.log('per-league schedule (8am / 6pm by default)');

const league = (over = {}) => ({ id: 'l1', config: { timezone: 'America/New_York' }, ...over });
// A fixed instant, expressed so the intent is readable: 9am ET.
const at = iso => new Date(iso).getTime();

it('due after the morning window opens, never polled', () =>
  assert.strictEqual(t.isDue(league(), at('2025-11-04T14:00:00Z')), true));   // 9am ET

it('not due before the first window', () =>
  assert.strictEqual(t.isDue(league(), at('2025-11-04T11:00:00Z')), false));  // 6am ET

it('not due again once polled inside the same window', () =>
  assert.strictEqual(
    t.isDue(league({ trades_polled_at: '2025-11-04T13:05:00Z' }), at('2025-11-04T14:00:00Z')),
    false));

it('due again when the evening window opens', () =>
  assert.strictEqual(
    t.isDue(league({ trades_polled_at: '2025-11-04T13:05:00Z' }), at('2025-11-04T23:30:00Z')),
    true));  // 6:30pm ET

// The reason due-ness is elapsed-time based rather than clock-matching: a
// worker down at exactly 08:00 must not lose the window until 6pm.
it('a worker that missed 8:00 still polls at 8:15', () =>
  assert.strictEqual(
    t.isDue(league({ trades_polled_at: '2025-11-03T23:30:00Z' }), at('2025-11-04T13:15:00Z')),
    true));

it('respects a custom schedule', () =>
  assert.strictEqual(
    t.isDue(league({ config: { timezone: 'America/New_York', tradePollHours: [12] } }),
            at('2025-11-04T14:00:00Z')),
    false));  // 9am ET, but this league only polls at noon

it('respects a league in another timezone', () => {
  const pacific = league({ config: { timezone: 'America/Los_Angeles' } });
  assert.strictEqual(t.isDue(pacific, at('2025-11-04T14:00:00Z')), false); // 6am PT
  assert.strictEqual(t.isDue(pacific, at('2025-11-04T17:00:00Z')), true);  // 9am PT
});

it('an empty schedule disables polling', () =>
  assert.strictEqual(t.isDue(league({ config: { tradePollHours: [] } }), Date.now()), false));

// --- status vocabulary ------------------------------------------------------
console.log('\nstatus vocabulary — unverified, so handled defensively');

it('complete is settled', () => assert.strictEqual(t.isSettled('complete'), true));
it('case does not matter', () => assert.strictEqual(t.isSettled('COMPLETE'), true));
it('several plausible rejection words are all caught', () => {
  for (const s of ['vetoed', 'veto', 'rejected', 'failed']) {
    assert.strictEqual(t.isRejected(s), true, s + ' should count as rejected');
  }
});
it('an unknown status is not silently treated as settled', () => {
  assert.strictEqual(t.isSettled('reversed_by_commissioner'), false);
  assert.strictEqual(t.isRejected('reversed_by_commissioner'), false);
});

// --- announcements ----------------------------------------------------------
console.log('\nannouncements carry facts, never a grade');

const names = new Map([[3, 'Punt Intended'], [7, 'To Infinity & Bijan']]);
const players = new Map([
  ['3198', { full_name: 'Derrick Henry' }],
  ['6130', { full_name: 'Devin Singletary' }],
]);
const trade = { week: 10, revisit_week: 13, received: { 3: ['6130'], 7: ['3198'] }, draft_picks: [] };
const say = (from, to) => t.composeAnnouncement({ trade, from, to }, { names, players });

it('names both sides and what they got', () => {
  const m = say(null, 'complete');
  assert.ok(m.includes('Derrick Henry') && m.includes('Devin Singletary'));
  assert.ok(m.includes('Punt Intended') && m.includes('To Infinity & Bijan'));
});

it('makes no claim about who won', () => {
  const m = say(null, 'complete').toLowerCase();
  for (const word of ['won', 'wins', 'fleeced', 'grade:', 'better']) {
    assert.ok(!m.includes(word), `announcement must not say "${word}"`);
  }
});

it('contains no numbers that could be a projection', () => {
  const m = say(null, 'complete').replace(/3 weeks/g, '');
  assert.ok(!/\d+\.\d/.test(m), 'no decimal figures at announcement time');
});

it('a proposal reads as pending', () =>
  assert.ok(/review/i.test(say(null, 'pending'))));

it('a veto is announced', () =>
  assert.ok(/vetoed/i.test(say('pending', 'vetoed'))));

// If only vetoes got a follow-up, silence after a proposal would be ambiguous:
// completed and "the bot broke" would look identical.
it('completion after a proposal is announced too, so silence is never ambiguous', () => {
  const m = say('pending', 'complete');
  assert.ok(m && /went through/i.test(m));
});

it('an unknown status produces no message', () =>
  assert.strictEqual(say(null, 'reversed_by_commissioner'), null));

// --- the grade --------------------------------------------------------------
console.log('\nthe grade — retrospective arithmetic, not prediction');

const snapshots = new Map([
  [11, { matchups: [
    { roster_id: 7, starters: ['3198'], players_points: { 3198: 19.2 } },
    { roster_id: 3, starters: ['6130'], players_points: { 6130: 17.2 } }] }],
  [12, { matchups: [
    { roster_id: 7, starters: ['3198'], players_points: { 3198: 21.8 } },
    { roster_id: 3, starters: [],       players_points: { 6130: 4.7 } }] }],
  [13, { matchups: [
    { roster_id: 7, starters: ['3198'], players_points: { 3198: 16.9 } },
    { roster_id: 3, starters: ['6130'], players_points: { 6130: 17.7 } }] }],
]);

it('counts only points from weeks the player was started', () => {
  const v = t.scoreTrade(trade, snapshots, players);
  const three = v.sides.find(s => s.rosterId === 3);
  assert.strictEqual(three.startedPoints, 34.9, 'week 12 was a bench week — 4.7 excluded');
});

it('sums the winning side correctly', () => {
  const v = t.scoreTrade(trade, snapshots, players);
  assert.strictEqual(v.sides.find(s => s.rosterId === 7).startedPoints, 57.9);
});

it('a player who left the roster is marked, not counted as zero', () => {
  const gone = { ...trade, received: { 3: ['6130'], 7: ['3198', '9999'] } };
  const v = t.scoreTrade(gone, snapshots, new Map([...players, ['9999', { full_name: 'Cut Guy' }]]));
  const p = v.sides.find(s => s.rosterId === 7).players.find(x => x.playerId === '9999');
  assert.strictEqual(p.droppedAfterTrade, true);
  assert.ok(p.weeks.every(w => w.offRoster), 'every week recorded as off-roster');
});

it('a near-tie grades as a wash rather than a winner', () => {
  assert.deepStrictEqual(t.gradeFor(2), ['C', 'C']);
});
it('a blowout grades accordingly', () => {
  assert.deepStrictEqual(t.gradeFor(60), ['A+', 'F']);
});
it('the grade is symmetric in sign', () => {
  assert.deepStrictEqual(t.gradeFor(-60), t.gradeFor(60));
});

it('the verdict states its own limits', () => {
  const v = t.scoreTrade(trade, snapshots, players);
  const text = t.composeVerdict({ ...trade }, v, names);
  assert.ok(/started points only/i.test(text), 'says what it measured');
  assert.ok(/weeks 11-13/.test(text), 'says over what window');
});

it('draft picks are disclosed as uncounted, not silently dropped', () => {
  const withPicks = { ...trade, draft_picks: [{ round: 2 }] };
  const v = t.scoreTrade(withPicks, snapshots, players);
  assert.strictEqual(v.hasPicks, true);
  assert.ok(/picks not counted/i.test(t.composeVerdict(withPicks, v, names)));
});

console.log(`\n${pass} passing`);
