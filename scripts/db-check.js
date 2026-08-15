#!/usr/bin/env node
/**
 * Verify DATABASE_URL connects and the schema is applied.
 *
 * Run this before blaming any other script. Supabase connection strings have
 * three specific failure modes that all surface as unhelpful errors:
 *   - the [YOUR-PASSWORD] placeholder was never replaced
 *   - a password containing special characters was not URL-encoded
 *   - the direct-connection host was chosen on an IPv4-only network
 *
 * Usage:  node scripts/db-check.js
 */

require('dotenv').config();

const url = process.env.DATABASE_URL;

const TABLES = ['leagues', 'members', 'messages', 'snapshots', 'players', 'job_runs'];

function critiqueUrl(u) {
  const notes = [];
  if (/\[YOUR-PASSWORD\]|\[YOUR_PASSWORD\]|<password>/i.test(u)) {
    notes.push('Contains the literal placeholder — replace it with your real database password.');
  }
  const m = u.match(/^postgres(?:ql)?:\/\/([^:]+):([^@]*)@([^/:]+)(?::(\d+))?/);
  if (!m) {
    notes.push('Does not look like postgresql://user:password@host:port/db');
    return notes;
  }
  const [, , password, host, port] = m;
  if (!password) notes.push('No password in the URL.');
  if (/[ @/#?]/.test(decodeURIComponent(password || ''))
      && password === decodeURIComponent(password || '')) {
    notes.push('Password contains characters that need URL-encoding (@ becomes %40, # becomes %23, / becomes %2F).');
  }
  if (/^db\..*\.supabase\.co$/.test(host)) {
    notes.push(`Host "${host}" is the DIRECT connection, which is IPv6-only on Supabase.`);
    notes.push('If it hangs or reports ENETUNREACH, switch to the Session pooler URI instead.');
  }
  if (port === '6543') {
    notes.push('Port 6543 is the transaction pooler. Fine here, but session pooler (5432) is safer for a long-running worker.');
  }
  return notes;
}

(async () => {
  if (!url) {
    console.error('DATABASE_URL is not set in .env\n');
    console.error('Supabase -> your project -> Connect (top bar)');
    console.error('  or Project Settings -> Database -> Connection string');
    console.error('Choose the "Session pooler" URI, replace [YOUR-PASSWORD], paste into .env:');
    console.error('  DATABASE_URL=postgresql://postgres.abcd:PASSWORD@aws-0-us-east-1.pooler.supabase.com:5432/postgres');
    process.exit(1);
  }

  const notes = critiqueUrl(url);
  if (notes.length) {
    console.log('--- connection string notes ---');
    for (const n of notes) console.log('  ' + n);
    console.log('');
  }

  const db = require('../src/db');

  try {
    const { rows } = await db.query('select current_database() as db, version() as v');
    console.log(`CONNECTED to ${rows[0].db}`);
    console.log(`  ${rows[0].v.split(',')[0]}`);
  } catch (err) {
    console.error('CONNECTION FAILED:', err.message);
    if (/ENETUNREACH|EHOSTUNREACH/.test(err.message)) {
      console.error('\nNetwork unreachable — almost always the IPv6-only direct host.');
      console.error('Use the Session pooler connection string instead.');
    }
    if (/password authentication failed/i.test(err.message)) {
      console.error('\nWrong password, or special characters that need URL-encoding.');
    }
    if (/getaddrinfo|ENOTFOUND/.test(err.message)) {
      console.error('\nHostname did not resolve — check for a truncated paste.');
    }
    process.exit(1);
  }

  const { rows: present } = await db.query(
    `select tablename from pg_tables where schemaname = 'public' and tablename = any($1)`,
    [TABLES]
  );
  const found = present.map(r => r.tablename);
  const missing = TABLES.filter(t => !found.includes(t));

  console.log(`\nSchema: ${found.length}/${TABLES.length} tables present`);
  if (missing.length) {
    console.log(`  MISSING: ${missing.join(', ')}`);
    console.log('\nApply the migration:');
    console.log('  psql "$DATABASE_URL" -f supabase/migrations/0001_init.sql');
    console.log('  (or paste that file into the Supabase SQL editor)');
    await db.pool.end();
    process.exitCode = 1;
    return;
  }

  const { rows: counts } = await db.query(`
    select
      (select count(*) from leagues)   as leagues,
      (select count(*) from members)   as members,
      (select count(*) from messages)  as messages,
      (select count(*) from snapshots) as snapshots,
      (select count(*) from players)   as players
  `);
  console.log('  ' + JSON.stringify(counts[0]));

  console.log('\nReady. Next:');
  console.log('  node scripts/register-league.js --name "FF Test" --chat sb_group_... --from +1...');
  await db.pool.end();
})().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
