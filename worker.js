/**
 * Phase 1 worker — all background work, separate from the web receiver.
 *
 * Two jobs:
 *   1. Snapshot capture. The only artifact that cannot be backfilled, with a
 *      hard deadline of the season's first kickoff.
 *   2. Inbound polling. Sendblue does not fire webhooks for GROUP messages
 *      (measured 2026-08-15), and the product lives in a group, so polling is
 *      the inbound transport — not a fallback.
 *
 * Run:  npm run worker
 *
 * Lock snapshots fire just BEFORE each slate starts: a capture taken after
 * kickoff has already lost the bench decisions that make the recap worth
 * reading.
 */

require('dotenv').config();

const cron = require('node-cron');
const db = require('./src/db');
const snapshots = require('./src/snapshots');
const poller = require('./src/poller');
const inbound = require('./src/inbound');
const { SendblueProvider } = require('./src/sendblue');

const TZ = process.env.CRON_TZ || 'America/New_York';
const POLL_MS = Number(process.env.POLL_INTERVAL_SECONDS || 10) * 1000;
const POLL_ENABLED = process.env.POLL_ENABLED !== 'false';
// Off by default: the worker runs unattended, and a bot that starts replying in
// a real group without someone watching is how you annoy a league into muting it.
const ECHO = process.env.ECHO === 'true';

const sendblue = (process.env.SENDBLUE_API_KEY_ID && process.env.SENDBLUE_API_SECRET_KEY)
  ? new SendblueProvider(
      process.env.SENDBLUE_API_KEY_ID,
      process.env.SENDBLUE_API_SECRET_KEY,
      { fromNumber: process.env.SENDBLUE_FROM_NUMBER }
    )
  : null;

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

let stopPolling = null;

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

  if (POLL_ENABLED && sendblue) {
    console.log(`[worker] polling sendblue every ${POLL_MS / 1000}s  echo=${ECHO ? 'ON' : 'off'}`);
    stopPolling = poller.startPolling(sendblue, async msg => {
      const result = await inbound.handleInbound(msg, sendblue, {
        providerName: 'sendblue',
        echo: ECHO,
        source: 'worker-poll',
      });
      console.log('[in] ' + inbound.describe(msg, result));
    }, { intervalMs: POLL_MS, bootstrap: true });
  } else if (!sendblue) {
    console.warn('[worker] sendblue not configured — inbound polling disabled');
  } else {
    console.log('[worker] polling disabled (POLL_ENABLED=false)');
  }

  console.log('[worker] running. ctrl-c to stop.');
})();

const shutdown = async () => {
  if (stopPolling) stopPolling();
  console.log('\n[worker] shutting down');
  await db.pool.end().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
