/**
 * Phase 1 worker — separate process from the web receiver.
 *
 * Its only job right now is capturing the thing that cannot be backfilled.
 * No agent, no LLM, no content generation. Those have no deadline; the first
 * kickoff of the season does.
 *
 * Run:  npm run worker
 *
 * Lock snapshots fire just BEFORE each slate starts, because the point is to
 * record the lineup as submitted — a capture taken after kickoff has already
 * lost the bench decisions that make the recap worth reading.
 */

require('dotenv').config();

const cron = require('node-cron');
const db = require('./src/db');
const snapshots = require('./src/snapshots');

const TZ = process.env.CRON_TZ || 'America/New_York';

// NFL slates in ET. Each fires a few minutes ahead of the real kickoff.
const JOBS = [
  ['lock_thu',       '15 20 * * 4', () => snapshots.captureAll('lock_thu')],
  ['lock_sun_early', '55 12 * * 0', () => snapshots.captureAll('lock_sun_early')],
  ['lock_sun_late',  '55 15 * * 0', () => snapshots.captureAll('lock_sun_late')],
  ['lock_sun_night', '10 20 * * 0', () => snapshots.captureAll('lock_sun_night')],
  ['lock_mon',       '10 20 * * 1', () => snapshots.captureAll('lock_mon')],
  // Final scores, after Monday night has settled.
  ['postscore',      '0 6 * * 2',   () => snapshots.captureAll('postscore')],
  // Housekeeping.
  ['players',        '0 4 * * *',   () => snapshots.refreshPlayers()],
  ['members',        '30 4 * * *',  () => snapshots.syncMembers()],
];

async function preflight() {
  const { rows } = await db.query('select now() as now');
  console.log(`[worker] db ok — ${rows[0].now.toISOString()}`);

  const leagues = await db.activeLeagues();
  if (!leagues.length) {
    console.warn('[worker] WARNING: no active leagues with a sleeper_league_id.');
    console.warn('[worker] Snapshots will skip every run. Register one:');
    console.warn('[worker]   node scripts/register-league.js --help');
  } else {
    for (const l of leagues) {
      console.log(`[worker] league: ${l.name} (sleeper ${l.sleeper_league_id}, chat ${l.chat_id || 'unlinked'})`);
    }
  }

  const sleeper = require('./src/sleeper');
  const state = await sleeper.state();
  console.log(`[worker] nfl state: season ${state.season} ${state.season_type} week ${state.week}`);
  if (!snapshots.isRegularSeason(state)) {
    console.log('[worker] preseason — scheduled captures will SKIP until season_type=regular.');
    console.log('[worker] force one now with: npm run snapshot -- lock_sun_early --force');
  }
}

(async () => {
  console.log(`[worker] starting, tz=${TZ}`);
  try {
    await preflight();
  } catch (err) {
    console.error('[worker] preflight failed:', err.message);
    process.exit(1);
  }

  for (const [name, expr, fn] of JOBS) {
    if (!cron.validate(expr)) {
      console.error(`[worker] invalid cron for ${name}: ${expr}`);
      process.exit(1);
    }
    cron.schedule(expr, () => {
      console.log(`[worker] firing ${name}`);
      fn().catch(err => console.error(`[worker] ${name} threw:`, err.message));
    }, { timezone: TZ });
    console.log(`[worker] scheduled ${name.padEnd(15)} ${expr}  (${TZ})`);
  }

  console.log('[worker] running. ctrl-c to stop.');
})();

const shutdown = async () => {
  console.log('\n[worker] shutting down');
  await db.pool.end().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
