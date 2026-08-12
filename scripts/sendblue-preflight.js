#!/usr/bin/env node
/**
 * Free-tier readiness check.
 *
 * Sendblue's Free Tier is reply-only: "Contacts must text the Sendblue number
 * first before the user can message them," capped at 10 verified contacts on a
 * shared line. So a group send cannot work until every intended participant has
 * texted the line at least once.
 *
 * This prints the number to hand out, who has already texted it, and exactly
 * who is still blocking the group test.
 *
 * Usage:
 *   node scripts/sendblue-preflight.js
 *   node scripts/sendblue-preflight.js 5555550103 5555550105 5555550104
 */

require('dotenv').config();
const { SendblueProvider } = require('../src/sendblue');

function toE164(raw) {
  const s = String(raw).trim();
  if (s.includes('@')) return s;
  const digits = s.replace(/[^\d]/g, '');
  if (s.startsWith('+')) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  throw new Error(`can't normalize "${raw}"`);
}

const targets = process.argv.slice(2).map(toE164);

const provider = new SendblueProvider(
  process.env.SENDBLUE_API_KEY_ID,
  process.env.SENDBLUE_API_SECRET_KEY,
  { fromNumber: process.env.SENDBLUE_FROM_NUMBER }
);

const digits = s => String(s || '').replace(/[^\d]/g, '').slice(-10);

(async () => {
  console.log('=== 1. Your line(s) ===');
  let lines = [];
  try {
    const res = await provider.listLines();
    lines = res?.lines || res?.data || (Array.isArray(res) ? res : []);
    console.log(JSON.stringify(res, null, 2));
  } catch (err) {
    console.log(`lines lookup failed: ${err.code || err.status} — ${err.message.slice(0, 160)}`);
    console.log('Fallback: run `sendblue lines` in your terminal.');
  }

  const envFrom = process.env.SENDBLUE_FROM_NUMBER;
  if (!envFrom) {
    console.log('\nSENDBLUE_FROM_NUMBER is not set in .env — sends will fail.');
    console.log('from_number is a required field on every send.');
  } else {
    console.log(`\nSENDBLUE_FROM_NUMBER = ${envFrom}`);
  }

  console.log('\n=== 2. Verified contacts (people who have texted your line) ===');
  let contacts = [];
  try {
    const res = await provider.listContacts();
    contacts = res?.contacts || res?.data || (Array.isArray(res) ? res : []);
    console.log(`${contacts.length} contact(s)`);
    for (const c of contacts) {
      console.log(`  ${c.number || c.phone_number || c.id}  ${c.first_name || ''} ${c.last_name || ''}`.trimEnd());
    }
    if (contacts.length >= 10) {
      console.log('  AT THE FREE-TIER CAP (10). Additional contacts will be rejected.');
    }
  } catch (err) {
    console.log(`contacts lookup failed: ${err.code || err.status} — ${err.message.slice(0, 160)}`);
  }

  if (!targets.length) {
    console.log('\nPass the numbers you want to group-message to see who is blocking:');
    console.log('  node scripts/sendblue-preflight.js 5555550103 5555550105 5555550104');
    return;
  }

  console.log('\n=== 3. Group-test readiness ===');
  const known = new Set(contacts.map(c => digits(c.number || c.phone_number || c.id)));
  const missing = [];

  for (const t of targets) {
    const ok = known.has(digits(t));
    let service = '?';
    try {
      const res = await provider.evaluateService(t);
      service = res?.service || res?.data?.service || JSON.stringify(res);
    } catch (err) {
      service = `(lookup failed: ${err.code || err.status})`;
    }
    console.log(`  ${t}  verified=${ok ? 'YES' : 'NO '}  service=${service}`);
    if (!ok) missing.push(t);
  }

  if (missing.length) {
    console.log(`\nBLOCKED: ${missing.length} participant(s) have not texted your line yet.`);
    console.log('Ask each of them to send any text to ' + (envFrom || 'your Sendblue number') + ':');
    for (const m of missing) console.log(`  ${m}`);
    console.log('\nThen re-run this. A group send cannot include an unverified contact');
    console.log('on the Free Tier, and a failure caused by that tells you NOTHING about');
    console.log('whether mixed-device groups work — which is the thing you are testing.');
  } else {
    console.log('\nAll participants verified. Run the group test:');
    console.log(`  node scripts/sendblue-group.js "your message" ${targets.join(' ')}`);
  }
})().catch(err => {
  console.error('ERROR:', err.message);
  if (err.status === 401) console.error('Check SENDBLUE_API_KEY_ID / SENDBLUE_API_SECRET_KEY in .env');
  process.exit(1);
});
