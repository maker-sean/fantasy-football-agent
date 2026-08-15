#!/usr/bin/env node
/**
 * Show a league's actual lineup rules, and check we understand all of them.
 *
 * Rules are read per-league from that league's own `roster_positions` — nothing
 * is hardcoded to a format. Run this before trusting any optimal-lineup number
 * for a league you haven't seen before: an unrecognized slot silently produces
 * a wrong "points left on the table" figure rather than an error.
 *
 * Usage:
 *   node scripts/league-rules.js                       # every league in the DB
 *   node scripts/league-rules.js --sleeper <id>        # any league, live from Sleeper
 */

require('dotenv').config();
const { describeRules } = require('../src/lineup');

const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf(`--${n}`); return i !== -1 ? argv[i + 1] : null; };

function report(label, rosterPositions) {
  const r = describeRules(rosterPositions);
  console.log(`\n${label}`);
  console.log(`  ${r.summary}`);
  console.log(`  ${r.starterCount} starters, ${r.benchCount} bench`);
  console.log(`  QB-capable slots: ${r.qbSlots}${r.superflex ? '  (SUPERFLEX / 2QB league)' : ''}`);
  for (const f of r.flexTypes) {
    console.log(`  ${f.slot} accepts: ${f.accepts.join(', ')} only`);
  }
  if (r.unknown.length) {
    console.log(`  !! UNRECOGNIZED SLOTS: ${r.unknown.join(', ')}`);
    console.log('     Optimal-lineup figures for this league are WRONG. Add these to');
    console.log('     SLOT_ELIGIBILITY in src/lineup.js before generating recaps.');
    return false;
  }
  return true;
}

(async () => {
  const sleeperId = flag('sleeper');

  if (sleeperId) {
    const sleeper = require('../src/sleeper');
    const lg = await sleeper.league(sleeperId);
    const ok = report(`${lg.name} (${lg.season}, ${lg.total_rosters} teams)`, lg.roster_positions);
    if (!ok) process.exitCode = 1;
    return;
  }

  const db = require('../src/db');
  try {
    const { rows } = await db.query(`
      select distinct on (l.id) l.name, l.provider, l.sleeper_league_id,
             s.payload->'league'->'roster_positions' as rp,
             s.payload->'league'->>'season' as season
      from leagues l join snapshots s on s.league_id = l.id
      order by l.id, s.captured_at desc`);

    if (!rows.length) {
      console.log('No leagues with snapshots yet.');
      console.log('Capture one:  node scripts/backfill.js --league <sleeper_id> --weeks 1-17');
      return;
    }

    let allOk = true;
    for (const r of rows) {
      const ok = report(`${r.name}  [${r.provider}, season ${r.season}]`, r.rp || []);
      allOk = allOk && ok;
    }
    console.log(allOk ? '\nAll lineup slots recognized.' : '\nSome slots are unrecognized — see above.');
    if (!allOk) process.exitCode = 1;
  } finally {
    await db.pool.end().catch(() => {});
  }
})().catch(err => { console.error('ERROR:', err.message); process.exitCode = 1; });
