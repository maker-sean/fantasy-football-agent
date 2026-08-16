#!/usr/bin/env node
/**
 * Measure the Linq API before writing an adapter against it.
 *
 * This order is not pedantry. The original Blooio scaffold in this project was
 * written from documentation and read `chat_id` and `from` where the real
 * payload carried `external_id` and `sender` — every inbound message would have
 * been silently dropped, with nothing logged. Documentation summarises; only the
 * live API is authoritative.
 *
 * Read-only by default. Sending anything requires an explicit flag, because a
 * preflight that texts a stranger is not a preflight.
 *
 * Usage:
 *   node scripts/linq-preflight.js                 probe, send nothing
 *   node scripts/linq-preflight.js --send +1555...  send one 1:1 test message
 *   node scripts/linq-preflight.js --group +1...,+1...   create a group and post once
 */

require('dotenv').config();

const BASE = process.env.LINQ_BASE || 'https://api.linqapp.com/api/partner/v3';
const KEY = process.env.LINQ_API_KEY;
const FROM = process.env.LINQ_FROM_NUMBER;

const argv = process.argv.slice(2);
const flag = n => {
  const i = argv.indexOf('--' + n);
  return i === -1 ? null : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
};

if (!KEY) {
  console.error('LINQ_API_KEY is not set.\n  Add it to .env, then re-run.');
  process.exit(1);
}

async function call(method, path, body) {
  const url = path.startsWith('http') ? path : BASE + path;
  const t0 = Date.now();
  let res, text;
  try {
    res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${KEY}`,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    text = await res.text();
  } catch (err) {
    return { ok: false, status: 0, ms: Date.now() - t0, error: err.message };
  }
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { ok: res.ok, status: res.status, ms: Date.now() - t0, json, text };
}

/** Print the SHAPE of a response, not its contents — payloads carry phone numbers. */
function shape(v, depth = 0, key = '') {
  const pad = '  '.repeat(depth + 2);
  if (Array.isArray(v)) {
    console.log(`${pad}${key}[] (${v.length})`);
    if (v.length) shape(v[0], depth + 1, '');
    return;
  }
  if (v && typeof v === 'object') {
    if (key) console.log(`${pad}${key}{}`);
    for (const [k, val] of Object.entries(v).slice(0, 24)) {
      if (val && typeof val === 'object') shape(val, depth + 1, k);
      else console.log(`${pad}  ${k}: ${typeof val}`);
    }
    return;
  }
  console.log(`${pad}${key}: ${typeof v}`);
}

const line = (label, r) =>
  console.log(`  ${String(r.status).padEnd(4)} ${String(r.ms + 'ms').padEnd(7)} ${label}` +
    (r.error ? '  ' + r.error : ''));

(async () => {
  console.log(`base: ${BASE}`);
  console.log(`from: ${FROM || '(LINQ_FROM_NUMBER not set)'}`);
  console.log(`key:  ${KEY.slice(0, 6)}… (${KEY.length} chars)\n`);

  console.log('=== does the token work at all? ===');
  // Try the plausible identity endpoints; whichever answers tells us the auth
  // header is right and what this token can see.
  for (const p of ['/me', '/account', '/lines', '/phone-numbers', '/chats']) {
    line(p, await call('GET', p));
  }

  console.log('\n=== can we LIST messages globally? (decides poll vs webhook) ===');
  // This is the architectural question. Sendblue exposes a global message list,
  // which is why this project polls — Sendblue does not fire webhooks for GROUP
  // messages, measured. If Linq only lists per-chat, inbound has to arrive by
  // webhook instead, and we now have a deployed web service that can receive it.
  for (const p of ['/messages', '/messages?limit=5', '/chats?limit=5']) {
    const r = await call('GET', p);
    line(p, r);
    if (r.ok && r.json) shape(r.json, 0, '');
  }

  console.log('\n=== webhook subscriptions ===');
  const subs = await call('GET', '/webhook-subscriptions');
  line('/webhook-subscriptions', subs);
  if (subs.ok && subs.json) shape(subs.json, 0, '');

  const to = flag('send');
  const group = flag('group');

  if (!to && !group) {
    console.log('\nRead-only probe complete. Nothing was sent.');
    console.log('  node scripts/linq-preflight.js --send +1XXXXXXXXXX');
    console.log('  node scripts/linq-preflight.js --group +1XXXXXXXXXX,+1YYYYYYYYYY');
    return;
  }

  if (to && typeof to === 'string') {
    console.log(`\n=== sending one message to ${to} ===`);
    // Two documented shapes; try the direct one first.
    const body = { to, from: FROM, parts: [{ type: 'text', text: 'Commish preflight — you can ignore this.' }] };
    const r = await call('POST', '/messages', body);
    line('POST /messages', r);
    if (r.json) shape(r.json, 0, '');
    if (!r.ok) console.log('  body returned: ' + String(r.text).slice(0, 300));
  }

  if (group && typeof group === 'string') {
    const numbers = group.split(',').map(s => s.trim()).filter(Boolean);
    console.log(`\n=== creating a group with ${numbers.length} participants ===`);
    console.log('  This is the test Blooio failed: a mixed iPhone/Android group.');
    const create = await call('POST', '/chats', { to: numbers, from: FROM, group_name: 'Commish test' });
    line('POST /chats', create);
    if (create.json) shape(create.json, 0, '');
    const chatId = create.json?.id || create.json?.chat?.id || create.json?.data?.id;
    if (!chatId) return console.log('  no chat id in the response — cannot post');

    console.log(`\n  posting to chat ${chatId}`);
    const post = await call('POST', `/chats/${chatId}/messages`,
      { parts: [{ type: 'text', text: 'Commish preflight — group send test.' }] });
    line(`POST /chats/${chatId}/messages`, post);
    if (post.json) shape(post.json, 0, '');
    if (!post.ok) console.log('  body returned: ' + String(post.text).slice(0, 300));
  }
})().catch(err => { console.error('ERROR:', err.message); process.exitCode = 1; });
