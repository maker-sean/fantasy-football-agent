#!/usr/bin/env node
/**
 * Sendblue 1:1 send + service lookup.
 *
 * The control for the group test. On Blooio, 1:1 to an Android number was
 * delivered over RCS while every mixed-group send failed — that contrast is
 * what proved the limit was groups, not transport. Reproduce it here before
 * drawing any conclusion about Sendblue's group behavior.
 *
 * Usage:
 *   node scripts/sendblue-send.js "+15551234567" "message text"
 *   node scripts/sendblue-send.js --lookup "+15551234567"
 */

require('dotenv').config();
const { SendblueProvider } = require('../src/sendblue');

const argv = process.argv.slice(2);
const lookupOnly = argv[0] === '--lookup';
const [number, ...rest] = lookupOnly ? argv.slice(1) : argv;
const text = rest.join(' ');

if (!number || (!lookupOnly && !text)) {
  console.error('usage: node scripts/sendblue-send.js "<number>" "message text"');
  console.error('       node scripts/sendblue-send.js --lookup "<number>"');
  process.exit(1);
}

const provider = new SendblueProvider(
  process.env.SENDBLUE_API_KEY_ID,
  process.env.SENDBLUE_API_SECRET_KEY,
  { fromNumber: process.env.SENDBLUE_FROM_NUMBER }
);

(async () => {
  try {
    const svc = await provider.evaluateService(number);
    console.log('service lookup:', JSON.stringify(svc));
  } catch (err) {
    console.log('service lookup failed:', err.code || err.status, err.message.slice(0, 140));
  }

  if (lookupOnly) return;

  const res = await provider.send(number, text);
  console.log('\nsend response:', JSON.stringify(res, null, 2));
  console.log('\nAn accepted response is not delivery — confirm with the recipient.');
})().catch(err => {
  console.error('\nERROR:', err.message);
  if (err.code) console.error('error_code:', err.code);
  process.exit(1);
});
