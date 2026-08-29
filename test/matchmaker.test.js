#!/usr/bin/env node
/**
 * Finding a trade both managers would actually make.
 *
 * The premise: a trade is zero-sum in VALUE and not in LINEUP. A starting
 * quarterback on the bench of a one-quarterback league is worth nothing to his
 * owner and plenty to somebody else, and the match is found by simulating the
 * swap rather than reasoning about it.
 *
 * Two filters carry the whole feature, and both exist because of what the
 * search produces without them:
 *
 *   BOTH must improve. Ranked on the asker's gain alone the top suggestion was
 *   "send your worst bench player for their best starter".
 *
 *   The values must be close. Both lineups genuinely do improve on a bench
 *   receiver for a first round back — the other side's lineup barely notices
 *   losing him — and no human alive accepts it.
 */
const assert = require('assert');
if (!process.env.DATABASE_URL) require('dotenv').config();

const mm = require('../src/matchmaker');
const db = require('../src/db');

let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

// Two starters and a flex; one team is deep at RB and thin at WR, the other the
// reverse — the textbook fit this is supposed to find.
const SLOTS = ['QB', 'RB', 'WR', 'BN', 'BN'];
const P = (id, name, position, points) => ({ playerId: id, name, position, points });
const proj = new Map([
  P('q1', 'QB One', 'QB', 300), P('q2', 'QB Two', 'QB', 290),
  P('r1', 'RB One', 'RB', 250), P('r2', 'RB Two', 'RB', 240),
  P('r3', 'RB Three', 'RB', 60),
  P('w1', 'WR One', 'WR', 250), P('w2', 'WR Two', 'WR', 240),
  P('w3', 'WR Three', 'WR', 60),
].map(p => [p.playerId, p]));

// A: two good RBs, a scrub WR. B: two good WRs, a scrub RB.
const rosters = [
  { roster_id: 1, players: ['q1', 'r1', 'r2', 'w3'] },
  { roster_id: 2, players: ['q2', 'w1', 'w2', 'r3'] },
];

(async () => {
  console.log('\nthe fit it exists to find');

  await it('surplus at one position meets a hole at the other', async () => {
    const out = mm.findTrades({ rosters, rosterPositions: SLOTS, proj, rosterId: 1 });
    assert.ok(out.best.length, 'a deep-RB team and a deep-WR team must find each other');
    const top = out.best[0];
    assert.strictEqual(top.give.position, 'RB', 'send from the surplus');
    assert.strictEqual(top.get.position, 'WR', 'get for the hole');
    assert.ok(top.myGain > 0 && top.theirGain > 0, 'both sides must gain');
  });

  await it('a swap that helps only the asker is never suggested', async () => {
    /*
     * Ranked on the asker's gain alone, the best suggestion is "send your worst
     * player for their best" — a real result of the search and a proposal
     * nobody has ever accepted.
     */
    const out = mm.findTrades({ rosters, rosterPositions: SLOTS, proj, rosterId: 1 });
    for (const s of out.all) {
      assert.ok(s.theirGain > 0, `suggested a swap the other side loses: ${JSON.stringify(s)}`);
    }
  });

  await it('a wildly unfair swap is filtered even when both lineups improve', async () => {
    const values = new Map([['r1', 9000], ['r2', 9000], ['w1', 200], ['w2', 200],
      ['q1', 500], ['q2', 500], ['r3', 100], ['w3', 100]]);
    const out = mm.findTrades({ rosters, rosterPositions: SLOTS, proj, values, rosterId: 1 });
    for (const s of out.all) {
      assert.ok(s.edge <= 12.01, `suggested a ${s.edge}% value gap, nobody accepts that`);
    }
  });

  await it('ranked by the side with LESS reason to say yes', async () => {
    const out = mm.findTrades({ rosters, rosterPositions: SLOTS, proj, rosterId: 1 });
    const mins = out.all.map(s => Math.min(s.myGain, s.theirGain));
    for (let i = 1; i < mins.length; i++) {
      assert.ok(mins[i] <= mins[i - 1], 'the weaker half of each deal must drive the order');
    }
  });

  await it('one suggestion per partner, not five ways to say the same thing', async () => {
    const out = mm.findTrades({ rosters, rosterPositions: SLOTS, proj, rosterId: 1 });
    const partners = out.best.map(s => s.rosterId);
    assert.strictEqual(new Set(partners).size, partners.length);
  });

  await it('no fit is a real answer, not an empty crash', async () => {
    // Two identical rosters have nothing to offer each other.
    const same = [
      { roster_id: 1, players: ['q1', 'r1', 'w1'] },
      { roster_id: 2, players: ['q2', 'r2', 'w2'] },
    ];
    const out = mm.findTrades({ rosters: same, rosterPositions: SLOTS, proj, rosterId: 1 });
    assert.ok(out, 'it must still return a result');
    assert.strictEqual(out.best.length, 0);
  });

  await it('an unknown or empty roster returns nothing rather than throwing', async () => {
    assert.strictEqual(mm.findTrades({ rosters, rosterPositions: SLOTS, proj, rosterId: 99 }), null);
    assert.strictEqual(mm.findTrades({ rosters: [], rosterPositions: SLOTS, proj, rosterId: 1 }), null);
  });

  console.log('\nagainst the real league');

  await it('every suggestion in a live league passes both tests', async () => {
    const { rows: [lg] } = await db.query(
      `select id, sleeper_league_id from leagues where provider <> 'archive' and active
        order by name limit 1`);
    if (!lg) return console.log('       (skip: no live league)');
    const sleeper = require('../src/sleeper');
    const [settings, live, sp] = await Promise.all([
      sleeper.leagueSettings(lg.sleeper_league_id).catch(() => null),
      sleeper.rosters(lg.sleeper_league_id).catch(() => null),
      sleeper.seasonProjections(new Date().getFullYear()).catch(() => null),
    ]);
    if (!settings || !live || !sp) return console.log('       (skip: Sleeper unreachable)');
    if (!live.some(r => (r.players || []).length)) return console.log('       (skip: undrafted)');

    const target = live.find(r => (r.players || []).length);
    const out = mm.findTrades({
      rosters: live, rosterPositions: settings.roster_positions, proj: sp,
      rosterId: target.roster_id });
    if (!out) return console.log('       (skip: no lineup)');
    for (const s of out.all) {
      assert.ok(s.myGain >= 5 && s.theirGain >= 5, 'both sides clear the threshold');
      assert.notStrictEqual(s.rosterId, Number(target.roster_id), 'never trade with yourself');
      assert.notStrictEqual(s.give.id, s.get.id);
    }
  });

  console.log('\npick inventory, including the picks nobody traded');

  await it('an untraded pick still belongs to the team it was minted for', async () => {
    /*
     * Sleeper reports only the EXCEPTIONS — a pick appears in traded_picks
     * solely because it changed hands. Reading the feed as the inventory would
     * leave every team owning nothing.
     */
    const held = mm.pickInventory({
      rosters: [{ roster_id: 1 }, { roster_id: 2 }],
      tradedPicks: [], seasons: ['2027'], rounds: 2 });
    assert.strictEqual(held.get(1).length, 2, 'two rounds, both still theirs');
    assert.strictEqual(held.get(2).length, 2);
  });

  await it('a traded pick moves, and remembers whose it was', async () => {
    const held = mm.pickInventory({
      rosters: [{ roster_id: 1 }, { roster_id: 2 }],
      tradedPicks: [{ season: '2027', round: 1, roster_id: 1, owner_id: 2 }],
      seasons: ['2027'], rounds: 2 });
    assert.strictEqual(held.get(1).length, 1, 'team 1 gave one away');
    assert.strictEqual(held.get(2).length, 3);
    const acquired = held.get(2).find(p => p.from === 1);
    assert.ok(acquired, 'the acquired pick must remember it came from team 1');
    assert.strictEqual(acquired.round, 1);
  });

  console.log('\nplayers for picks');

  const PICKV = new Map([
    ['2027 Early 1st', 6400], ['2027 Mid 1st', 5500], ['2027 Late 1st', 5000],
    ['2027 Early 2nd', 4200], ['2027 Mid 2nd', 3900], ['2027 Late 2nd', 3600],
  ]);

  await it('the best team buys and the worst sells, and the middle is told to sit', async () => {
    const three = [
      { roster_id: 1, players: ['q1', 'r1', 'w1'] },   // strongest
      { roster_id: 2, players: ['q2', 'r2', 'w2'] },
      { roster_id: 3, players: ['r3', 'w3'] },         // weakest
    ];
    const values = new Map([['q1', 5000], ['q2', 5000], ['r1', 5200], ['r2', 5100],
      ['w1', 5200], ['w2', 5100], ['r3', 900], ['w3', 900]]);
    const inv = mm.pickInventory({ rosters: three, tradedPicks: [], seasons: ['2027'], rounds: 2 });
    const roles = [1, 2, 3].map(rid => mm.findPickTrades({
      rosters: three, rosterPositions: SLOTS, proj, values, pickValues: PICKV,
      inventory: inv, rosterId: rid }).role);
    assert.deepStrictEqual(roles, ['buying', 'middle', 'selling']);
  });

  await it('a contender\'s own first is priced LATE, and a rebuilder\'s EARLY', async () => {
    /*
     * Every future pick used to be priced mid, which made a contender's first
     * cost exactly what a rebuilding team's first costs — in a trade whose
     * entire premise is that one team is good and the other is not. Early is
     * 6,400 against late at 5,000.
     */
    const three = [
      { roster_id: 1, players: ['q1', 'r1', 'w1'] },
      { roster_id: 2, players: ['q2', 'r2', 'w2'] },
      { roster_id: 3, players: ['r3', 'w3'] },
    ];
    const values = new Map([['q1', 5000], ['q2', 5000], ['r1', 5200], ['r2', 5100],
      ['w1', 5200], ['w2', 5100], ['r3', 5000], ['w3', 900]]);
    const inv = mm.pickInventory({ rosters: three, tradedPicks: [], seasons: ['2027'], rounds: 2 });
    const out = mm.findPickTrades({
      rosters: three, rosterPositions: SLOTS, proj, values, pickValues: PICKV,
      inventory: inv, rosterId: 1, minGain: 1 });
    for (const d of out.all || []) {
      for (const pk of d.picks) {
        const expected = pk.from === 1 ? 'Late' : pk.from === 3 ? 'Early' : 'Mid';
        assert.strictEqual(pk.band, expected,
          `a pick from roster ${pk.from} should price ${expected}, got ${pk.band}`);
      }
    }
  });

  await it('without values or pick prices it declines rather than guessing', async () => {
    assert.strictEqual(mm.findPickTrades({ rosters, rosterPositions: SLOTS, proj, rosterId: 1 }), null);
  });

  console.log(`\n${pass} passing`);
  await db.pool.end();
})();
