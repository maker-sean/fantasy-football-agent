#!/usr/bin/env node
/**
 * The trade ledger, announced twice a season.
 *
 * Nothing is stored. A dynasty trade is not over for years, so the ledger is
 * recomputed when it is sent and the same question in March gets a different,
 * equally honest answer — the same reason this project has never written a
 * dynasty verdict.
 *
 * The two properties that matter here are about NOT sending: once per league
 * per phase per season, and never on a message that failed.
 */
const assert = require('assert');
if (!process.env.DATABASE_URL) require('dotenv').config();

const lr = require('../src/ledgerrecap');
const db = require('../src/db');

let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

(async () => {
  console.log('\nwhen it fires, and when it stays quiet');

  await it('the opening week of the regular season, and the end, and nothing else', async () => {
    assert.strictEqual(lr.phaseFor({ season_type: 'regular', week: 1 }), 'start');
    assert.strictEqual(lr.phaseFor({ season_type: 'post', week: 18 }), 'end');
    assert.strictEqual(lr.phaseFor({ season_type: 'regular', week: 9 }), null);
    assert.strictEqual(lr.phaseFor({ season_type: 'pre', week: 3 }), null);
    assert.strictEqual(lr.phaseFor(null), null);
  });

  await it('a week past the final one counts as the end', async () => {
    assert.strictEqual(lr.phaseFor({ season_type: 'regular', week: 18 }, { finalWeek: 17 }), 'end');
  });

  console.log('\nsent once, and only on success');

  const LEAGUE = '00000000-0000-0000-0000-0000000000ff';
  const KEY = lr.flagKey(LEAGUE, '2026', 'start');
  await db.query('delete from system_flags where key = $1', [KEY]);

  await it('an unsent phase reports unsent', async () => {
    assert.strictEqual(await lr.alreadySent(LEAGUE, '2026', 'start'), false);
  });

  await it('marking is idempotent and scoped to one phase and season', async () => {
    await lr.markSent(LEAGUE, '2026', 'start', { at: 'x' });
    await lr.markSent(LEAGUE, '2026', 'start', { at: 'y' });
    assert.strictEqual(await lr.alreadySent(LEAGUE, '2026', 'start'), true);
    assert.strictEqual(await lr.alreadySent(LEAGUE, '2026', 'end'), false, 'the end is separate');
    assert.strictEqual(await lr.alreadySent(LEAGUE, '2027', 'start'), false, 'next season is separate');
  });

  await it('a failed send is NOT marked, so it goes again tomorrow', async () => {
    /*
     * The introduction path already paid for the opposite: stamping before the
     * send marks a league told on a message that never arrived, and it is never
     * told again.
     */
    await db.query('delete from system_flags where key like $1', ['ledger_recap:%']);
    // force, so this covers the failure path in any week rather than skipping
    // for eleven months of the year — which is when it would matter and when
    // nobody would be looking.
    const dead = { send: async () => { throw new Error('provider down'); } };
    const out = await lr.run(dead, { force: 'start' });
    assert.strictEqual(out.phase, 'start');
    assert.strictEqual(out.sent.length, 0, 'a dead provider sends nothing');
    const { rows } = await db.query(`select 1 from system_flags where key like 'ledger_recap:%'`);
    assert.strictEqual(rows.length, 0, 'nothing may be marked when every send failed');

    // And the successful path DOES mark, exactly once.
    const good = { send: async () => ({ ok: true }) };
    const first = await lr.run(good, { force: 'start' });
    const again = await lr.run(good, { force: 'start' });
    assert.ok(first.sent.length >= 1, 'a working provider sends');
    assert.strictEqual(again.sent.length, 0, 'and it does not send twice');
  });

  console.log('\nthe right measure for the league');

  await it('a redraft league is judged on points, a dynasty league on the market', async () => {
    const { rows: leagues } = await db.query(
      `select id, name from leagues where provider <> 'archive' and active`);
    for (const lg of leagues) {
      const msg = await lr.build(lg);
      if (!msg) { console.log(`       (${lg.name}: nothing to report)`); continue; }
      const { leagueContext } = require('../src/context');
      const ctx = await leagueContext(lg.id);
      const wanted = ctx.valueVariant?.dynasty ? 'market' : 'points';
      assert.strictEqual(msg.basis, wanted, `${lg.name} should be judged on ${wanted}`);
      if (wanted === 'points') {
        assert.match(msg.text, /points actually scored/,
          'a settled redraft trade must not be re-estimated from a value sheet');
      }
    }
  });

  await it('the message names the middle rather than implying nobody else traded', async () => {
    const { rows: [lg] } = await db.query(
      `select id, name from leagues where provider <> 'archive' and active limit 1`);
    if (!lg) return console.log('       (skip: no live league)');
    const msg = await lr.build(lg, { top: 1 });
    if (!msg) return console.log('       (skip: nothing to report)');
    assert.match(msg.text, /others in the middle, ask me/);
  });

  await db.query('delete from system_flags where key like $1', ['ledger_recap:%']);
  console.log(`\n${pass} passing`);
  await db.pool.end();
})();
