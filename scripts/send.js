#!/usr/bin/env node
/**
 * Manual send — this is Milestone 0 test (b).
 *
 * Once you know the group's chat id (from GET /m0), send one message to it and
 * have every member confirm they saw it in the SAME thread. If some members get
 * it as a separate 1:1 or a forked thread, the group fragmented and the
 * in-group architecture is wrong for real leagues.
 *
 * Usage:
 *   node scripts/send.js "<chatId>" "message text"
 */

require('dotenv').config();
const { BlooioProvider } = require('../src/provider');

const [chatId, ...rest] = process.argv.slice(2);
const text = rest.join(' ');

if (!chatId || !text) {
  console.error('usage: node scripts/send.js "<chatId>" "message text"');
  process.exit(1);
}

const provider = new BlooioProvider(process.env.BLOOIO_API_KEY);

provider.send(chatId, text)
  .then(res => {
    console.log('202 Accepted (QUEUED, not delivered):', JSON.stringify(res));
    console.log('Delivery confirmation arrives later as a message.status webhook.');
    console.log('\nIf this chat had never messaged you before, your number CAN');
    console.log('initiate outbound — proactive weekly recaps are viable.');
  })
  .catch(err => {
    console.error('ERROR:', err.message);
    if (err.status === 403 && /inbound_only_no_prior_inbound/.test(err.message)) {
      console.error('\n--- REPLY-ONLY NUMBER ---');
      console.error('This number cannot start a conversation; it can only reply to');
      console.error('someone who messaged it first.');
      console.error('  Milestone 0 and 1: unaffected, both are reply-first.');
      console.error('  Milestone 2: blocked. Unprompted recaps, power rankings, and');
      console.error('  lineup reminders are all initiated messages.');
      console.error('  Fix is a dedicated number, not a product redesign.');
    }
    process.exit(1);
  });
