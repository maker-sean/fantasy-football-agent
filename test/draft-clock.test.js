#!/usr/bin/env node
/**
 * Who is on the clock, when picks have changed hands.
 *
 * slot_to_roster_id names whoever OWNED the slot when the order was drawn. In a
 * dynasty league picks are currency — the draft this was built against had
 * fourteen traded, including the one on the clock — so the original owner is
 * frequently the wrong person to name to a chat looking at the board.
 */
const assert = require('assert');
const path = require('path');
const sleeper = require(path.join(process.env.HOME, 'fantasy-agent/src/sleeper'));

let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

/*
 * Stubbed at the TRANSPORT, not at sleeper.get.
 *
 * draftClock calls the module's internal get(), so replacing the exported one
 * leaves real network calls going out — which is how the first version of this
 * file "passed" three tests against Sleeper itself and failed the rest on
 * requests for a draft id that does not exist.
 */
const withApi = (routes) => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    for (const [frag, val] of Object.entries(routes)) {
      if (u.includes(frag)) {
        return { ok: true, status: 200, json: async () => val, text: async () => JSON.stringify(val) };
      }
    }
    return { ok: true, status: 200, json: async () => null, text: async () => 'null' };
  };
  return () => { globalThis.fetch = real; };
};

const schedule = (over = {}) => ({
  draftId: 'd1', status: 'drafting', type: 'linear', season: '2026',
  teams: 12, rounds: 4, lastPickedAt: Date.now() - 3600 * 1000,
  slotToRoster: { 1: 6, 2: 7, 3: 3, 4: 2, 5: 8, 6: 11, 7: 10, 8: 4, 9: 9, 10: 12, 11: 5, 12: 1 },
  ...over,
});
const picks = n => Array.from({ length: n }, () => ({ metadata: {} }));

(async () => {
  console.log('who is on the clock');

  await it('an untraded pick names the roster that owns the slot', async () => {
    const off = withApi({ '/traded_picks': [], '/picks': picks(19) });
    const c = await sleeper.draftClock(schedule());
    off();
    assert.strictEqual(c.rosterId, 4);        // slot 8
    assert.strictEqual(c.wasTraded, false);
  });

  await it('a traded pick names the CURRENT owner, not the original', async () => {
    // The real case: 2026 round 2, Sean M.'s pick (roster 4) now Renshaw's (12).
    const off = withApi({
      '/traded_picks': [{ season: '2026', round: 2, roster_id: 4, previous_owner_id: 4, owner_id: 12 }],
      '/picks': picks(19),
    });
    const c = await sleeper.draftClock(schedule());
    off();
    assert.strictEqual(c.rosterId, 12, 'named the original owner of a traded pick');
    assert.strictEqual(c.originalRosterId, 4);
    assert.strictEqual(c.wasTraded, true);
  });

  await it('a trade in a DIFFERENT round does not move this pick', async () => {
    const off = withApi({
      '/traded_picks': [{ season: '2026', round: 4, roster_id: 4, owner_id: 12 }],
      '/picks': picks(19),
    });
    const c = await sleeper.draftClock(schedule());
    off();
    assert.strictEqual(c.rosterId, 4);
    assert.strictEqual(c.wasTraded, false);
  });

  console.log('\nsnake and linear pick different people');

  await it('linear repeats the same order every round', async () => {
    const off = withApi({ '/traded_picks': [], '/picks': picks(12) });
    const c = await sleeper.draftClock(schedule());   // pick 13 = round 2, slot 1
    off();
    assert.strictEqual(c.round, 2);
    assert.strictEqual(c.slot, 1);
  });

  await it('snake reverses on even rounds', async () => {
    const off = withApi({ '/traded_picks': [], '/picks': picks(12) });
    const c = await sleeper.draftClock(schedule({ type: 'snake' }));
    off();
    assert.strictEqual(c.round, 2);
    assert.strictEqual(c.slot, 12, 'snake round 2 starts at the far end');
  });

  console.log('\nstates that are not a clock');

  await it('auction has no clock of this shape and says so', async () => {
    assert.strictEqual(await sleeper.draftClock(schedule({ type: 'auction' })), null);
  });

  await it('a draft that has not started has no clock', async () => {
    assert.strictEqual(await sleeper.draftClock(schedule({ status: 'pre_draft' })), null);
  });

  await it('every pick in is reported as done rather than a 49th pick', async () => {
    const off = withApi({ '/traded_picks': [], '/picks': picks(48) });
    const c = await sleeper.draftClock(schedule());
    off();
    assert.strictEqual(c.done, true);
  });

  console.log(`\n${pass} passing`);
})();
