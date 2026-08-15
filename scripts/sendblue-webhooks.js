#!/usr/bin/env node
/**
 * List / register Sendblue webhooks over the API.
 *
 * The CLI (`sendblue webhooks set-receive <url>`) does the same thing and is
 * fine. This exists so you can VERIFY registration without guessing — the most
 * common reason "replies aren't arriving" is that the receive webhook points at
 * a tunnel URL that died, and nothing tells you that until you look.
 *
 * Usage:
 *   node scripts/sendblue-webhooks.js list
 *   node scripts/sendblue-webhooks.js set https://xyz.trycloudflare.com/webhooks/sendblue
 */

require('dotenv').config();
const { SendblueProvider } = require('../src/sendblue');

const provider = new SendblueProvider(
  process.env.SENDBLUE_API_KEY_ID,
  process.env.SENDBLUE_API_SECRET_KEY,
  { fromNumber: process.env.SENDBLUE_FROM_NUMBER }
);

const [cmd, url] = process.argv.slice(2);

// Endpoint shape isn't fully documented; try the known paths in order.
const PATHS = ['/api/account/webhooks', '/api/webhooks', '/api/v2/webhooks'];

async function tryPaths(method, body) {
  const errors = [];
  for (const p of PATHS) {
    try {
      const res = await provider.request(method, p, body);
      return { path: p, res };
    } catch (err) {
      errors.push(`${p} -> ${err.status || '?'}`);
      if (err.status && ![404, 405].includes(err.status)) throw err;
    }
  }
  const e = new Error(`no webhook endpoint responded (${errors.join(', ')})`);
  e.tried = errors;
  throw e;
}

(async () => {
  if (cmd === 'list' || !cmd) {
    const { path, res } = await tryPaths('GET');
    console.log(`(via ${path})\n`);
    console.log(JSON.stringify(res, null, 2));

    const hooks = res?.webhooks || res?.data || (Array.isArray(res) ? res : []);
    const receive = hooks.filter(h => /receive/i.test(h.type || h.event || ''));
    console.log('\n--- receive webhooks ---');
    if (!receive.length) {
      console.log('NONE. Inbound replies are going nowhere. Register one:');
      console.log('  node scripts/sendblue-webhooks.js set <tunnel-url>/webhooks/sendblue');
    } else {
      for (const h of receive) console.log(`  ${h.url || h.endpoint}  (${h.type || h.event})`);
      console.log('\nIf that URL is a dead tunnel, replies silently vanish. Re-register');
      console.log('every time cloudflared restarts — the URL changes.');
    }
    return;
  }

  if (cmd === 'set') {
    if (!url) throw new Error('usage: sendblue-webhooks.js set <https url>');
    if (!/^https:\/\//.test(url)) throw new Error('webhook URL must be https');
    if (!url.endsWith('/webhooks/sendblue')) {
      console.warn(`WARNING: url does not end in /webhooks/sendblue — that is the route this app serves.\n`);
    }
    const { path, res } = await tryPaths('POST', { url, type: 'receive' });
    console.log(`(via ${path})`);
    console.log(JSON.stringify(res, null, 2));
    console.log('\nVerify it stuck:  node scripts/sendblue-webhooks.js list');
    return;
  }

  console.error('usage:\n  node scripts/sendblue-webhooks.js list\n  node scripts/sendblue-webhooks.js set <https url>');
  process.exitCode = 1;
})().catch(err => {
  console.error('ERROR:', err.message);
  if (err.tried) {
    console.error('\nFall back to the CLI, which is authoritative:');
    console.error('  sendblue webhooks set-receive <tunnel-url>/webhooks/sendblue');
  }
  process.exit(1);
});
