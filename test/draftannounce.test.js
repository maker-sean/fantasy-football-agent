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

  await it('the windows cannot overlap, so nothing has to be chosen between', async () => {
    // They used to: t24 was due from 24 hours out until the draft started, so
    // inside the last hour both fired and run() picked. That overlap is what
    // let a day-before notice arrive on the day, and it is gone.
    assert.deepStrictEqual(da.due(sched(), START - 0.5 * H), ['t1']);
    assert.deepStrictEqual(da.due(sched(), START - 22 * H), ['t24']);
    assert.deepStrictEqual(da.due(sched(), START - 10 * H), [], 'the gap between them is silent');
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

  /*
   * SCOPED TO THIS FIXTURE LEAGUE, NOT TO EVERY LEAGUE.
   *
   * This was `like 'draft_announce:%'`, which deletes the announcement flags of
   * every real league in the database — and these tests run against the same
   * database the product does. On 2026-08-30 that wiped a live league's t24
   * flag hours after its day-before notice had gone out, so the next cron tick
   * found nothing marked, saw t24 still inside its 24-hour window, and sent the
   * identical message a second time, five hours before that league's draft.
   *
   * The duplicate was not a bug in the announcer. It was the test suite
   * reaching outside its own fixtures.
   */
  const L = '00000000-0000-0000-0000-0000000000aa';
  const scrubFlags = () =>
    db.query(`delete from system_flags where key like $1`, [`draft_announce:${L}:%`]);
  await scrubFlags();

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
    // Date, never "tomorrow" — a relative word is a claim about when the
    // message is READ, and nothing here controls that.
    assert.match(t24, /Draft day:/);
    assert.doesNotMatch(t24, /tomorrow/i);
    assert.match(t24, /15 rounds/);
    assert.match(t1, /starting soon/);
    assert.doesNotMatch(t1, /tomorrow/i);
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

  console.log('\neach notice fires in its own window, or not at all');

  it('a worker asleep through the day-before window never sends it late', async () => {
    /*
     * The 2026-08-30 incident. A league got "Draft is tomorrow: Sunday, August
     * 30" twice — correctly at 8:21pm Saturday, and again at 2:40pm Sunday,
     * five hours before its own draft.
     *
     * Two things stop that now. The copy is anchored to the date, so it cannot
     * be wrong whenever it lands. And t24 lives in a four hour window rather
     * than being due at any point in the day before, so a notice that missed
     * its slot is never due again instead of arriving whenever the worker
     * next looked.
     */
    const start = Date.parse('2026-08-31T00:00:00Z');       // 8pm ET Sunday
    const sched = { draftId: 'd1', startsAt: start, status: 'pre_draft', rounds: 14 };
    const H = 3600000;

    assert.deepStrictEqual(da.due(sched, start - 23.6 * H), ['t24'], 'Sat evening: the real one');
    assert.deepStrictEqual(da.due(sched, start - 5.3 * H), [], 'Sun afternoon: the wrong one');
    assert.deepStrictEqual(da.due(sched, start - 0.5 * H), ['t1'], 'an hour out is still an hour out');
  });

  await it('a failed send is not marked, so it goes again next pass', async () => {
    /*
     * RUNS AGAINST A REAL LEAGUE, AND MUST LEAVE IT EXACTLY AS IT FOUND IT.
     *
     * This is the test that caused a live league to be texted twice. It used to
     * delete every draft_announce flag in the database before and after itself
     * — and it runs against the same database the product does — so a real
     * league's day-before notice was un-marked hours after it had gone out, and
     * the next cron tick sent it again.
     *
     * The cleanup is scoped to this file's own fixture now. This case still
     * needs a real league with a real upcoming draft, so it picks one that the
     * announcer has never touched, and refuses any league already carrying a
     * flag — those carry production state, sometimes deliberately, like a
     * countdown an operator suppressed by hand.
     */
    const sleeper = require('../src/sleeper');
    const { rows: leagues } = await db.query(
      `select id, name, sleeper_league_id from leagues where provider <> 'archive' and active`);

    let target = null;
    for (const lg of leagues) {
      const { rows: flags } = await db.query(
        `select 1 from system_flags where key like $1`, [`draft_announce:${lg.id}:%`]);
      if (flags.length) continue;                 // never borrow a league mid-announcement
      const sch = await sleeper.draftSchedule(lg.sleeper_league_id).catch(() => null);
      if (sch?.draftId && sch.startsAt && String(sch.status).toLowerCase() === 'pre_draft') {
        target = { lg, sch }; break;
      }
    }
    if (!target) return console.log('       (skip: no untouched league with an upcoming draft)');

    // The provider throws, so nothing can reach anybody's chat whatever run()
    // decides. That is the only reason this is safe to point at real rows.
    const dead = { send: async () => { throw new Error('provider down'); } };
    const out = await da.run(dead, { now: Number(target.sch.startsAt) - 0.5 * 3600 * 1000 });

    assert.deepStrictEqual(out.sent.filter(x => x.league === target.lg.name), []);
    assert.strictEqual(await da.alreadySent(target.lg.id, target.sch.draftId, 't1'), false,
      'a send that failed must not be recorded as delivered');

    // Anything run() wrote for the borrowed league, and nothing else.
    await db.query(`delete from system_flags where key like $1`, [`draft_announce:${target.lg.id}:%`]);
  });

  await scrubFlags();
  console.log(`\n${pass} passing`);
  await db.pool.end();
})();
