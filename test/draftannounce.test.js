#!/usr/bin/env node
/**
 * Telling a league its draft is coming, and how it went.
 *
 * The properties worth guarding are all about NOT sending: never twice, never
 * the day-out reminder an hour before, never a countdown for a draft with no
 * date, and never a recap built from rosters Sleeper has not written yet.
 *
 * A draft is the one event of the year where twelve people are all watching at
 * once, which is exactly why the bot saying the wrong thing is worse here than
 * anywhere else.
 */
const assert = require('assert');
if (!process.env.DATABASE_URL) require('dotenv').config();

const da = require('../src/draftannounce');
const db = require('../src/db');

let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

const H = 3600 * 1000;
const START = 1000 * H;
const sched = (over = {}) => ({
  draftId: 'd1', status: 'pre_draft', startsAt: START,
  rounds: 15, orderSet: true, pickSeconds: 120, ...over,
});

(async () => {
  console.log('\nwhat is due, and when');

  await it('nothing before the day-out mark', async () => {
    assert.deepStrictEqual(da.due(sched(), START - 26 * H), []);
  });

  await it('the day-out reminder once inside 24 hours', async () => {
    assert.deepStrictEqual(da.due(sched(), START - 23 * H), ['t24']);
  });

  await it('both are due inside the last hour, so the caller must choose', async () => {
    assert.deepStrictEqual(da.due(sched(), START - 0.5 * H), ['t24', 't1']);
  });

  await it('nothing once it has started — a countdown to the past is worse than silence', async () => {
    assert.deepStrictEqual(da.due(sched(), START + H), []);
    assert.deepStrictEqual(da.due(sched({ status: 'drafting' }), START + H), []);
  });

  await it('the recap only once it is complete', async () => {
    assert.deepStrictEqual(da.due(sched({ status: 'complete' }), START + 5 * H), ['recap']);
  });

  await it('a draft with no date gets no countdown, rather than a guessed one', async () => {
    assert.deepStrictEqual(da.due(sched({ startsAt: null })), []);
    assert.deepStrictEqual(da.due(null), []);
    assert.deepStrictEqual(da.due({ status: 'pre_draft', startsAt: START }), [],
      'no draft id, nothing to key a flag on');
  });

  console.log('\nsent once per draft, per phase');

  const L = '00000000-0000-0000-0000-0000000000aa';
  await db.query(`delete from system_flags where key like 'draft_announce:%'`);

  await it('marking is scoped to the draft and the phase', async () => {
    await da.markSent(L, 'd1', 't24', {});
    assert.strictEqual(await da.alreadySent(L, 'd1', 't24'), true);
    assert.strictEqual(await da.alreadySent(L, 'd1', 't1'), false, 'the hour warning is separate');
    assert.strictEqual(await da.alreadySent(L, 'd2', 't24'), false, 'next year is a new draft');
  });

  console.log('\nthe messages');

  await it('the countdowns say when, in the league\'s own clock', async () => {
    const t24 = da.countdownText('t24', sched());
    const t1 = da.countdownText('t1', sched());
    assert.match(t24, /Draft is tomorrow/);
    assert.match(t24, /15 rounds/);
    assert.match(t1, /starts in an hour/);
    assert.match(t1, /2 minutes a pick/);
    // A real time, not an epoch or an ISO string nobody reads aloud.
    assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(t24), `raw timestamp leaked: ${t24}`);
  });

  await it('an unset draft order is called out, because it stops the draft', async () => {
    assert.match(da.countdownText('t24', sched({ orderSet: false })), /order still is not set/);
    assert.ok(!/order still is not set/.test(da.countdownText('t24', sched())));
  });

  await it('a recap needs rosters Sleeper has actually written', async () => {
    /*
     * Sleeper does not put picks onto rosters until a draft closes. Grading
     * twelve empty rosters would produce twelve identical zeroes and read as a
     * verdict rather than as "not yet".
     */
    const fake = { id: L, name: 'Nope', sleeper_league_id: 'does-not-exist' };
    assert.strictEqual(await da.recapText(fake), null);
  });

  await it('a real league recaps with grades and names the middle', async () => {
    const { rows: [lg] } = await db.query(
      `select id, name, sleeper_league_id from leagues where provider <> 'archive' and active
        order by name limit 1`);
    if (!lg) return console.log('       (skip: no live league)');
    const text = await da.recapText(lg);
    if (!text) return console.log('       (skip: that league has not drafted)');
    assert.match(text, /Draft is done/);
    assert.match(text, /Best of it:/);
    assert.match(text, /Rough day:/);
  });

  console.log('\nthe hour warning supersedes the day-out one');

  await it('a worker that was asleep does not announce tomorrow an hour before', async () => {
    /*
     * Both countdowns are due inside the last hour. Sending the day-out
     * reminder then is worse than useless, so it is marked WITHOUT being sent —
     * which also stops it firing tomorrow, after the draft has happened.
     *
     * Driven through run() against a real league and a real schedule rather
     * than a stub, because the last two times a double sat beside the code path
     * instead of on it, the tests passed against nothing.
     */
    const sleeper = require('../src/sleeper');
    const { rows: leagues } = await db.query(
      `select id, name, sleeper_league_id from leagues where provider <> 'archive' and active`);

    let target = null;
    for (const lg of leagues) {
      const sch = await sleeper.draftSchedule(lg.sleeper_league_id).catch(() => null);
      if (sch?.draftId && sch.startsAt && String(sch.status).toLowerCase() === 'pre_draft') {
        target = { lg, sch }; break;
      }
    }
    if (!target) return console.log('       (skip: no league with an upcoming dated draft)');

    await db.query(`delete from system_flags where key like 'draft_announce:%'`);
    const sent = [];
    const provider = { send: async (chat, text) => { sent.push(text); return { ok: true }; } };

    // Half an hour out: due() reports both.
    const out = await da.run(provider, { now: Number(target.sch.startsAt) - 0.5 * 3600 * 1000 });
    const mine = out.sent.filter(x => x.league === target.lg.name);
    assert.deepStrictEqual(mine.map(x => x.phase), ['t1'],
      'only the hour warning may go out that close');
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0], /starts in an hour/);
    assert.strictEqual(await da.alreadySent(target.lg.id, target.sch.draftId, 't24'), true,
      'the superseded reminder must be marked so it never fires later');

    // And a second pass sends nothing at all.
    const again = await da.run(provider, { now: Number(target.sch.startsAt) - 0.5 * 3600 * 1000 });
    assert.deepStrictEqual(again.sent.filter(x => x.league === target.lg.name), []);
    assert.strictEqual(sent.length, 1, 'no league may be told twice');
    await db.query(`delete from system_flags where key like 'draft_announce:%'`);
  });

  await it('a failed send is not marked, so it goes again next pass', async () => {
    const sleeper = require('../src/sleeper');
    const { rows: leagues } = await db.query(
      `select id, name, sleeper_league_id from leagues where provider <> 'archive' and active`);
    let target = null;
    for (const lg of leagues) {
      const sch = await sleeper.draftSchedule(lg.sleeper_league_id).catch(() => null);
      if (sch?.draftId && sch.startsAt && String(sch.status).toLowerCase() === 'pre_draft') {
        target = { lg, sch }; break;
      }
    }
    if (!target) return console.log('       (skip: no league with an upcoming dated draft)');

    await db.query(`delete from system_flags where key like 'draft_announce:%'`);
    const dead = { send: async () => { throw new Error('provider down'); } };
    const out = await da.run(dead, { now: Number(target.sch.startsAt) - 0.5 * 3600 * 1000 });
    assert.deepStrictEqual(out.sent.filter(x => x.league === target.lg.name), []);
    assert.strictEqual(await da.alreadySent(target.lg.id, target.sch.draftId, 't1'), false,
      'a send that failed must not be recorded as delivered');
    await db.query(`delete from system_flags where key like 'draft_announce:%'`);
  });

  await db.query(`delete from system_flags where key like 'draft_announce:%'`);
  console.log(`\n${pass} passing`);
  await db.pool.end();
})();
