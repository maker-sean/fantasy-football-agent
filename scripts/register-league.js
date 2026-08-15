#!/usr/bin/env node
/**
 * Register a league: bind a Sleeper league to a provider group thread.
 *
 * The chat_id is the provider's group handle — for Sendblue that's the
 * sb_group_... value returned by the first group send. Inbound routing resolves
 * a league by (provider, chat_id), so until this is set the receiver can log
 * messages but cannot attribute them to a league.
 *
 * Usage:
 *   node scripts/register-league.js --name "My League" --sleeper 123456789012345678 \
 *     --chat sb_group_22222222-2222-2222-2222-222222222222... --from +15555550100
 *   node scripts/register-league.js --list
 */

require('dotenv').config();
const db = require('../src/db');
const sleeper = require('../src/sleeper');

const argv = process.argv.slice(2);
const flag = name => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? argv[i + 1] : null;
};
const has = name => argv.includes(`--${name}`);

(async () => {
  if (has('list') || !argv.length) {
    const leagues = await db.activeLeagues();
    const { rows: all } = await db.query('select * from leagues order by created_at');
    if (!all.length) {
      console.log('No leagues registered.');
      console.log('\nusage: node scripts/register-league.js --name "My League" \\');
      console.log('         --sleeper <sleeper_league_id> --chat <provider_group_id> [--from +1...]');
      return;
    }
    for (const l of all) {
      console.log(`${l.name}`);
      console.log(`  id       ${l.id}`);
      console.log(`  sleeper  ${l.sleeper_league_id || '(none — snapshots will skip)'}`);
      console.log(`  chat     ${l.provider}:${l.chat_id || '(unlinked — inbound cannot route)'}`);
      console.log(`  from     ${l.from_number || '(none)'}`);
    }
    console.log(`\n${leagues.length} league(s) eligible for snapshots.`);
    return;
  }

  const name = flag('name');
  const sleeperLeagueId = flag('sleeper');
  const chatId = flag('chat');
  const fromNumber = flag('from');
  const provider = flag('provider') || 'sendblue';

  if (!name) throw new Error('--name is required');

  // Fail before writing a league that points at nothing.
  if (sleeperLeagueId) {
    const lg = await sleeper.league(sleeperLeagueId);
    console.log(`Sleeper league verified: ${lg.name} (${lg.season}, ${lg.total_rosters} teams, status=${lg.status})`);
  } else {
    console.warn('No --sleeper id: snapshots will SKIP this league.');
  }

  const row = await db.upsertLeague({ name, sleeperLeagueId, provider, chatId, fromNumber });
  console.log('\nRegistered:');
  console.log(JSON.stringify(row, null, 2));

  // Messages logged before the league existed are stored but unattributed.
  // Claim them now rather than leaving a permanent hole at the start of the
  // chat history — that early banter is exactly what narrative memory wants.
  if (chatId) {
    const { rows: claimed } = await db.query(
      `update messages m set league_id = $1
       where m.league_id is null and m.provider = $2 and m.chat_id = $3
       returning m.id`,
      [row.id, provider, chatId]
    );
    if (claimed.length) console.log(`\nBackfilled ${claimed.length} previously unrouted message(s) to this league.`);
  }

  if (!chatId) {
    console.log('\nNo --chat yet. Get it from a Sendblue group send (group_id in the response),');
    console.log('then re-run with --chat to enable inbound routing.');
  }
})()
  .catch(err => { console.error('ERROR:', err.message); process.exitCode = 1; })
  .finally(() => db.pool.end().catch(() => {}));
