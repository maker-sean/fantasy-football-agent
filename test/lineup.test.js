#!/usr/bin/env node
/**
 * Lineup rules — the layer where a wrong answer is worst.
 *
 * Every claim here becomes something the bot says out loud to people who know
 * the rules better than it does. Run: node test/lineup.test.js
 */
const assert = require('assert');
const { canFill, activeSlots, optimalLineup, bestLegalSwap, describeRules, unstartablePositions } = require('../src/lineup');

let pass = 0;
const it = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass += 1; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

console.log('eligibility');
it('a QB cannot fill a WR slot', () => assert.strictEqual(canFill('WR', 'QB'), false));
it('a QB cannot fill a standard FLEX', () => assert.strictEqual(canFill('FLEX', 'QB'), false));
it('a QB can fill SUPER_FLEX', () => assert.strictEqual(canFill('SUPER_FLEX', 'QB'), true));
it('FLEX takes RB, WR, TE', () => ['RB', 'WR', 'TE'].forEach(p => assert.strictEqual(canFill('FLEX', p), true)));
it('WRRB_FLEX excludes TE', () => assert.strictEqual(canFill('WRRB_FLEX', 'TE'), false));
it('REC_FLEX excludes RB', () => assert.strictEqual(canFill('REC_FLEX', 'RB'), false));
it('K slot takes only K', () => assert.strictEqual(canFill('K', 'WR'), false));
it('bench slots are excluded', () => assert.deepStrictEqual(activeSlots(['QB', 'BN', 'IR', 'TAXI', 'RB']), ['QB', 'RB']));

console.log('\nper-league rules');
it('single-QB league is not superflex', () =>
  assert.strictEqual(describeRules(['QB', 'RB', 'WR', 'FLEX', 'BN']).superflex, false));
it('2QB league is detected', () => {
  const r = describeRules(['QB', 'QB', 'RB', 'WR', 'BN']);
  assert.strictEqual(r.qbSlots, 2);
  assert.strictEqual(r.superflex, true);
});
it('SUPER_FLEX counts as QB-capable', () =>
  assert.strictEqual(describeRules(['QB', 'SUPER_FLEX', 'RB', 'BN']).qbSlots, 2));
it('unknown slots are reported, not silently ignored', () =>
  assert.deepStrictEqual(describeRules(['QB', 'MYSTERY', 'BN']).unknown, ['MYSTERY']));

console.log('\noptimal lineup');
const roster = [
  { pid: 'qb1', points: 30, position: 'QB' },
  { pid: 'qb2', points: 28, position: 'QB' },
  { pid: 'rb1', points: 20, position: 'RB' },
  { pid: 'rb2', points: 15, position: 'RB' },
  { pid: 'wr1', points: 18, position: 'WR' },
  { pid: 'te1', points: 5, position: 'TE' },
];
it('maximizes total within slot rules', () =>
  assert.strictEqual(optimalLineup(roster, ['QB', 'RB', 'WR', 'TE', 'FLEX']).total, 88));
it('never assigns one player to two slots', () => {
  const a = optimalLineup(roster, ['QB', 'RB', 'WR', 'TE', 'FLEX']).assignment;
  assert.strictEqual(new Set(a.map(x => x.pid)).size, a.length);
});
it('a 2nd QB is unusable without SUPER_FLEX', () => {
  const a = optimalLineup(roster, ['QB', 'RB', 'WR', 'TE', 'FLEX']).assignment;
  assert.strictEqual(a.some(x => x.pid === 'qb2'), false);
});
it('a 2nd QB IS usable with SUPER_FLEX', () => {
  const a = optimalLineup(roster, ['QB', 'SUPER_FLEX', 'RB', 'WR']).assignment;
  assert.strictEqual(a.some(x => x.pid === 'qb2'), true);
});
it('every assigned player is eligible for its slot', () => {
  for (const x of optimalLineup(roster, ['QB', 'RB', 'WR', 'TE', 'FLEX']).assignment) {
    assert.ok(canFill(x.slot, x.position), `${x.position} in ${x.slot}`);
  }
});
it('beats greedy on overlapping eligibility', () =>
  assert.strictEqual(optimalLineup([
    { pid: 'te_big', points: 25, position: 'TE' },
    { pid: 'te_small', points: 3, position: 'TE' },
    { pid: 'rb', points: 24, position: 'RB' },
  ], ['TE', 'FLEX']).total, 49));
it('handles a slot no rostered player can fill', () =>
  assert.strictEqual(optimalLineup([{ pid: 'wr', points: 10, position: 'WR' }], ['WR', 'K']).total, 10));

console.log('\nlegal swaps');
const starters = [
  { pid: 's_wr', slot: 'WR', points: 3.9, name: 'Sutton', position: 'WR' },
  { pid: 's_qb', slot: 'QB', points: 22, name: 'Hurts', position: 'QB' },
];
it('a benched QB swaps against the QB starter, never the WR', () => {
  const s = bestLegalSwap(starters, [{ pid: 'b_qb', points: 26.9, name: 'Stafford', position: 'QB' }]);
  assert.strictEqual(s.slot, 'QB');
  assert.strictEqual(s.swing, 4.9);
});
it('no swap is reported when none is legal', () =>
  assert.strictEqual(bestLegalSwap(
    [{ pid: 's', slot: 'K', points: 1, position: 'K' }],
    [{ pid: 'b', points: 99, position: 'QB' }]), null));
it('no swap is reported when the bench player scored less', () =>
  assert.strictEqual(bestLegalSwap(starters, [{ pid: 'b', points: 1, position: 'QB' }]), null));

console.log('\nIDP (individual defensive players)');
// Sleeper labels defenders granularly; league slots are generic. Omitting any
// of these makes real players silently unstartable.
it('LB slot accepts LB, OLB, ILB', () =>
  ['LB', 'OLB', 'ILB'].forEach(p => assert.strictEqual(canFill('LB', p), true, p)));
it('DB slot accepts DB, CB, S, SS, FS', () =>
  ['DB', 'CB', 'S', 'SS', 'FS'].forEach(p => assert.strictEqual(canFill('DB', p), true, p)));
it('DL slot accepts DL, DE, DT, NT', () =>
  ['DL', 'DE', 'DT', 'NT'].forEach(p => assert.strictEqual(canFill('DL', p), true, p)));
it('defensive slots do not cross (CB is not a LB)', () => {
  assert.strictEqual(canFill('LB', 'CB'), false);
  assert.strictEqual(canFill('DL', 'LB'), false);
  assert.strictEqual(canFill('DB', 'DE'), false);
});
it('IDP_FLEX accepts any defender but no skill player', () => {
  ['OLB', 'FS', 'NT', 'CB'].forEach(p => assert.strictEqual(canFill('IDP_FLEX', p), true, p));
  assert.strictEqual(canFill('IDP_FLEX', 'WR'), false);
});
it('offensive FLEX never accepts a defender', () =>
  ['LB', 'CB', 'DE'].forEach(p => assert.strictEqual(canFill('FLEX', p), false, p)));
it('a fullback is a running back', () => {
  assert.strictEqual(canFill('RB', 'FB'), true);
  assert.strictEqual(canFill('FLEX', 'FB'), true);
});
it('an IDP league is detected and described', () => {
  const r = describeRules(['QB','RB','RB','WR','WR','TE','FLEX','K','DEF','DL','DL','LB','LB','DB','DB','IDP_FLEX','BN']);
  assert.strictEqual(r.idp, true);
  assert.strictEqual(r.idpSlots, 7);
  assert.strictEqual(r.teamDefense, true);
  assert.deepStrictEqual(r.unknown, []);
});
it('an offense-only league is not flagged as IDP', () =>
  assert.strictEqual(describeRules(['QB','RB','WR','FLEX','K','DEF','BN']).idp, false));
it('IDP players are startable in an IDP league', () =>
  assert.deepStrictEqual(unstartablePositions(['OLB','SS','NT','CB'], ['LB','DB','DL','BN']), []));
it('IDP players are flagged in an offense-only league', () =>
  assert.deepStrictEqual(unstartablePositions(['OLB','SS'], ['QB','RB','WR','FLEX','BN']).sort(), ['OLB','SS']));
it('solves a 20-slot IDP lineup without duplicates', () => {
  const mk = (n, pos) => Array.from({ length: n }, (_, i) => ({ pid: pos + i, points: (n - i) * 3, position: pos }));
  const roster = [...mk(3,'QB'), ...mk(6,'RB'), ...mk(8,'WR'), ...mk(3,'TE'), ...mk(2,'K'),
                  ...mk(2,'DEF'), ...mk(6,'OLB'), ...mk(6,'CB'), ...mk(6,'DE')];
  const slots = ['QB','RB','RB','WR','WR','WR','TE','FLEX','FLEX','K','DEF','DL','DL','DL','LB','LB','LB','DB','DB','DB'];
  const r = optimalLineup(roster, slots);
  assert.strictEqual(r.assignment.length, slots.length, 'every slot filled');
  assert.strictEqual(new Set(r.assignment.map(x => x.pid)).size, r.assignment.length, 'no duplicates');
  for (const x of r.assignment) assert.ok(canFill(x.slot, x.position), `${x.position} in ${x.slot}`);
});
it('identical slots are interchangeable, not double-counted', () => {
  const r = optimalLineup([
    { pid: 'lb1', points: 20, position: 'LB' },
    { pid: 'lb2', points: 15, position: 'OLB' },
    { pid: 'lb3', points: 10, position: 'ILB' },
  ], ['LB', 'LB']);
  assert.strictEqual(r.total, 35);
  assert.strictEqual(r.assignment.length, 2);
});

console.log(`\n${pass} passing`);
