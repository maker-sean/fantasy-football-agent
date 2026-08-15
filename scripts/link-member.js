#!/usr/bin/env node
/**
 * Link a phone number to a Sleeper user.
 *
 * Without this the bot cannot answer any question about a person. It can
 * compute standings perfectly and still not know which team is Marcus's,
 * because chat identity (a phone number) and league identity (a Sleeper user)
 * are separate namespaces with nothing joining them.
 *
 * Manual for now, which is correct for one league. Phase 4 needs a self-service
 * version — the bot asking "which team are you?" during onboarding — but that
 * is an onboarding flow, not a data model change: it writes the same row.
 *
 * Usage:
 *   node scripts/link-member.js --list
 *   node scripts/link-member.js --phone 5555550102 --sleeper mrenshaw7
 *   node scripts/link-member.js --phone 5555550102 --sleeper mrenshaw7 --name Marcus
 */

require('dotenv').config();
const db = require('../src/db');

const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf(`--${n}`); return i !== -1 ? argv[i + 1] : null; };
const has = n => argv.includes(`--${n}`);

const leagueName = flag('league');

/** Sleeper users seen in this league's most recent snapshot. */
async function sleeperUsers(leagueId) {
  const { rows } = await db.query(
    `select payload->'users' as users, payload->'rosters' as rosters
     from snapshots where league_id = $1 order by captured_at desc limit 1`,
    [leagueId]
  );
  if (!rows.length) return [];
  const rosters = rows[0].rosters || [];
  const byOwner = new Map(rosters.map(r => [r.owner_id, r]));
  return (rows[0].users || []).map(u => ({
    userId: u.user_id,
    username: u.username || u.display_name,
    display: u.display_name || u.username,
    team: u.metadata?.team_name || null,
    rosterId: byOwner.get(u.user_id)?.roster_id ?? null,
    record: byOwner.get(u.user_id)?.settings
      ? `${byOwner.get(u.user_id).settings.wins}-${byOwner.get(u.user_id).settings.losses}`
      : null,
  }));
}

(async () => {
  const { rows: leagues } = await db.query(
    `select * from leagues where ($1::text is null or name = $1) order by (chat_id is not null) desc, created_at`,
    [leagueName || null]
  );
  if (!leagues.length) { console.log('No leagues registered.'); return; }

  // Prefer the league that actually has a chat thread; fall back to the archive
  // for its roster names.
  const live = leagues.find(l => l.chat_id) || leagues[0];
  const withSnaps = leagues.find(l => l.sleeper_league_id) || live;

  if (has('list') || !flag('phone')) {
    console.log(`League: ${live.name}  (${live.chat_id || 'no chat'})\n`);

    const { rows: members } = await db.query(
      'select phone, sleeper_user_id, display_name from members where league_id = $1 order by display_name',
      [live.id]
    );
    console.log(`LINKED (${members.length}):`);
    for (const m of members) {
      console.log(`  ${String(m.phone || '?').padEnd(14)} -> ${String(m.sleeper_user_id || '?').padEnd(14)} ${m.display_name || ''}`);
    }
    if (!members.length) console.log('  (none — the bot cannot answer questions about people yet)');

    const { rows: seen } = await db.query(
      `select sender_phone, count(*) n, max(occurred_at) last
       from messages where chat_id = $1 and sender_phone is not null
       group by 1 order by n desc`,
      [live.chat_id]
    );
    const linked = new Set(members.map(m => m.phone));
    console.log(`\nPHONES IN CHAT, NOT YET LINKED:`);
    const unlinked = seen.filter(s => !linked.has(s.sender_phone));
    for (const s of unlinked) {
      console.log(`  ${s.sender_phone}   ${s.n} message(s), last ${new Date(s.last).toISOString().slice(0, 10)}`);
    }
    if (!unlinked.length) console.log('  (none)');

    const users = await sleeperUsers(withSnaps.id);
    console.log(`\nSLEEPER USERS in ${withSnaps.name}:`);
    for (const u of users) {
      console.log(`  ${String(u.username).padEnd(14)} ${String(u.team || '').padEnd(26)} ${u.record || ''}`);
    }

    console.log('\nLink one:');
    console.log(`  node scripts/link-member.js --phone ${unlinked[0]?.sender_phone || '+1...'} --sleeper <username> --name <Name>`);
    return;
  }

  const phone = db.normalizePhone(flag('phone'));
  const sleeperArg = flag('sleeper');
  const name = flag('name');

  const users = await sleeperUsers(withSnaps.id);
  const match = users.find(u =>
    u.username?.toLowerCase() === String(sleeperArg).toLowerCase() ||
    u.userId === sleeperArg ||
    u.display?.toLowerCase() === String(sleeperArg).toLowerCase()
  );

  if (!match) {
    console.error(`No Sleeper user "${sleeperArg}" in ${withSnaps.name}.`);
    console.error('Available: ' + users.map(u => u.username).join(', '));
    process.exitCode = 1;
    return;
  }

  const row = await db.upsertMember(live.id, {
    phone,
    sleeperUserId: match.userId,
    sleeperRosterId: match.rosterId,
    displayName: name || match.display,
  });

  console.log('Linked:');
  console.log(`  ${phone}  ->  ${match.username}  "${match.team || match.display}"  (roster ${match.rosterId})`);
  console.log(`  known as: ${row.display_name}`);
  console.log('\nThe bot can now answer questions about this person by name.');
})()
  .catch(err => { console.error('ERROR:', err.message); process.exitCode = 1; })
  .finally(() => db.pool.end().catch(() => {}));
