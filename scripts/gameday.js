#!/usr/bin/env node
/**
 * Inspect and exercise the game-day path. Sends nothing unless --send.
 *
 * Usage:
 *   node scripts/gameday.js --schedule            pull this week's kickoffs
 *   node scripts/gameday.js --schedule 2025 10    any week, for testing
 *   node scripts/gameday.js --games               what's stored
 *   node scripts/gameday.js --check               dry-run the alert logic
 *   node scripts/gameday.js --check --send        actually post
 */

require('dotenv').config();
const db = require('../src/db');
const espn = require('../src/espn');
const gameday = require('../src/gameday');

const argv = process.argv.slice(2);
const has = n => argv.includes(`--${n}`);
const positional = argv.filter(a => !a.startsWith('--'));

function provider() {
  const { SendblueProvider } = require('../src/sendblue');
  return new SendblueProvider(
    process.env.SENDBLUE_API_KEY_ID,
    process.env.SENDBLUE_API_SECRET_KEY,
    { fromNumber: process.env.SENDBLUE_FROM_NUMBER }
  );
}

const et = d => new Date(d).toLocaleString('en-US', {
  timeZone: process.env.CRON_TZ || 'America/New_York',
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

(async () => {
  if (has('schedule')) {
    const [season, week] = positional;
    if (season && week) {
      const games = await espn.weekGames(season, week);
      const n = await db.upsertGames(games);
      console.log(`stored ${n} games for ${season} week ${week}`);
    } else {
      console.log(JSON.stringify(await gameday.refreshSchedule(), null, 2));
    }
  }

  if (has('games') || has('schedule')) {
    const { rows } = await db.query('select * from games order by kickoff_at');
    console.log(`\n${rows.length} game(s) stored:\n`);
    let day = null;
    for (const g of rows) {
      const d = et(g.kickoff_at).split(',')[0];
      if (d !== day) { day = d; console.log(''); }
      console.log(`  ${et(g.kickoff_at).padEnd(30)} ${String(g.short_name).padEnd(14)} ${g.state}${g.neutral_site ? '   NEUTRAL — ' + g.venue : ''}`);
    }
    return;
  }

  if (has('check')) {
    const detail = await gameday.tick(has('send') ? provider() : null, { dryRun: !has('send') });
    console.log(JSON.stringify(detail, null, 2));
    return;
  }

  console.error(`usage:
  node scripts/gameday.js --schedule [season week]
  node scripts/gameday.js --games
  node scripts/gameday.js --check [--send]`);
  process.exitCode = 1;
})()
  .catch(err => { console.error('ERROR:', err.message); process.exitCode = 1; })
  .finally(() => db.pool.end().catch(() => {}));
