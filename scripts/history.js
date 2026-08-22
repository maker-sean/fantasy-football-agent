#!/usr/bin/env node
/**
 * Pull every completed season this league has ever played.
 *
 *   npm run history -- --league 1400000000000000001
 *   npm run history -- --league 1400000000000000001 --show
 *
 * Walks previous_league_id back to the beginning and captures each completed
 * season's final week. --show skips the capture and just prints what the bot
 * would be told.
 */
require('dotenv').config();
const db = require('../src/db');
const history = require('../src/history');

const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf('--' + n); return i !== -1 ? argv[i + 1] : null; };
const has = n => argv.includes('--' + n);

(async () => {
  const id = flag('league');
  if (!id) {
    console.error('usage: npm run history -- --league <sleeper_league_id> [--show]');
    process.exit(1);
  }

  if (!has('show')) {
    const seasons = await history.chain(id);
    console.log(`\n${seasons.length} season${seasons.length === 1 ? '' : 's'} in the chain:\n`);
    for (const lg of seasons) {
      if (lg.status !== 'complete') {
        console.log(`  ${lg.season}  skipped — status ${lg.status}`);
        continue;
      }
      try {
        await history.captureSeason(lg);
        console.log(`  ${lg.season}  captured`);
      } catch (err) {
        // One bad season must not lose the other five.
        console.log(`  ${lg.season}  FAILED — ${err.message}`);
      }
    }
  }

  const rows = await history.career(id);
  console.log('');
  console.log(history.careerBlock(rows) || '  (no archived seasons yet)');
  console.log('');
})().catch(e => { console.error(e.message); process.exitCode = 1; })
    .finally(() => db.pool.end());
