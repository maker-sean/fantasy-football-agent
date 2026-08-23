#!/usr/bin/env node
/**
 * What people have told us, as opposed to asked us.
 *
 *   npm run feedback              # everything not yet reviewed
 *   npm run feedback -- --all
 *   npm run feedback -- --done <id>
 *
 * Pairs with npm run gaps: that one is demand inferred from a refusal, this one
 * is somebody saying it out loud.
 */
require('dotenv').config();
const db = require('../src/db');
const feedback = require('../src/feedback');

const argv = process.argv.slice(2);
const has = n => argv.includes('--' + n);
const flag = n => { const i = argv.indexOf('--' + n); return i !== -1 ? argv[i + 1] : null; };

(async () => {
  const done = flag('done');
  if (done) {
    const { rows } = await db.query(
      `update feedback set status = 'reviewed', reviewed_at = now()
        where id = $1 returning kind, left(body, 60) as body`, [done]);
    console.log(rows[0] ? `\n  marked reviewed: ${rows[0].kind} — ${rows[0].body}\n` : '\n  no such id\n');
    return;
  }

  const rows = await feedback.recent({ status: has('all') ? null : 'new', limit: 100 });
  if (!rows.length) {
    console.log(has('all') ? '\n  Nobody has sent any feedback yet.\n' : '\n  Nothing new.\n');
    return;
  }

  console.log(`\n  ${rows.length} item${rows.length === 1 ? '' : 's'}\n`);
  for (const r of rows) {
    const who = r.said_by || r.phone || 'someone';
    const where = r.in_group ? 'in the group' : 'privately';
    console.log(`  [${r.kind}] ${who} ${where}, ${new Date(r.created_at).toLocaleString()}`);
    console.log(`    ${String(r.body).replace(/\s+/g, ' ')}`);
    if (r.status !== 'new') console.log(`    (${r.status})`);
    console.log(`    npm run feedback -- --done ${r.id}`);
    console.log('');
  }
})().catch(e => { console.error('\n  ' + e.message + '\n'); process.exitCode = 1; })
    .finally(() => db.pool.end());
