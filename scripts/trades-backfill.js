#!/usr/bin/env node
/**
 * Pull a league's entire trade history, every season it has ever played.
 *
 *   npm run trades-backfill -- --league <sleeper_league_id>
 *   npm run trades-backfill -- --all        # every live league we serve
 *   npm run trades-backfill -- --status
 *
 * Safe to re-run: syncLeague is idempotent on (league_id, transaction_id), and
 * everything is adopted rather than announced, so this never sends a message
 * however many times it runs.
 */
require('dotenv').config();
const db = require('../src/db');
const trades = require('../src/trades');

const argv = process.argv.slice(2);
const has = n => argv.includes('--' + n);
const flag = n => { const i = argv.indexOf('--' + n); return i !== -1 ? argv[i + 1] : null; };

(async () => {
  if (has('status')) {
    const { rows } = await db.query(
      `select l.name, count(*)::int trades, min(t.season) first, max(t.season) last
         from trades t join leagues l on l.id = t.league_id
        group by 1 order by 2 desc`);
    if (!rows.length) console.log('\n  No trades on file.\n');
    else console.table(rows);
    return;
  }

  const targets = has('all')
    ? (await db.query(
        "select name, sleeper_league_id from leagues where provider <> 'archive' and sleeper_league_id is not null"
      )).rows
    : [{ name: flag('league'), sleeper_league_id: flag('league') }];

  if (!targets.length || !targets[0].sleeper_league_id) {
    console.error('usage: npm run trades-backfill -- --league <id>  |  --all  |  --status');
    process.exitCode = 1;
    return;
  }

  for (const t of targets) {
    console.log(`\n  ${t.name}`);
    const out = await trades.backfill(t.sleeper_league_id, {
      onSeason: (season, n) => console.log(`    ${season}  ${n} on file`),
    });
    console.log(`    ${out.trades} trades across ${out.seasons} seasons`);
  }
  console.log('\n  Adopted, not announced — nothing was sent.\n');
})().catch(e => { console.error(e.message); process.exitCode = 1; })
    .finally(() => db.pool.end());
