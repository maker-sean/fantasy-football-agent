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
 *   npm run gaps -- --since 2026-08-24   # only since you shipped the last batch
 *   npm run gaps -- --limit 100
 *
 * --since is the one to reach for after a build. A gap is a request, and
 * requests get built: "the closest game in league history" was asked four times
 * by four people in one evening and was answerable by the next morning. Left in
 * a rolling window it reads as demand for something that already exists.
 *
 * Reads decisions and messages, which already hold everything. Nothing new is
 * written, so this works on history as well as on whatever happens next.
 */
require('dotenv').config();
const db = require('../src/db');
const gaps = require('../src/gaps');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i !== -1 ? Number(argv[i + 1]) : d; };
const text = (n) => { const i = argv.indexOf('--' + n); return i !== -1 ? argv[i + 1] : null; };

(async () => {
  const since = text('since');
  const rows = await gaps.withNames(
    await gaps.recent({ days: flag('days', 30), limit: flag('limit', 50), since }));

  const window = since ? `since ${since}` : `in the last ${flag('days', 30)} days`;
  if (!rows.length) {
    console.log(`\n  Nothing asked for and missing ${window}.\n`);
    return;
  }

  console.log(`\n  ${rows.length} time${rows.length === 1 ? '' : 's'} the bot said it did not have something, ${window}\n`);
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
