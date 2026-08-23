#!/usr/bin/env node
/**
 * Points left on the bench.
 *
 * The claim this feature makes is accusatory and specific: you started X over
 * Y and it cost you N. Getting it wrong means telling somebody they blew a
 * playoff game on a swap that was never legal, in front of eleven people who
 * were there. So the only thing worth testing hard is ELIGIBILITY.
 *
 * The naive version, best bench score against worst starter, produces "you
 * should have started your backup QB at running back". These pin the cases that
 * separate the two.
 *
 * The slot mapping rests on Sleeper ordering `starters` to match
 * roster_positions. That is an assumption about somebody else's API, so it was
 * checked against the archive rather than asserted: 9,305 strict slots, one
 * mismatch, Taysom Hill listed TE while startable at QB in 2020.
 */
require('dotenv').config();
if (!process.env.DATABASE_URL) {
  console.log('bench\n  SKIPPED — no DATABASE_URL\n\n0 passing');
  process.exit(0);
}
const assert = require('assert');
const db = require('../src/db');
const history = require('../src/history');

let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

(async () => {
  console.log('eligibility is the whole job');

  const { rows: [live] } = await db.query(
    "select sleeper_league_id from leagues where chat_id is not null limit 1");

  if (!live) {
    console.log('  SKIPPED — no chat-linked league in this database');
    console.log('\n0 passing');
    return db.pool.end();
  }

  const worst = await history.benchMistakes(live.sleeper_league_id, { limit: 25 });

  await it('every reported swap names a real slot', async () => {
    assert.ok(worst.length, 'no bench mistakes found at all, which cannot be right');
    for (const m of worst) {
      assert.ok(/^(QB|RB|WR|TE|K|DEF|FLEX|SUPER_FLEX|REC_FLEX)$/.test(m.slot),
        `unknown slot ${m.slot}`);
    }
  });

  await it('the benched player always outscored the starter', async () => {
    for (const m of worst) {
      assert.ok(m.benchedPoints > m.startedPoints,
        `${m.benched} ${m.benchedPoints} did not beat ${m.started} ${m.startedPoints}`);
      assert.strictEqual(
        Math.round((m.benchedPoints - m.startedPoints) * 100) / 100, m.cost,
        'the cost does not equal the difference it claims to be');
    }
  });

  await it('a flex swap is only claimed when the slot really is a flex', async () => {
    const FLEX = { FLEX: ['RB', 'WR', 'TE'], SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'], REC_FLEX: ['WR', 'TE'] };
    const { rows: players } = await db.query(
      'select player_id, full_name, position from players where position is not null');
    const posOf = new Map(players.map(p => [p.full_name, p.position]));

    for (const m of worst) {
      const benchedPos = posOf.get(m.benched);
      if (!benchedPos) continue;                       // retired or renamed, skip
      const allowed = FLEX[m.slot] || [m.slot];
      assert.ok(allowed.includes(benchedPos),
        `claimed ${m.benched} (${benchedPos}) could fill a ${m.slot} slot in ${m.season}`);
    }
  });

  await it('a cross position swap is never claimed on a strict slot', async () => {
    // The failure the naive version produces: a QB "should have started" at RB.
    for (const m of worst) {
      if (['FLEX', 'SUPER_FLEX', 'REC_FLEX'].includes(m.slot)) continue;
      const { rows: [p] } = await db.query(
        'select position from players where full_name = $1 limit 1', [m.benched]);
      if (!p) continue;
      assert.strictEqual(p.position, m.slot,
        `${m.benched} is a ${p.position} and was claimed for a ${m.slot} slot`);
    }
  });

  await it('results are ordered worst first, which the prompt depends on', async () => {
    for (let i = 1; i < worst.length; i++) {
      assert.ok(worst[i - 1].cost >= worst[i].cost, 'not sorted by cost');
    }
  });

  console.log('\nthe block');

  await it('an empty result produces no block rather than an empty header', async () => {
    assert.strictEqual(history.benchBlock([]), '');
    assert.strictEqual(history.benchBlock(null), '');
  });

  await it('the block says eligibility was checked, so the model can assert it', async () => {
    const b = history.benchBlock(worst.slice(0, 2), new Map());
    assert.match(b, /legally|eligib/i);
  });

  console.log(`\n${pass} passing`);
  await db.pool.end();
})();
