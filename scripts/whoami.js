#!/usr/bin/env node
/**
 * What number do we actually have, and what is it allowed to do?
 *
 * Blooio allocation types (from /me/numbers): shared, dedicated, inbound, trial, 2fa.
 *
 *   dedicated / shared -> can initiate outbound freely
 *   inbound            -> REPLY-ONLY. Sending to a contact or group that has
 *                         never messaged the number returns
 *                         403 inbound_only_no_prior_inbound
 *   trial              -> confirm which behavior it inherits before planning M2
 *
 * This is decisive for the product, not just the prototype: unprompted weekly
 * recaps and lineup reminders are INITIATED messages. A reply-only number
 * cannot send them. Milestone 0 and 1 are unaffected — both are reply-first.
 *
 * Usage: node scripts/whoami.js
 */

require('dotenv').config();
const { BlooioProvider } = require('../src/provider');

const provider = new BlooioProvider(process.env.BLOOIO_API_KEY);

const REPLY_ONLY = new Set(['inbound']);
const CAN_INITIATE = new Set(['dedicated', 'shared']);

(async () => {
  let numbers;
  for (const path of ['/me/numbers', '/numbers', '/account/numbers']) {
    try {
      numbers = await provider.request('GET', path);
      console.log(`(via ${path})\n`);
      break;
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }
  if (!numbers) throw new Error('none of /me/numbers, /numbers, /account/numbers resolved — check docs.blooio.com/reference/v2');

  console.log(JSON.stringify(numbers, null, 2));

  const list = Array.isArray(numbers) ? numbers : (numbers.data || numbers.numbers || []);
  if (!list.length) return;

  console.log('\n--- what this means ---');
  for (const n of list) {
    // Blooio returns this as `plan_kind`; the others are defensive fallbacks.
    const type = String(
      n.plan_kind || n.allocation || n.type || n.allocation_type || 'unknown'
    ).toLowerCase();
    const label = n.phone_number || n.number || n.id || '(unknown number)';
    const state = n.suspended ? 'SUSPENDED' : (n.status || (n.is_active ? 'active' : 'inactive'));

    console.log(`${label}  [${type}]  status=${state}`);

    if (REPLY_ONLY.has(type)) {
      console.log('  REPLY-ONLY. M0/M1 fine (both reply-first).');
      console.log('  BLOCKED: unprompted recaps, power rankings, lineup reminders.');
      console.log('  Sends with no prior inbound -> 403 inbound_only_no_prior_inbound');
    } else if (CAN_INITIATE.has(type)) {
      console.log('  Can initiate outbound — proactive posts are viable.');
    } else if (type === 'trial') {
      console.log('  Trial number: real and iMessage-capable, so M0 runs on it as-is.');
      console.log('  Whether it may INITIATE is undocumented. Settle it empirically:');
      console.log('    node scripts/send.js "+1<your-personal-cell>" "probe"');
      console.log('  202 -> can initiate.  403 inbound_only_no_prior_inbound -> reply-only.');
    } else {
      console.log('  UNKNOWN allocation — confirm reply-only status before planning M2.');
    }
  }
})().catch(err => {
  console.error('ERROR:', err.message);
  if (err.status === 401) console.error('\nCheck BLOOIO_API_KEY in .env');
  process.exit(1);
});
