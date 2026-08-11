#!/usr/bin/env node
/**
 * Check per-contact transport capability (iMessage vs SMS/RCS).
 *
 * Run this against every league member BEFORE the group test. It tells you
 * which members are the non-Apple ones, so when you read the M0 verdict you
 * already know which protocol each sender should have arrived on.
 *
 * Usage:
 *   node scripts/capabilities.js +15551234567
 *   node scripts/capabilities.js +15551234567 +15559876543 teammate@icloud.com
 */

require('dotenv').config();
const { BlooioProvider } = require('../src/provider');

const provider = new BlooioProvider(process.env.BLOOIO_API_KEY);
const contacts = process.argv.slice(2);

if (!contacts.length) {
  console.error('usage: node scripts/capabilities.js <phone-or-email> [...]');
  process.exit(1);
}

(async () => {
  const rows = [];
  for (const c of contacts) {
    try {
      const res = await provider.capabilities(c);
      rows.push({ contact: c, ...res });
    } catch (err) {
      rows.push({ contact: c, error: err.message.slice(0, 120) });
    }
  }
  console.log(JSON.stringify(rows, null, 2));
})();
