#!/usr/bin/env node
/**
 * The gate between a league and its first impression.
 *
 * A setup link goes to somebody who will hand this bot to eleven friends, and
 * on 2026-08-23 the bot answered six seasons of history with "No league data
 * has been captured yet" — a live league row with no snapshot of its own,
 * returning above the code that reads the archive. Nothing errored.
 *
 * So invites.send() now refuses until a pre-flight has passed. These pin the
 * three things that gate has to get right: that it blocks, that a first-season
 * league is a judgement rather than a failure, and above all that running it
 * cannot damage the league it is checking.
 */
require('dotenv').config();
if (!process.env.DATABASE_URL) {
  console.log('preflight\n  SKIPPED — no DATABASE_URL\n\n0 passing');
  process.exit(0);
}
const assert = require('assert');
const db = require('../src/db');
const preflight = require('../src/preflight');
const invites = require('../src/invites');

let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

const PHONE = '+15558870000';
const SLEEPER = 'zz-preflight-league';
const provider = { send: async () => {} };

async function freshSignup() {
  await db.query('delete from signups where phone = $1', [PHONE]);
  const { rows } = await db.query(
    `insert into signups (phone, sleeper_league_id, league_name, total_rosters, source, status)
     values ($1,$2,'ZZ Preflight',12,'web','new') returning *`, [PHONE, SLEEPER]);
  return rows[0];
}

const stamp = (signupId, status, extra = {}) => db.query(
  `insert into preflight_runs (signup_id, status, seasons_found, seasons_captured,
                               context_chars, started_at, finished_at)
   values ($1, $2, 6, $3, 4200, $4, $5)`,
  [signupId, status, extra.captured ?? 6,
   extra.startedAt || new Date(), extra.finishedAt === null ? null : new Date()]);

(async () => {
  process.env.PUBLIC_BASE_URL = 'https://example.invalid';

  console.log('the gate');

  await it('a signup that has never been checked cannot be invited', async () => {
    const s = await freshSignup();
    const out = await invites.send(s.id, { provider });
    assert.strictEqual(out.sent, false);
    assert.strictEqual(out.error, 'preflight_no_run');
    assert.strictEqual(out.overridable, false);
  });

  await it('a passed check lets it through', async () => {
    const s = await freshSignup();
    await stamp(s.id, 'passed');
    const out = await invites.send(s.id, { provider });
    assert.strictEqual(out.sent, true, out.error);
  });

  await it('a failed check blocks, and is NOT something to wave through', async () => {
    const s = await freshSignup();
    await stamp(s.id, 'failed');
    const out = await invites.send(s.id, { provider });
    assert.strictEqual(out.error, 'preflight_failed');
    assert.strictEqual(out.overridable, false);
  });

  await it('a first-season league blocks but says it can be overridden', async () => {
    // Nothing is broken. There is simply nothing historical to say, and whether
    // that is worth inviting is a product call, not a data one.
    const s = await freshSignup();
    await stamp(s.id, 'thin', { captured: 0 });
    const out = await invites.send(s.id, { provider });
    assert.strictEqual(out.error, 'preflight_thin');
    assert.strictEqual(out.overridable, true);
  });

  await it('force sends it anyway', async () => {
    const s = await freshSignup();
    await stamp(s.id, 'thin', { captured: 0 });
    const out = await invites.send(s.id, { provider, force: true });
    assert.strictEqual(out.sent, true, out.error);
  });

  await it('a check still running blocks without claiming it failed', async () => {
    const s = await freshSignup();
    await stamp(s.id, 'running', { finishedAt: null });
    const out = await invites.send(s.id, { provider });
    assert.strictEqual(out.error, 'preflight_running');
  });

  await it('a run killed mid-flight goes stale instead of blocking forever', async () => {
    // A deploy during a run leaves the row `running` with nobody working on it.
    // Without staleness the button spins until somebody reads the table.
    const s = await freshSignup();
    await stamp(s.id, 'running', {
      finishedAt: null,
      startedAt: new Date(Date.now() - preflight.STALE_MS - 60_000),
    });
    const out = await invites.send(s.id, { provider });
    assert.strictEqual(out.error, 'preflight_stale');
  });

  await it('the newest run is the one that counts', async () => {
    const s = await freshSignup();
    await stamp(s.id, 'failed', { startedAt: new Date(Date.now() - 60_000) });
    await stamp(s.id, 'passed');
    const out = await invites.send(s.id, { provider });
    assert.strictEqual(out.sent, true, out.error);
  });

  console.log('\nchecking a league must not damage it');

  await it('the provisional row is provider=archive, so onboarding still sees the league as unclaimed', async () => {
    /*
     * The whole feature is safe or unsafe on this line. web/server.js refuses
     * to onboard a league that liveLeagueBySleeperId already finds, with "is
     * already set up on Commish AI" and no way round it — so a pre-flight that
     * left a live row would lock the real commissioner out of the product by
     * checking whether the product would work for them.
     */
    await db.query('delete from leagues where sleeper_league_id = $1', [SLEEPER]);
    const { league } = await preflight.contextLeague(
      { league_id: SLEEPER, name: 'ZZ Preflight', season: '2026' });
    assert.strictEqual(league.provider, 'archive');
    assert.strictEqual(league.chat_id, null);
    assert.strictEqual(await db.liveLeagueBySleeperId(SLEEPER), null,
      'a pre-flight made the league look already-onboarded');
    await db.query('delete from leagues where sleeper_league_id = $1', [SLEEPER]);
  });

  await it('a second run reuses the provisional row rather than piling them up', async () => {
    await db.query('delete from leagues where sleeper_league_id = $1', [SLEEPER]);
    const args = { league_id: SLEEPER, name: 'ZZ Preflight', season: '2026' };
    const a = await preflight.contextLeague(args);
    const b = await preflight.contextLeague(args);
    assert.strictEqual(a.league.id, b.league.id);
    await db.query('delete from leagues where sleeper_league_id = $1', [SLEEPER]);
  });

  await it('an already-onboarded league is checked against its real row, not a copy', async () => {
    await db.query('delete from leagues where sleeper_league_id = $1', [SLEEPER]);
    const { rows: [live] } = await db.query(
      `insert into leagues (name, sleeper_league_id, provider, chat_id, active, season)
       values ('ZZ Preflight Live', $1, 'sendblue', 'zz-preflight-chat', true, '2026')
       returning *`, [SLEEPER]);
    const { league, provisional } = await preflight.contextLeague(
      { league_id: SLEEPER, name: 'ZZ Preflight', season: '2026' });
    assert.strictEqual(league.id, live.id);
    assert.strictEqual(provisional, false);
    await db.query('delete from leagues where sleeper_league_id = $1', [SLEEPER]);
  });

  await db.query('delete from signups where phone = $1', [PHONE]);
  console.log(`\n${pass} passing`);
})().catch(e => { console.error(e); process.exitCode = 1; })
    .finally(() => db.pool.end());
