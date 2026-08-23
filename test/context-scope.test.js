#!/usr/bin/env node
/**
 * One league's past belongs to that league.
 *
 * context.js looked up "last completed season" with a filter on provider =
 * 'archive' and a season, and nothing at all tying the rows to the league doing
 * the asking. With a single league in the database that is invisibly correct,
 * which is why it survived six seasons of use and a full test suite.
 *
 * With two it returns whichever snapshot the planner reaches first. The bot
 * would state a stranger's standings as this league's own last season, to the
 * model, as fact — no error, no log line, and no way to notice except somebody
 * in the chat recognising a name that has never played in their league.
 *
 * Found while building the onboarding pre-flight, whose second stage ingests a
 * second league's history and would have been the thing that triggered it.
 */
require('dotenv').config();
if (!process.env.DATABASE_URL) {
  console.log('context scoping\n  SKIPPED — no DATABASE_URL\n\n0 passing');
  process.exit(0);
}
const assert = require('assert');
const db = require('../src/db');
const history = require('../src/history');
const draftiq = require('../src/draftiq');

let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

// Two leagues that have never heard of each other. Same season, same week, so
// the old query's `order by season desc, week desc limit 1` has a genuine tie
// to resolve and resolves it by luck.
const ALPHA_2026 = 'zz-scope-alpha-2026';
const ALPHA_2025 = 'zz-scope-alpha-2025';
const BETA_2025  = 'zz-scope-beta-2025';

const payload = (teamName, userId) => ({
  league: { season: '2025', status: 'complete', total_rosters: 1 },
  users: [{ user_id: userId, display_name: teamName, metadata: { team_name: teamName } }],
  rosters: [{ roster_id: 1, owner_id: userId, settings: { wins: 10, losses: 4, fpts: 1500 } }],
});

async function seed() {
  await cleanup();
  const mk = async (name, sid, provider, season, chatId) => {
    const { rows } = await db.query(
      `insert into leagues (name, sleeper_league_id, provider, chat_id, active, season)
       values ($1,$2,$3,$4,$5,$6) returning *`,
      [name, sid, provider, chatId, provider !== 'archive', season]);
    return rows[0];
  };
  const live  = await mk('ZZ Scope Alpha', ALPHA_2026, 'sendblue', '2026', 'zz-scope-chat');
  const aOld  = await mk('ZZ Scope Alpha 2025', ALPHA_2025, 'archive', '2025', null);
  const bOld  = await mk('ZZ Scope Beta 2025',  BETA_2025,  'archive', '2025', null);

  for (const [lg, team, uid] of [[aOld, 'Alpha Team', 'u-alpha'], [bOld, 'Beta Team', 'u-beta']]) {
    await db.query(
      `insert into snapshots (league_id, season, week, kind, payload)
       values ($1,'2025',17,'final',$2)`, [lg.id, payload(team, uid)]);
  }
  return live;
}

async function cleanup() {
  await db.query(
    `delete from leagues where sleeper_league_id = any($1::text[])`,
    [[ALPHA_2026, ALPHA_2025, BETA_2025]]);
}

(async () => {
  const live = await seed();

  // chain() and draftiq both hit Sleeper. Stubbed so this test is about the
  // scoping and nothing else; the ids are what the real walk would return.
  const realChain = history.chain;
  const realAnalyze = draftiq.analyze;
  draftiq.analyze = async () => null;

  const { leagueContext } = require('../src/context');

  console.log('a league gets its own last season, not the newest one in the database');

  await it('the last season comes from this chain even when another league ties on season and week', async () => {
    history.chain = async () => [{ league_id: ALPHA_2026 }, { league_id: ALPHA_2025 }];
    const ctx = await leagueContext(live.id);
    assert.ok(ctx.lastSeason, 'expected a last season');
    const teams = ctx.lastSeason.standings.map(s => s.team);
    assert.deepStrictEqual(teams, ['Alpha Team'],
      `got ${JSON.stringify(teams)} — a stranger's standings would read as this league's own`);
  });

  await it("the other league's snapshot is reachable, so the test would fail if scoping were dropped", async () => {
    history.chain = async () => [{ league_id: BETA_2025 }];
    const ctx = await leagueContext(live.id);
    assert.deepStrictEqual(ctx.lastSeason.standings.map(s => s.team), ['Beta Team']);
  });

  await it('no chain means no last season, rather than somebody else\'s', async () => {
    history.chain = async () => { throw new Error('sleeper unreachable'); };
    const ctx = await leagueContext(live.id);
    assert.strictEqual(ctx.lastSeason, undefined,
      'a failed chain walk must not fall back to an unscoped lookup');
  });

  history.chain = realChain;
  draftiq.analyze = realAnalyze;
  await cleanup();
  console.log(`\n${pass} passing`);
})().catch(e => { console.error(e); process.exitCode = 1; })
    .finally(() => db.pool.end());
