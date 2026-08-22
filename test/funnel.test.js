#!/usr/bin/env node
/**
 * The signup funnel.
 *
 * Analytics is the one place a bug never announces itself. A wrong join does
 * not throw, it just returns a number, and a number on a dashboard is believed.
 * This file exists because the first version of textFlow() split on
 * signups.source — which records the TRANSPORT, not whether somebody came
 * through the website — and confidently reported a code-driven signup as a cold
 * text. It looked completely plausible.
 */
require('dotenv').config();
if (!process.env.DATABASE_URL) {
  console.log('funnel\n  SKIPPED — no DATABASE_URL\n\n0 passing');
  process.exit(0);
}

const assert = require('assert');
const db = require('../src/db');
const observe = require('../src/observe');

let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

const P1 = '+15558800001';   // came through the website with a code
const P2 = '+15558800002';   // texted the number cold

(async () => {
  // A tiny known world, torn down at the end. Counts are compared as DELTAS
  // against whatever was already in the database, so this passes on an empty
  // dev database and on a production copy with real signups in it.
  const before = {
    funnel: Object.fromEntries((await observe.funnel()).map(s => [s.key, s.count])),
    text: await observe.textFlow(),
    tiles: await observe.signupTiles([1, 12, 24]),
  };

  await db.query(
    `insert into signup_codes (code, sleeper_league_id, league_name, used_at, used_by_phone)
     values ('TST1','1','Funnel Test', now(), $1)`, [P1]);
  await db.query(
    `insert into signup_codes (code, sleeper_league_id, league_name) values ('TST2','1','Never Texted')`);
  await db.query(
    `insert into signups (phone, sleeper_league_id, league_name, source, raw_text)
     values ($1,'1','Funnel Test','sms','COMMISH TST1'), ($2,'1','Funnel Test','sms','COMMISH')`,
    [P1, P2]);

  try {
    console.log('which door they came through');

    await it('a website code counts as a code, not a cold text', async () => {
      // Both rows are source='sms' — the person texted either way. What
      // separates them is whether a code the SITE issued was redeemed.
      const t = await observe.textFlow();
      assert.strictEqual(t.viaCode - before.text.viaCode, 1, 'one arrived via a code');
      assert.strictEqual(t.cold - before.text.cold, 1, 'and one arrived cold');
    });

    await it('a code issued and never texted is counted as a drop, not a signup', async () => {
      const t = await observe.textFlow();
      assert.strictEqual(t.codesUnused - before.text.codesUnused, 1);
    });

    console.log('\nthe funnel');

    await it('both signups land on the waitlist', async () => {
      const f = Object.fromEntries((await observe.funnel()).map(s => [s.key, s.count]));
      assert.strictEqual(f.on_waitlist - before.funnel.on_waitlist, 2);
    });

    await it('only the redeemed one counts as having opened the link', async () => {
      await db.query('update signups set invited_at = now() where phone in ($1,$2)', [P1, P2]);
      await db.query('update signups set redeemed_at = now(), redeem_count = 1 where phone = $1', [P1]);
      const f = Object.fromEntries((await observe.funnel()).map(s => [s.key, s.count]));
      assert.strictEqual(f.invited - before.funnel.invited, 2);
      assert.strictEqual(f.opened_link - before.funnel.opened_link, 1,
        'invited but never opened is the drop this column exists to expose');
    });

    await it('drop-off is measured against the previous stage, not the top', async () => {
      const stages = await observe.funnel();
      const idx = stages.findIndex(s => s.key === 'opened_link');
      const prev = stages[idx - 1], here = stages[idx];
      assert.strictEqual(here.dropped, Math.max(0, prev.count - here.count));
      // Against the top, every late stage reads as a catastrophe and no single
      // step stands out — the opposite of what a drop-off view is for.
      assert.strictEqual(here.rate, Math.round((here.count / prev.count) * 100));
    });

    await it('a stage with nothing above it reports no rate rather than dividing by zero', async () => {
      const stages = await observe.funnel();
      assert.strictEqual(stages[0].rate, null);
      for (const s of stages) {
        assert.ok(s.rate === null || Number.isFinite(s.rate), `${s.key} rate is ${s.rate}`);
      }
    });

    console.log('\ntiles and traffic');

    await it('a new signup lands in every window at once', async () => {
      const t = await observe.signupTiles([1, 12, 24]);
      const get = (arr, h) => arr.find(x => x.hours === h).count;
      for (const h of [1, 12, 24]) {
        assert.strictEqual(get(t, h) - get(before.tiles, h), 2, `${h}h window`);
      }
    });

    await it('the tiles are read at one instant, so windows cannot disagree', async () => {
      const t = await observe.signupTiles([1, 12, 24]);
      const get = h => t.find(x => x.hours === h).count;
      assert.ok(get(1) <= get(12) && get(12) <= get(24), 'windows nest');
    });

    await it('quiet hours come back as zero, not as missing rows', async () => {
      // A chart built only from hours that had traffic silently rescales its
      // own axis and makes a dead night look busy.
      const v = await observe.visitsByHour(24);
      assert.strictEqual(v.length, 25, 'inclusive of both ends');
      assert.ok(v.every(x => typeof x.views === 'number'), 'every hour has a number');
      const hours = v.map(x => new Date(x.hour).getTime());
      assert.deepStrictEqual(hours, [...hours].sort((a, b) => a - b), 'in order');
    });

    await it('page views record a path and a time, and nothing else', async () => {
      // The privacy claim is only true while this stays true.
      const { rows } = await db.query(
        `select column_name from information_schema.columns where table_name = 'page_views'`);
      assert.deepStrictEqual(rows.map(r => r.column_name).sort(), ['at', 'id', 'path'],
        'no ip, cookie, user agent or session id may appear here');
    });

  } catch (e) {
    console.error('ERR', e.message);
    process.exitCode = 1;
  } finally {
    await db.query('delete from signups where phone in ($1,$2)', [P1, P2]);
    await db.query(`delete from signup_codes where code in ('TST1','TST2')`);
    console.log(`\n${pass} passing`);
    await db.pool.end();
  }
})();
