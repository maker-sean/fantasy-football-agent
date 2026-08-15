#!/usr/bin/env node
/**
 * Generate a weekly recap from a captured snapshot.
 *
 * Prints the computed FACTS alongside the generated text so you can verify the
 * model didn't invent anything — the fastest way to lose a league's trust is a
 * bot that misreports a score, so this check is worth keeping in the loop.
 *
 * Usage:
 *   node scripts/recap.js --week 10                      # archive league, most recent
 *   node scripts/recap.js --league <uuid> --week 10
 *   node scripts/recap.js --week 10 --spice 2
 *   node scripts/recap.js --week 10 --model claude-opus-4-8   # A/B the model
 *   node scripts/recap.js --week 10 --facts-only         # no API key needed
 *   node scripts/recap.js --week 10 --send <sb_group_id> # post it for real
 */

require('dotenv').config();
const db = require('../src/db');
const { weekFacts } = require('../src/stats');

const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf(`--${n}`); return i !== -1 ? argv[i + 1] : null; };
const has = n => argv.includes(`--${n}`);

const week = Number(flag('week'));
const leagueId = flag('league');
const spice = Number(flag('spice') ?? 1);
const effort = flag('effort') || 'medium';
const sendTo = flag('send');
const model = flag('model');

if (!week) {
  console.error('usage: node scripts/recap.js --week <n> [--league <uuid>] [--spice 0|1|2] [--facts-only] [--send <chat_id>]');
  process.exit(1);
}

(async () => {
  const { rows: pl } = await db.query('select player_id, full_name, position, team from players');
  const players = new Map(pl.map(p => [p.player_id, p]));
  if (!players.size) {
    console.warn('No players loaded — names will show as raw ids. Run: npm run snapshot -- --players\n');
  }

  const { rows } = leagueId
    ? await db.query(
        `select s.payload from snapshots s where s.league_id = $1 and s.week = $2 order by s.captured_at desc limit 1`,
        [leagueId, week])
    : await db.query(
        `select s.payload from snapshots s join leagues l on l.id = s.league_id
         where s.week = $1 order by (l.provider = 'archive') desc, s.captured_at desc limit 1`,
        [week]);

  if (!rows.length) {
    console.error(`No snapshot for week ${week}. Capture one:`);
    console.error('  node scripts/backfill.js --league <sleeper_id> --weeks ' + week);
    process.exitCode = 1;
    return;
  }

  const facts = weekFacts(rows[0].payload, players);

  console.log('='.repeat(64));
  console.log(`FACTS — ${facts.leagueName}, ${facts.season} week ${facts.week}`);
  console.log('='.repeat(64));
  const { factsBlock } = require('../src/recap');
  console.log(factsBlock(facts));

  if (has('facts-only')) return;

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('\nANTHROPIC_API_KEY is not set in .env — cannot generate.');
    console.error('Add it, or use --facts-only to check the stats layer alone.');
    process.exitCode = 1;
    return;
  }

  console.log('\n' + '='.repeat(64));
  console.log(`RECAP (spice=${spice}, effort=${effort})`);
  console.log('='.repeat(64));

  const { generateRecap } = require('../src/recap');
  const out = await generateRecap(facts, { spice, effort, ...(model ? { model } : {}) });

  console.log('\n' + out.text + '\n');
  console.log('-'.repeat(64));
  console.log(`${out.text.split(/\s+/).length} words | audience=${out.audience} | ${out.meta.model} | stop=${out.meta.stopReason}`);
  console.log(`tokens in=${out.meta.usage.input_tokens} out=${out.meta.usage.output_tokens} cache_read=${out.meta.usage.cache_read_input_tokens ?? 0}`);
  const { verifyRecap, report } = require('../src/verify');
  const v = verifyRecap(out.text, facts, factsBlock(facts));
  console.log('\n' + '-'.repeat(64));
  console.log('VERIFICATION');
  console.log('-'.repeat(64));
  console.log(report(v));

  if (!v.ok) {
    console.error('\nBLOCKED: verification found an error. Not safe to send.');
    process.exitCode = 1;
    return;
  }
  if (v.superlatives.length) {
    console.log('\nRead the ranking words above against the results list before sending.');
  }

  if (sendTo && !v.ok) {
    console.error('Refusing to send a recap that failed verification.');
    return;
  }
  if (sendTo) {
    const { SendblueProvider } = require('../src/sendblue');
    const provider = new SendblueProvider(
      process.env.SENDBLUE_API_KEY_ID,
      process.env.SENDBLUE_API_SECRET_KEY,
      { fromNumber: process.env.SENDBLUE_FROM_NUMBER }
    );
    const res = await provider.send(sendTo, out.text);
    console.log(`\nSENT to ${sendTo}: ${res.status} ${res.message_handle || ''}`);
    console.log('QUEUED is not delivery — check: npm run sendblue-status');
  }
})()
  .catch(err => { console.error('ERROR:', err.message); process.exitCode = 1; })
  .finally(() => db.pool.end().catch(() => {}));
