#!/usr/bin/env node
/**
 * Capture historical weeks from a completed season.
 *
 * The normal snapshot path is deliberately locked to the CURRENT week from
 * /state/nfl, because its job is capturing lineups at kickoff before they are
 * lost. Backfill is the opposite case: a finished season where Sleeper still
 * serves every week, so we can pull real data to build and test content
 * generation against before the new season starts.
 *
 * Usage:
 *   node scripts/backfill.js --league <sleeper_league_id> --season 2025 --weeks 1-17
 *   node scripts/backfill.js --league 1400000000000000002 --season 2025 --weeks 10
 */

require('dotenv').config();
const db = require('../src/db');
const sleeper = require('../src/sleeper');

const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf(`--${n}`); return i !== -1 ? argv[i + 1] : null; };

const sleeperLeagueId = flag('league');
const season = flag('season');
const weeksArg = flag('weeks') || '1-17';
const name = flag('name');

if (!sleeperLeagueId) {
  console.error('usage: node scripts/backfill.js --league <sleeper_league_id> [--season 2025] [--weeks 1-17]');
  console.error('\nFind a past-season league id from the current one:');
  console.error('  node -e "require(\'./src/sleeper\').league(\'<current_id>\').then(l=>console.log(l.previous_league_id))"');
  process.exit(1);
}

function parseWeeks(s) {
  const out = new Set();
  for (const part of String(s).split(',')) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`bad week spec: ${part}`);
    const lo = Number(m[1]);
    const hi = Number(m[2] || m[1]);
    for (let w = lo; w <= hi; w++) out.add(w);
  }
  return [...out].sort((a, b) => a - b);
}

(async () => {
  const lg = await sleeper.league(sleeperLeagueId);
  console.log(`${lg.name} — season ${lg.season}, ${lg.total_rosters} teams, status=${lg.status}`);

  if (lg.status !== 'complete' && !flag('force')) {
    console.warn(`\nWARNING: status is "${lg.status}", not "complete". Data may be partial.`);
  }

  // Register under a distinct name so it never collides with the live league —
  // no chat_id, so it can never be a target for outbound messages.
  const leagueName = name || `${lg.name} ${lg.season}`;
  const { rows: existing } = await db.query(
    'select * from leagues where sleeper_league_id = $1 and chat_id is null limit 1',
    [sleeperLeagueId]
  );

  let league = existing[0];
  if (!league) {
    const { rows } = await db.query(
      `insert into leagues (name, sleeper_league_id, provider, chat_id, active)
       values ($1, $2, 'archive', null, false) returning *`,
      [leagueName, sleeperLeagueId]
    );
    league = rows[0];
    console.log(`registered archive league: ${league.name} (${league.id})`);
  } else {
    console.log(`using existing archive league: ${league.name} (${league.id})`);
  }

  const weeks = parseWeeks(weeksArg);
  const useSeason = season || lg.season;
  console.log(`\ncapturing ${weeks.length} week(s) of ${useSeason}...\n`);

  let captured = 0, skipped = 0, empty = 0;

  for (const week of weeks) {
    try {
      const payload = await sleeper.weekSnapshot(sleeperLeagueId, week);
      const scored = (payload.matchups || []).filter(m => Number(m.points) > 0).length;

      if (!scored) {
        console.log(`  week ${String(week).padStart(2)}: no scored matchups — skipping`);
        empty += 1;
        continue;
      }

      const row = await db.recordSnapshot({
        leagueId: league.id,
        season: useSeason,
        week,
        kind: 'final',
        payload,
      });

      if (row) { captured += 1; console.log(`  week ${String(week).padStart(2)}: captured (${scored} teams scored)`); }
      else { skipped += 1; console.log(`  week ${String(week).padStart(2)}: already captured — preserved`); }
    } catch (err) {
      console.error(`  week ${String(week).padStart(2)}: FAILED — ${err.message}`);
    }
  }

  console.log(`\n${captured} captured, ${skipped} already existed, ${empty} unplayed.`);
  console.log(`league_id: ${league.id}`);
  console.log('\nNext:  node scripts/recap.js --league ' + league.id + ' --week ' + weeks[0]);
})()
  .catch(err => { console.error('ERROR:', err.message); process.exitCode = 1; })
  .finally(() => db.pool.end().catch(() => {}));
