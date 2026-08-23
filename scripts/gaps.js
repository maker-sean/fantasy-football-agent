#!/usr/bin/env node
/**
 * What the league asked for and did not get.
 *
 * A feature list written by the people using it. "I don't have game-by-game
 * scores" was said four separate times in one evening before anybody built game
 * logs, and the only record of it was scrollback.
 *
 *   npm run gaps                 # the last 30 days
 *   npm run gaps -- --days 7
 *   npm run gaps -- --limit 100
 *
 * Reads decisions and messages, which already hold everything. Nothing new is
 * written, so this works on history as well as on whatever happens next.
 */
require('dotenv').config();
const db = require('../src/db');
const gaps = require('../src/gaps');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i !== -1 ? Number(argv[i + 1]) : d; };

(async () => {
  const rows = await gaps.withNames(
    await gaps.recent({ days: flag('days', 30), limit: flag('limit', 50) }));

  if (!rows.length) {
    console.log('\n  Nothing asked for and missing in that window.\n');
    return;
  }

  console.log(`\n  ${rows.length} time${rows.length === 1 ? '' : 's'} the bot said it did not have something\n`);
  for (const r of rows) {
    const when = new Date(r.created_at).toLocaleString();
    console.log(`  ${when}  ${r.asker}`);
    if (r.question) console.log(`    asked : ${String(r.question).replace(/\s+/g, ' ').slice(0, 100)}`);
    console.log(`    said  : ${String(r.answer).replace(/\s+/g, ' ').slice(0, 100)}`);
    console.log('');
  }
  console.log('  Each one is somebody telling you what to build next.\n');
})().catch(e => { console.error('\n  ' + e.message + '\n'); process.exitCode = 1; })
    .finally(() => db.pool.end());
