#!/usr/bin/env node
/**
 * Who the fifty are, versus everybody who just turned up.
 *
 * The question the promo tables exist to answer. A league that came in on the
 * Reddit link is "invited", one that came in on another commissioner's founder
 * pass is "referral", and one with no claim at all is organic — including the
 * twenty-three that were live before any of this was built.
 *
 *   npm run promo                    # slots, and the cohort so far
 *   npm run promo -- --code REDDIT50 # only that code's leagues
 *   npm run promo -- --passes        # every founder pass and whether it landed
 *
 * Read only. Nothing here spends a slot or mints a code — a slot is spent when
 * a league goes live, in src/chatlink.js, and nowhere else.
 */
require('dotenv').config();
const db = require('../src/db');
const promo = require('../src/promo');

const arg = k => {
  const i = process.argv.indexOf('--' + k);
  return i === -1 ? null : (process.argv[i + 1] || true);
};

const pad = (s, n) => String(s == null ? '' : s).padEnd(n).slice(0, n);
const day = d => (d ? new Date(d).toISOString().slice(0, 10) : '');

(async () => {
  const codes = await promo.summary();

  console.log('\nCODES');
  console.log('  ' + pad('code', 22) + pad('type', 12) + pad('used', 6)
            + pad('held', 6) + pad('left', 6) + 'status');
  for (const c of codes) {
    // A referral pass is one row among hundreds once this works; the pilot
    // code is the one anybody is actually watching.
    if (c.is_referral && !arg('passes')) continue;
    const status = !c.is_active ? 'off'
      : c.valid_until && new Date(c.valid_until) <= new Date() ? 'expired'
      : c.remaining <= 0 ? 'FULL' : 'open';
    console.log('  ' + pad(c.code, 22) + pad(c.discount_type, 12)
      + pad(c.current_uses, 6) + pad(c.reserved, 6) + pad(c.remaining, 6) + status);
  }
  if (!arg('passes')) {
    const passes = codes.filter(c => c.is_referral);
    const used = passes.filter(c => c.current_uses > 0).length;
    console.log(`\n  ${passes.length} founder passes issued, ${used} redeemed`
              + (passes.length ? '   (--passes to list them)' : ''));
  }

  const leagues = await promo.cohort({ code: arg('code') });
  const counts = leagues.reduce((a, r) => (a[r.arrival] = (a[r.arrival] || 0) + 1, a), {});

  console.log('\nLEAGUES');
  console.log('  ' + pad('league', 30) + pad('arrival', 11) + pad('code', 20)
            + pad('when', 12) + 'referred by');
  for (const l of leagues) {
    console.log('  ' + pad(l.name, 30) + pad(l.arrival, 11) + pad(l.code, 20)
      + pad(day(l.redeemed_at || l.created_at), 12) + (l.referred_by || ''));
  }

  console.log(`\n  ${leagues.length} leagues — `
    + `${counts.invited || 0} invited, ${counts.referral || 0} referred, `
    + `${counts.organic || 0} organic\n`);

  await db.pool.end();
})().catch(async e => {
  console.error(e.message);
  process.exitCode = 1;
  await db.pool.end().catch(() => {});
});
