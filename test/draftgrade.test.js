#!/usr/bin/env node
/**
 * Grading and ranking twelve rosters.
 *
 * THE MEASURE IS THE STARTING LINEUP. A bench stacked with running backs scores
 * nothing, and a team can lead the league in total projected points while
 * starting a hole at tight end.
 *
 * SEASON projections, never weekly. The first cut used the current week's, and
 * every team came back with an identical wall of empty slots and a total of
 * about 21 — one quarterback — because a preseason week projects almost nobody.
 * That failure looked like twelve tied teams rather than like an error.
 *
 * Ranks, grades and positional strengths are computed here rather than
 * described in a paragraph, for the reason everything else in this repo is:
 * hand a model twelve rosters and it will rank them and state the result as
 * fact, and nothing downstream can check it.
 */
const assert = require('assert');
if (!process.env.DATABASE_URL) require('dotenv').config();

const dg = require('../src/draftgrade');
const db = require('../src/db');

let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

// A tiny league: two slots, four teams, made-up players.
const SLOTS = ['QB', 'RB', 'BN'];
const mkProj = rows => new Map(rows.map(r => [String(r.playerId), r]));

(async () => {
  console.log('\nthe bands');

  await it('better than average grades higher, and the order never crosses', async () => {
    const letters = [0.20, 0.08, 0.03, 0, -0.03, -0.08, -0.20].map(o => dg.gradeFor(o).grade);
    assert.deepStrictEqual(letters, ['A+', 'A', 'B+', 'B', 'C+', 'C', 'D']);
  });

  await it('dead average is a B, not a winner or a loser', async () => {
    assert.strictEqual(dg.gradeFor(0).grade, 'B');
  });

  console.log('\nranking rosters');

  const proj = mkProj([
    { playerId: '1', name: 'QB A', position: 'QB', points: 400 },
    { playerId: '2', name: 'QB B', position: 'QB', points: 300 },
    { playerId: '3', name: 'QB C', position: 'QB', points: 200 },
    { playerId: '4', name: 'QB D', position: 'QB', points: 100 },
    { playerId: '5', name: 'RB A', position: 'RB', points: 400 },
    { playerId: '6', name: 'RB B', position: 'RB', points: 300 },
    { playerId: '7', name: 'RB C', position: 'RB', points: 200 },
    { playerId: '8', name: 'RB D', position: 'RB', points: 100 },
    { playerId: '9', name: 'BENCH', position: 'RB', points: 9999 },
  ]);
  const rosters = [
    { roster_id: 1, players: ['1', '5'] },
    { roster_id: 2, players: ['2', '6'] },
    { roster_id: 3, players: ['3', '7'] },
    { roster_id: 4, players: ['4', '8'] },
  ];

  await it('teams rank by starting lineup, best first', async () => {
    const out = dg.gradeDraft({ rosters, rosterPositions: SLOTS, proj, nameOf: r => `T${r}` });
    assert.deepStrictEqual(out.teams.map(t => t.rosterId), [1, 2, 3, 4]);
    assert.deepStrictEqual(out.teams.map(t => t.rank), [1, 2, 3, 4]);
    assert.strictEqual(out.teams[0].total, 800);
    assert.strictEqual(out.mean, 500);
  });

  await it('depth beyond the slots does not count', async () => {
    /*
     * The whole reason the lineup is the measure rather than the roster: a
     * second and third running back behind a one-RB requirement add nothing to
     * what the team can actually field.
     *
     * Note what this does NOT claim. The lineup is OPTIMISED, so the best
     * eligible player fills each slot — an earlier version of this test called
     * a 9,999 point running back "bench" and asserted he was ignored, which was
     * the test being wrong: you would obviously start him.
     */
    const deep = [{ roster_id: 1, players: ['1', '5', '6', '7'] }, ...rosters.slice(1)];
    const out = dg.gradeDraft({ rosters: deep, rosterPositions: SLOTS, proj, nameOf: r => `T${r}` });
    const t1 = out.teams.find(t => t.rosterId === 1);
    assert.strictEqual(t1.total, 800, 'the best QB and the best RB, and nothing behind them');
    assert.strictEqual(t1.starters, 2);
  });

  await it('strengths and weaknesses are RELATIVE, not an absolute bar', async () => {
    const out = dg.gradeDraft({ rosters, rosterPositions: SLOTS, proj, nameOf: r => `T${r}` });
    const best = out.teams.find(t => t.rosterId === 1);
    const worst = out.teams.find(t => t.rosterId === 4);
    assert.ok((best.strengths || []).some(x => x.pos === 'QB'), 'the top QB is a strength');
    assert.ok((worst.weaknesses || []).some(x => x.pos === 'QB'), 'the bottom QB is a weakness');
    assert.ok(!(best.weaknesses || []).length, 'the best team has no weakness in this pool');
  });

  await it('an unfillable slot is reported as a hole, not as zero points', async () => {
    const out = dg.gradeDraft({
      rosters: [{ roster_id: 1, players: ['1'] }, { roster_id: 2, players: ['2', '6'] }],
      rosterPositions: SLOTS, proj, nameOf: r => `T${r}`,
    });
    const t1 = out.teams.find(t => t.rosterId === 1);
    assert.deepStrictEqual(t1.holes, ['RB'], 'the empty RB slot must be named');
  });

  await it('no rosters at all yields nothing rather than twelve tied zeroes', async () => {
    assert.strictEqual(dg.gradeDraft({ rosters: [], rosterPositions: SLOTS, proj }), null);
  });

  console.log('\ndynasty is graded on the market, not on this season');

  await it('market value ranks the team the projection would have buried', async () => {
    /*
     * The correction this exists for. A rookie just drafted projects near
     * nothing this year — that is the point of the pick, the bet is that he
     * becomes a top-ten player in a few seasons. Grading dynasty on season
     * projections marks a team DOWN for the asset it just acquired, which gets
     * a draft grade exactly backwards.
     */
    const rookieHeavy = [
      { roster_id: 1, players: ['4', '8'] },   // worst on projections
      { roster_id: 2, players: ['1', '5'] },   // best on projections
    ];
    const values = new Map([['4', 9000], ['8', 9000], ['1', 100], ['5', 100]]);

    const byProj = dg.gradeDraft({ rosters: rookieHeavy, rosterPositions: SLOTS, proj, nameOf: r => `T${r}` });
    assert.strictEqual(byProj.teams[0].rosterId, 2, 'projections favour the veteran team');

    const byMarket = dg.gradeDraft({
      rosters: rookieHeavy, rosterPositions: SLOTS, proj, values, basis: 'market', nameOf: r => `T${r}` });
    assert.strictEqual(byMarket.basis, 'market');
    assert.strictEqual(byMarket.teams[0].rosterId, 1, 'market favours the team holding the assets');
  });

  await it('both rankings survive, because they answer different questions', async () => {
    const values = new Map([['4', 9000], ['8', 9000], ['1', 100], ['5', 100]]);
    const out = dg.gradeDraft({
      rosters: [{ roster_id: 1, players: ['4', '8'] }, { roster_id: 2, players: ['1', '5'] }],
      rosterPositions: SLOTS, proj, values, basis: 'market', nameOf: r => `T${r}` });
    const top = out.teams.find(t => t.rosterId === 1);
    assert.strictEqual(top.rank, 1, 'first by market');
    assert.strictEqual(top.lineupRank, 2, 'and last by this season, which must not be lost');
  });

  await it('a player the market does not cover is counted, not treated as zero', async () => {
    /*
     * The value source lists a few hundred assets, not every rostered player.
     * Silently scoring the missing ones at zero would penalise a deep roster
     * for the source's coverage rather than for anything the manager did.
     */
    const out = dg.gradeDraft({
      rosters: [{ roster_id: 1, players: ['1', '5', '9'] }, { roster_id: 2, players: ['2'] }],
      rosterPositions: SLOTS, proj, values: new Map([['1', 500], ['5', 500]]),
      basis: 'market', nameOf: r => `T${r}` });
    const t1 = out.teams.find(t => t.rosterId === 1);
    assert.strictEqual(t1.priced, 2);
    assert.strictEqual(t1.unpriced, 1, 'the uncovered player must be reported, not absorbed');
    assert.strictEqual(t1.market, 1000);
  });

  await it('an unpriced ROOKIE is counted apart from an unpriced veteran', async () => {
    /*
     * The failure this guards, which cannot be observed live until a rookie
     * draft completes and Sleeper puts the picks on rosters.
     *
     * No rookie in the value source carries a price. So a team that just drafted
     * well is counted at ZERO for exactly the assets it drafted — the same way
     * grading dynasty on season projections gets a draft grade backwards, only
     * arriving by coverage instead of by measure. An unpriced deep-bench veteran
     * is a shrug; an unpriced rookie is the pick itself.
     */
    const out = dg.gradeDraft({
      rosters: [{ roster_id: 1, players: ['1', '5', '9', '4'] }, { roster_id: 2, players: ['2', '6'] }],
      rosterPositions: SLOTS, proj,
      values: new Map([['1', 500], ['5', 500], ['2', 400], ['6', 400]]),
      rookies: new Set(['9']),            // '4' is an unpriced veteran
      basis: 'market', nameOf: r => `T${r}`,
    });
    const t1 = out.teams.find(t => t.rosterId === 1);
    assert.strictEqual(t1.unpriced, 2, 'both uncovered players count as unpriced');
    assert.strictEqual(t1.rookieCount, 1, 'and the rookie among them is named separately');
  });

  await it('with no values at all it falls back to projections rather than zeroing everyone', async () => {
    const out = dg.gradeDraft({ rosters, rosterPositions: SLOTS, proj, values: null, basis: 'market', nameOf: r => `T${r}` });
    assert.strictEqual(out.basis, 'projection');
  });

  console.log(`\n${pass} passing`);
  await db.pool.end();
})();
