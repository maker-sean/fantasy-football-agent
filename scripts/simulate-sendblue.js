#!/usr/bin/env node
/**
 * Prove the receiver works BEFORE involving a tunnel or the vendor.
 *
 * Posts Sendblue-shaped inbound payloads straight at your local route. If this
 * passes and real replies don't arrive, the problem is the tunnel or the
 * webhook registration — not your code. That split has saved hours in this
 * project already.
 *
 * Payload shape is Sendblue's documented inbound:
 *   { from_number, to_number, content, media_url, service, group_id, date_sent }
 *
 * Usage:
 *   node scripts/simulate-sendblue.js
 *   node scripts/simulate-sendblue.js --url https://xyz.trycloudflare.com/webhooks/sendblue
 *   node scripts/simulate-sendblue.js --group sb_group_realone
 */

const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf(`--${n}`); return i !== -1 ? argv[i + 1] : null; };

const URL = flag('url') || `http://localhost:${process.env.PORT || 3000}/webhooks/sendblue`;
const GROUP = flag('group') || 'sb_group_simulated';
const TO = flag('to') || '+15555550100';

// Two device families on one group_id — the exact shape M0 test (a) needs.
const events = [
  {
    from_number: '+15555550103',
    to_number: TO,
    content: 'lol who started Flacco',
    media_url: '',
    service: 'iMessage',
    group_id: GROUP,
    date_sent: new Date().toISOString(),
  },
  {
    from_number: '+15555550102',
    to_number: TO,
    content: '@bot settle this',
    media_url: '',
    service: 'SMS',
    group_id: GROUP,
    date_sent: new Date(Date.now() + 1000).toISOString(),
  },
  // A 1:1 with no group_id — must NOT be counted as group traffic.
  {
    from_number: '+15555550104',
    to_number: TO,
    content: 'dm not group',
    media_url: '',
    service: 'iMessage',
    group_id: null,
    date_sent: new Date(Date.now() + 2000).toISOString(),
  },
];

(async () => {
  console.log(`POSTing ${events.length} synthetic inbound events -> ${URL}\n`);

  for (const e of events) {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(e),
    });
    console.log(`  ${res.status}  ${e.service.padEnd(8)} group=${e.group_id || '(1:1)'}  ${JSON.stringify(e.content)}`);
  }

  await new Promise(r => setTimeout(r, 400));

  const base = URL.replace('/webhooks/sendblue', '');
  const verdict = await fetch(`${base}/m0`).then(r => r.json());

  console.log('\n--- /m0 ---');
  console.log(verdict.notes.join('\n'));
  console.log(JSON.stringify(verdict.chats, null, 1));

  const group = (verdict.chats || []).find(c => c.chatId === GROUP);
  console.log('\n--- what this proves ---');
  if (group && group.distinctSenders.length >= 2 && group.protocols.length >= 2) {
    console.log('Receiver, parser, and correlation all work.');
    console.log('If real replies still do not show up, suspect the tunnel or the');
    console.log('webhook registration — not this code.');
  } else {
    console.log('Receiver did NOT correlate as expected. Fix this before going live.');
    process.exitCode = 1;
  }
  console.log('\nNOTE: synthetic data. This says nothing about whether Sendblue');
  console.log('actually stamps group_id on real inbound replies — that is the gate.');
})().catch(err => {
  console.error('ERROR:', err.message);
  console.error('Is the server running?  npm start');
  process.exit(1);
});
