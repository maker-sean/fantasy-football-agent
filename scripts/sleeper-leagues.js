#!/usr/bin/env node
/**
 * Find your Sleeper league id without hunting through the app.
 *
 * Sleeper's read API is public and needs no key, so a username is enough to
 * list every league you're in, with ids ready to paste into register-league.
 *
 * Usage:
 *   node scripts/sleeper-leagues.js <sleeper_username>
 *   node scripts/sleeper-leagues.js <sleeper_username> 2025    # past season
 */

const sleeper = require('../src/sleeper');

const [username, seasonArg] = process.argv.slice(2);

if (!username) {
  console.error('usage: node scripts/sleeper-leagues.js <sleeper_username> [season]');
  console.error('\nYour username is in the Sleeper app under the account/profile tab.');
  process.exit(1);
}

(async () => {
  let user;
  try {
    user = await sleeper.get(`/user/${encodeURIComponent(username)}`);
  } catch (err) {
    if (err.status === 404) {
      console.error(`No Sleeper user "${username}".`);
      console.error('Use the USERNAME (handle), not your display name or email.');
      process.exit(1);
    }
    throw err;
  }

  if (!user || !user.user_id) {
    console.error(`No user_id returned for "${username}".`);
    process.exit(1);
  }

  console.log(`user: ${user.display_name || user.username}  (user_id ${user.user_id})`);

  const state = await sleeper.state();
  const season = seasonArg || state.season;

  const leagues = await sleeper.get(`/user/${user.user_id}/leagues/nfl/${season}`);

  if (!leagues || !leagues.length) {
    console.log(`\nNo NFL leagues for ${season}.`);
    if (!seasonArg) {
      console.log(`Try last season:  node scripts/sleeper-leagues.js ${username} ${Number(season) - 1}`);
    }
    return;
  }

  console.log(`\n${leagues.length} league(s) in ${season}:\n`);
  for (const l of leagues) {
    console.log(`  ${l.name}`);
    console.log(`    league_id  ${l.league_id}`);
    console.log(`    teams      ${l.total_rosters}   status: ${l.status}   scoring: ${l.scoring_settings?.rec ? 'PPR-ish' : 'standard-ish'}`);
    console.log('');
  }

  const pick = leagues[0];
  console.log('Register the one you want:');
  console.log(`  node scripts/register-league.js --name ${JSON.stringify(pick.name)} \\`);
  console.log(`    --chat sb_group_00000000-0000-0000-0000-000000000000 \\`);
  console.log(`    --from +15555550100 --sleeper ${pick.league_id}`);
})().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
