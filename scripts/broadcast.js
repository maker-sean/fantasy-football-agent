#!/usr/bin/env node
/**
 * Send one message to several contacts as separate 1:1 chats.
 *
 * This is NOT the Milestone 0 group test. Three 1:1 threads tell you the send
 * path works and which recipients are Apple vs not. They tell you nothing about
 * whether a mixed-device GROUP holds together — that still needs the bot added
 * to the real thread from an iPhone.
 *
 * What it does give you: a per-recipient capability read, so you know who the
 * non-Apple members are before you read the M0 verdict.
 *
 * Usage:
 *   node scripts/broadcast.js --dry-run "message text" +14805551111 +14805552222
 *   node scripts/broadcast.js "message text" 4805551111 4805552222 4805553333
 *
 * Bare 10-digit US numbers are normalized to E.164 (+1XXXXXXXXXX).
 */

require('dotenv').config();
const { BlooioProvider } = require('../src/provider');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const rest = argv.filter(a => a !== '--dry-run');
const [text, ...rawRecipients] = rest;

if (!text || !rawRecipients.length) {
  console.error('usage: node scripts/broadcast.js [--dry-run] "message" <number> [<number> ...]');
  process.exit(1);
}

/** Accept 4805551111, (480) 555-1111, +14805551111 -> +14805551111 */
function toE164(raw) {
  const s = String(raw).trim();
  if (s.includes('@')) return s;                  // email addresses pass through
  const digits = s.replace(/[^\d]/g, '');
  if (s.startsWith('+')) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  throw new Error(`can't normalize "${raw}" — pass it in E.164 (+15551234567)`);
}

const recipients = rawRecipients.map(toE164);
const provider = new BlooioProvider(process.env.BLOOIO_API_KEY);

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log(`Message: ${JSON.stringify(text)}`);
  console.log(`Recipients (${recipients.length}): ${recipients.join(', ')}`);
  console.log(dryRun ? '\nDRY RUN — nothing will be sent.\n' : '\nSending...\n');

  const results = [];
  for (const to of recipients) {
    const row = { to, capability: '?', result: '' };

    // Capability first: this is the mixed-device read you actually want.
    try {
      const cap = await provider.capabilities(to);
      row.capability = JSON.stringify(cap);
    } catch (err) {
      row.capability = `(lookup failed: ${err.status || err.message})`;
    }

    if (dryRun) {
      row.result = 'skipped (dry run)';
    } else {
      try {
        await provider.send(to, text, { idempotencyKey: `broadcast-${to}-${Date.now()}` });
        row.result = '202 queued';
      } catch (err) {
        row.result = `FAILED ${err.status || ''} ${err.message.slice(0, 160)}`;
      }
      // Space out sends — bunched traffic invites carrier throttling, and a
      // throttled brand-new number is exactly how these get flagged.
      await sleep(2000);
    }

    results.push(row);
    console.log(`${row.to}\n  capability: ${row.capability}\n  send: ${row.result}\n`);
  }

  const failed = results.filter(r => r.result.startsWith('FAILED'));
  console.log('---');
  console.log(`${results.length - failed.length}/${results.length} queued.`);
  if (!dryRun) {
    console.log('202 = QUEUED, not delivered. Confirm with the humans, or watch for');
    console.log('message.status webhooks if the receiver is running (npm start).');
  }
  if (failed.length) process.exitCode = 1;
})().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
