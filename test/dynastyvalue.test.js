#!/usr/bin/env node
/**
 * Pricing a dynasty trade, and the two things the price cannot see.
 *
 * Dynasty market values already carry age, team control and breakout odds, so
 * this looks them up rather than modelling them. The judgement it adds is about
 * what the market cannot know:
 *
 *   1. WHAT COULD NOT BE PRICED. The source carries 2026 picks and no 2027, so
 *      a trade containing a 2027 second has one side that cannot be totalled.
 *      A margin computed anyway would silently value that pick at zero and
 *      declare the other side the winner, which is the false absence this
 *      repo keeps paying for. No margin is the correct output.
 *
 *   2. WHERE THE PLAYER LANDED. A second round pick spent on a backup running
 *      back is an overpay by value and a handcuff by roster, and the roster is
 *      the half that explains it. Every fact was already in this database —
 *      both men on LV, both RB, one of them Questionable — and nothing joined
 *      them until now.
 */
const assert = require('assert');
if (!process.env.DATABASE_URL) require('dotenv').config();

const dv = require('../src/dynastyvalue');
const db = require('../src/db');

let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

(async () => {
  console.log('\nwhere a pick lands');

  await it('a round splits into thirds', async () => {
    assert.strictEqual(dv.bucketFor(1, 12), 'Early');
    assert.strictEqual(dv.bucketFor(4, 12), 'Early');
    assert.strictEqual(dv.bucketFor(5, 12), 'Mid');
    assert.strictEqual(dv.bucketFor(8, 12), 'Mid');
    assert.strictEqual(dv.bucketFor(9, 12), 'Late');
    assert.strictEqual(dv.bucketFor(12, 12), 'Late');
  });

  await it('a label matches how the value sheet names picks', async () => {
    assert.strictEqual(dv.pickLabel({ season: '2026', round: 2, slot: 3, teams: 12 }), '2026 Early 2nd');
    assert.strictEqual(dv.pickLabel({ season: '2026', round: 1, slot: 11, teams: 12 }), '2026 Late 1st');
  });

  await it('an unknown slot yields no label rather than a guessed one', async () => {
    assert.strictEqual(dv.pickLabel({ season: '2027', round: 2, slot: null, teams: 12 }), null);
  });

  await it('the real draft order wins over reverse standings', async () => {
    /*
     * This league's own order is not reverse standings: a team that finished
     * 7th picks 3rd. Deriving the slot from the table would have priced the
     * pick a full bucket wrong while looking perfectly reasonable.
     */
    // slot_to_roster_id is keyed BY SLOT: slot 3 holds roster 3, slot 8 holds
    // roster 4. Inverting it is the whole job, and inverting it wrongly prices
    // every pick in the trade against somebody else's draft position.
    const fromDraft = dv.slotsFromDraft({ 1: 6, 3: 3, 8: 4 });
    assert.strictEqual(fromDraft.get(3), 3, 'roster 3 drafts from slot 3');
    assert.strictEqual(fromDraft.get(4), 8, 'roster 4 drafts from slot 8');
    assert.strictEqual(fromDraft.get(6), 1);
    const fromFinish = dv.slotsFromFinish([[4, 3], [3, 7]], 12);
    assert.strictEqual(fromFinish.get(4), 10, 'finished 3rd of 12 drafts 10th');
    assert.strictEqual(fromFinish.get(3), 6);
  });

  console.log('\nwhat the roster shows that the price cannot');

  await it('a same-team same-position backup is flagged, with the starter injury', async () => {
    const { rows } = await db.query(
      `select player_id from players where team = 'LV' and position = 'RB' limit 2`);
    if (rows.length < 2) return console.log('       (skip: no LV backfield in players)');
    const flags = await dv.rosterFlags([rows[0].player_id], [rows[1].player_id]);
    assert.strictEqual(flags.length, 1);
    assert.strictEqual(flags[0].team, 'LV');
    assert.ok('starterInjury' in flags[0], 'the starter injury must be reported, even when null');
  });

  await it('different teams are not a handcuff', async () => {
    const { rows } = await db.query(
      `select player_id, team from players
        where position = 'RB' and team is not null order by team limit 40`);
    const a = rows[0];
    const b = rows.find(r => r.team !== a.team);
    if (!b) return console.log('       (skip: could not find two teams)');
    assert.deepStrictEqual(await dv.rosterFlags([a.player_id], [b.player_id]), []);
  });

  await it('a player is never his own handcuff', async () => {
    const { rows: [p] } = await db.query(
      `select player_id from players where position = 'RB' and team is not null limit 1`);
    assert.deepStrictEqual(await dv.rosterFlags([p.player_id], [p.player_id]), []);
  });

  await it('an empty roster or no arrivals flags nothing', async () => {
    assert.deepStrictEqual(await dv.rosterFlags([], ['1']), []);
    assert.deepStrictEqual(await dv.rosterFlags(['1'], []), []);
  });

  console.log('\npricing a trade, and refusing to when it cannot be done');

  await it('an unpriced season is carried from the nearest one, and SAID', async () => {
    /*
     * The source carries 2026 picks and no 2027. Left alone, a trade of "your
     * 2026 2nd for my 2026 2nd plus my 2027 2nd" priced the 2027 at nothing and
     * could give no margin at all.
     *
     * Carrying the price across years is a deliberate call and a slightly
     * generous one — real dynasty markets discount a future pick against the
     * same pick this year — so the assumption has to travel WITH the margin.
     * A carried price reported as a measurement is the failure here.
     */
    const trade = {
      received: {},
      roster_ids: [3, 4],
      draft_picks: [
        { round: 2, season: '2026', owner_id: 4, roster_id: 3 },
        { round: 2, season: '2026', owner_id: 3, roster_id: 4 },
        { round: 2, season: '2027', owner_id: 3, roster_id: 4 },
      ],
    };
    const slots = new Map([[3, 3], [4, 8]]);
    const p = await dv.priceTrade(trade, { superflex: false, teams: 12, slots, slotSeason: '2026' });
    if (!p) return console.log('       (skip: no player_values loaded)');
    const payer = p.sides.find(s => s.rosterId === 3);
    const future = payer.picks.find(k => k.season === '2027');
    assert.ok(future.value > 0, 'the 2027 pick must be priced, not left at nothing');
    assert.match(future.assumedFrom || '', /^2026 /, 'and it must name the year it borrowed from');
    assert.ok(p.margin > 0, 'a margin is owed once every asset carries a price');
    assert.ok(p.assumptions.some(a => a.label === '2027 Mid 2nd'),
      'the assumption must be reported alongside the margin, never folded into it');
  });

  await it('a pick nothing can price at all still leaves the margin NULL', async () => {
    // A shape with no priced equivalent in any season has nothing to borrow.
    const p = await dv.priceTrade({
      received: {}, roster_ids: [3, 4],
      draft_picks: [
        { round: 2, season: '2026', owner_id: 4, roster_id: 3 },
        { round: 9, season: '2031', owner_id: 3, roster_id: 4 },
      ],
    }, { superflex: false, teams: 12, slots: new Map([[3, 3], [4, 8]]) });
    if (!p) return console.log('       (skip: no player_values loaded)');
    assert.strictEqual(p.margin, null, 'an asset with no comparable must block the margin');
  });

  await it('both 2026 picks price, and the earlier one is worth more', async () => {
    const trade = {
      received: {}, roster_ids: [3, 4],
      draft_picks: [
        { round: 2, season: '2026', owner_id: 4, roster_id: 3 },
        { round: 2, season: '2026', owner_id: 3, roster_id: 4 },
      ],
    };
    // slotSeason is REQUIRED for the real slots to apply — without it every pick
    // falls back to mid-round, which is the correct behaviour and makes this
    // test meaningless rather than failing loudly. Named here so it stays true.
    const p = await dv.priceTrade(trade, {
      superflex: false, teams: 12, slots: new Map([[3, 3], [4, 8]]), slotSeason: '2026' });
    if (!p) return console.log('       (skip: no player_values loaded)');
    assert.strictEqual(p.margin !== null, true, 'both sides priceable means a margin is owed');
    const early = p.sides.find(s => s.picks.some(k => /Early/.test(k.label || '')));
    const mid = p.sides.find(s => s.picks.some(k => /Mid/.test(k.label || '')));
    assert.ok(early.value > mid.value, 'an early second must outvalue a mid second');
  });

  console.log('\npriced at the date of the trade, not today');

  await it('an older capture is used when asOf is in the past', async () => {
    const trade = {
      received: {}, roster_ids: [3, 4],
      draft_picks: [
        { round: 2, season: '2026', owner_id: 4, roster_id: 3 },
        { round: 2, season: '2026', owner_id: 3, roster_id: 4 },
      ],
    };
    const slots = new Map([[3, 3], [4, 8]]);
    const now = await dv.priceTrade(trade, { superflex: false, teams: 12, slots, slotSeason: '2026' });
    const then = await dv.priceTrade(trade, { superflex: false, teams: 12, slots, slotSeason: '2026',
      asOf: '2025-09-01' });
    if (!now || !then) return console.log('       (skip: no player_values loaded)');
    assert.ok(then.capturedOn < now.capturedOn, 'a past asOf must reach a past capture');
    assert.ok(String(then.capturedOn).startsWith('2025') || then.capturedOn < new Date('2025-09-02'),
      `expected a 2025 capture, got ${then.capturedOn}`);
  });

  await it('a slot map is only trusted for its own season', async () => {
    /*
     * The map we can fetch is this year's. Using it for a 2028 pick would price
     * that pick against a draft position with nothing to do with it — so other
     * seasons fall back to mid-round, and say so.
     */
    const p = await dv.priceTrade({
      received: {}, roster_ids: [3, 4],
      draft_picks: [
        { round: 2, season: '2026', owner_id: 4, roster_id: 3 },
        { round: 2, season: '2028', owner_id: 3, roster_id: 3 },
      ],
    }, { superflex: false, teams: 12, slots: new Map([[3, 3]]), slotSeason: '2026' });
    if (!p) return console.log('       (skip: no player_values loaded)');
    const own = p.sides.flatMap(s => s.picks).find(k => k.season === '2026');
    const other = p.sides.flatMap(s => s.picks).find(k => k.season === '2028');
    assert.strictEqual(own.slotUnknown, false, 'its own season uses the real slot');
    assert.strictEqual(own.label, '2026 Early 2nd');
    assert.strictEqual(other.slotUnknown, true, 'another season must not borrow this slot');
    assert.match(other.label, /Mid/);
  });

  console.log(`\n${pass} passing`);
  await db.pool.end();
})();
