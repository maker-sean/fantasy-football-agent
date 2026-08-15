#!/usr/bin/env node
/**
 * List / register Sendblue webhooks.
 *
 * The usual reason "replies aren't arriving" is a receive webhook still
 * pointing at a tunnel URL that died. Nothing surfaces that — messages just
 * vanish — so verifying registration is worth its own command.
 *
 * Measured contract (not documented anywhere I could find):
 *   GET  /api/account/webhooks -> { status:"OK", webhooks: { receive: [...] } }
 * The GET returns an object keyed by webhook type, NOT an array. A POST of
 * { url, type } is rejected with "Missing or invalid webhooks array", so the
 * write shape differs from the read shape; the candidates below are tried in
 * order until one is accepted.
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
const PATH = '/api/account/webhooks';

/** Flattens either shape into [{type, url}]. */
function normalize(res) {
  const w = res?.webhooks ?? res?.data ?? res;
  const out = [];
  if (Array.isArray(w)) {
    for (const h of w) {
      if (typeof h === 'string') out.push({ type: 'unknown', url: h });
      else out.push({ type: h.type || h.event || 'unknown', url: h.url || h.endpoint });
    }
  } else if (w && typeof w === 'object') {
    for (const [type, val] of Object.entries(w)) {
      const list = Array.isArray(val) ? val : (val ? [val] : []);
      for (const h of list) {
        out.push({ type, url: typeof h === 'string' ? h : (h.url || h.endpoint) });
      }
    }
  }
  return out;
}

async function list({ quiet = false } = {}) {
  const res = await provider.request('GET', PATH);
  if (!quiet) console.log(JSON.stringify(res, null, 2));
  return normalize(res);
}

(async () => {
  if (cmd === 'list' || !cmd) {
    const hooks = await list();
    const receive = hooks.filter(h => /receive/i.test(h.type));
    console.log('\n--- receive webhooks ---');
    if (!receive.length) {
      console.log('NONE REGISTERED. Inbound replies are going nowhere.');
      console.log('  node scripts/sendblue-webhooks.js set <tunnel-url>/webhooks/sendblue');
    } else {
      for (const h of receive) console.log(`  ${h.url}`);
      console.log('\nIf that URL is a dead tunnel, replies silently vanish.');
      console.log('Re-register every time cloudflared restarts — the hostname changes.');
    }
    return;
  }

  if (cmd === 'set') {
    if (!url) throw new Error('usage: sendblue-webhooks.js set <https url>');
    if (!/^https:\/\//.test(url)) throw new Error('webhook URL must be https');
    if (!url.endsWith('/webhooks/sendblue')) {
      console.warn('WARNING: url does not end in /webhooks/sendblue — that is the route this app serves.\n');
    }

    // Preserve anything that isn't a receive hook; a whole-payload write would
    // otherwise silently drop the others.
    let others = [];
    try {
      others = (await list({ quiet: true })).filter(h => !/receive/i.test(h.type) && h.url);
      if (others.length) console.log(`preserving ${others.length} non-receive hook(s)`);
    } catch {
      console.warn('could not read existing webhooks first — writing receive only');
    }

    const grouped = {};
    for (const h of others) (grouped[h.type] ||= []).push(h.url);
    grouped.receive = [url];

    const candidates = [
      ['{webhooks:{receive:[url]}}', { webhooks: grouped }],
      ['{webhooks:[url]}',           { webhooks: [url], type: 'receive' }],
      ['{webhooks:[{url,type}]}',    { webhooks: [...others.map(h => ({ url: h.url, type: h.type })), { url, type: 'receive' }] }],
    ];

    const failures = [];
    for (const [label, body] of candidates) {
      try {
        const res = await provider.request('POST', PATH, body);
        console.log(`accepted shape: ${label}`);
        console.log(JSON.stringify(res, null, 2));
        const after = await list({ quiet: true });
        const receive = after.filter(h => /receive/i.test(h.type)).map(h => h.url);
        console.log(`\nreceive now: ${receive.length ? receive.join(', ') : '(still empty — the write did not take)'}`);
        if (!receive.includes(url)) process.exitCode = 1;
        return;
      } catch (err) {
        failures.push(`${label} -> ${err.status} ${(err.body?.message || '').slice(0, 80)}`);
      }
    }

    console.error('No payload shape was accepted:');
    for (const f of failures) console.error('  ' + f);
    console.error('\nUse the Sendblue dashboard (Settings -> Webhooks) or the CLI:');
    console.error('  npm install -g @sendblue/cli && sendblue login');
    console.error(`  sendblue webhooks set-receive ${url}`);
    process.exitCode = 1;
    return;
  }

  console.error('usage:\n  node scripts/sendblue-webhooks.js list\n  node scripts/sendblue-webhooks.js set <https url>');
  process.exitCode = 1;
})().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
