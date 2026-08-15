#!/usr/bin/env node
/**
 * Fire a snapshot by hand, and inspect what has been captured.
 *
 * Use --force during preseason to prove the pipeline works before the first
 * kickoff. A capture job you have never actually run is not a capture job.
 *
 * Usage:
 *   node scripts/snapshot.js lock_sun_early --force
 *   node scripts/snapshot.js --list
 *   node scripts/snapshot.js --jobs
 *   node scripts/snapshot.js --players
 */

require('dotenv').config();
const db = require('../src/db');
const sleeper = require('../src/sleeper');
const snapshots = require('../src/snapshots');

const argv = process.argv.slice(2);
const has = f => argv.includes(`--${f}`);
const kind = argv.find(a => !a.startsWith('--'));

(async () => {
  if (has('players')) {
    await snapshots.refreshPlayers();
    return;
  }

  if (has('jobs')) {
    const jobs = await db.recentJobs(20);
    if (!jobs.length) return console.log('No job runs recorded yet.');
    for (const j of jobs) {
      const when = j.started_at.toISOString().replace('T', ' ').slice(0, 19);
      console.log(`${when}  ${j.status.toUpperCase().padEnd(8)} ${j.job}`);
      if (j.detail?.skipped) console.log(`    skipped: ${j.detail.skipped}`);
      if (j.detail?.error) console.log(`    error: ${j.detail.error}`);
      for (const l of j.detail?.leagues || []) {
        console.log(`    ${l.league} week ${l.week}: ${l.result}${l.error ? ' — ' + l.error : ''}`);
      }
    }
    return;
  }

  if (has('list')) {
    const state = await sleeper.state();
    const leagues = await db.activeLeagues();
    if (!leagues.length) return console.log('No active leagues. Run scripts/register-league.js first.');

    for (const lg of leagues) {
      const rows = await db.listSnapshots(lg.id, state.season);
      console.log(`\n${lg.name}  (season ${state.season})`);
      if (!rows.length) {
        console.log('  NO SNAPSHOTS YET.');
        continue;
      }
      const byWeek = new Map();
      for (const r of rows) {
        if (!byWeek.has(r.week)) byWeek.set(r.week, []);
        byWeek.get(r.week).push(`${r.kind}(${Math.round(r.payload_bytes / 1024)}kb)`);
      }
      for (const [week, kinds] of [...byWeek].sort((a, b) => a[0] - b[0])) {
        console.log(`  week ${String(week).padStart(2)}: ${kinds.join(', ')}`);
      }
    }
    return;
  }

  if (!kind) {
    console.error(`usage:
  node scripts/snapshot.js <kind> [--force]   capture now
  node scripts/snapshot.js --list             what has been captured
  node scripts/snapshot.js --jobs             recent job runs
  node scripts/snapshot.js --players          refresh the player table

kinds: lock_thu lock_sun_early lock_sun_late lock_sun_night lock_mon postscore`);
    process.exitCode = 1;
    return;
  }

  const state = await sleeper.state();
  console.log(`nfl state: season ${state.season} ${state.season_type} week ${state.week}`);
  if (!snapshots.isRegularSeason(state) && !has('force')) {
    console.log('Preseason — this would SKIP. Add --force to capture anyway.');
  }

  const detail = await snapshots.captureAll(kind, { force: has('force') });
  console.log('\n' + JSON.stringify(detail, null, 2));
})()
  .catch(err => { console.error('ERROR:', err.message); process.exitCode = 1; })
  .finally(() => db.pool.end().catch(() => {}));
