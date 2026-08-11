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
  })
  .catch(err => { console.error('ERROR:', err.message); process.exit(1); });
