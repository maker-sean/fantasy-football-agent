#!/usr/bin/env node
/**
 * Pull community trade values into player_values.
 *
 *   npm run values                    # dry run, last 30 days
 *   npm run values -- --save          # write them
 *   npm run values -- --since 2020-04-01 --save   # the whole series
 *   npm run values -- --status        # what we already hold
 *
 * Dry run is the default, like every other script here that writes something.
 *
 * ON THE FULL BACKFILL. The series runs to 2020-04-01 and is roughly 700
 * values a day across both settings, so the lot is well over a million rows.
 * That is fine for Postgres and is NOT free on a hosted plan, so it is opt-in
 * rather than what happens when somebody runs this to see what it does.
 */
require('dotenv').config();
const db = require('../src/db');
const pv = require('../src/playervalues');

const argv = process.argv.slice(2);
const has = n => argv.includes('--' + n);
const flag = n => { const i = argv.indexOf('--' + n); return i !== -1 ? argv[i + 1] : null; };

(async () => {
  if (has('status')) {
    const { rows } = await db.query(
      `select source, count(*)::int rows, count(distinct captured_on)::int days,
              min(captured_on) first, max(captured_on) last,
              count(*) filter (where sleeper_id is null and position <> 'PICK')::int unmatched
         from player_values group by source`);
    if (!rows.length) console.log('\n  Nothing stored yet.\n');
    else console.table(rows);
    return;
  }

  const since = flag('since')
    || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const dryRun = !has('save');

  console.log(`\n  source ${flag('source') || 'ktc'}, since ${since}${dryRun ? '  (DRY RUN)' : ''}`);
  const s = await pv.ingest({ source: flag('source') || 'ktc', since, dryRun });

  console.log(`  series     ${s.series}`);
  console.log(`  records    ${s.rows}`);
  console.log(`  matched    ${s.matched}`);
  console.log(`  picks      ${s.picks}`);
  console.log(`  unmatched  ${s.unmatched.length}${s.unmatched.length ? '  ' + s.unmatched.slice(0, 8).join(', ') : ''}`);
  console.log(dryRun ? '\n  NOTHING WAS WRITTEN. Add --save.\n' : `  written    ${s.written}\n`);
})().catch(e => { console.error(e.message); process.exitCode = 1; })
    .finally(() => db.pool.end());
