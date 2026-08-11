#!/usr/bin/env node
/**
 * Offline check of the receiver + observer, with no Blooio account.
 *
 * Posts synthetic payloads in the documented v2 shape — one from an iMessage
 * member and one from an SMS member, both on the same group chat id — so you
 * can confirm the pipeline resolves senders and protocols before spending $39.
 *
 * This proves OUR code works. It does NOT prove Blooio behaves this way for a
 * real mixed-device group — that is exactly what Milestone 0 is for.
 *
 * Usage:  npm start   (in one terminal)
 *         node scripts/simulate-webhook.js
 */

const URL = process.env.WEBHOOK_URL || 'http://localhost:3000/webhooks/blooio';
const GROUP = 'grp_simulated_league';

const events = [
  {
    event: 'message.received',
    message_id: 'msg_sim_1',
    external_id: GROUP,
    internal_id: '+15559876543',
    protocol: 'imessage',
    text: 'anyone else start Kupp this week',
    sender: '+15551110001',
    is_group: true,
    timestamp: Date.now(),
  },
  {
    event: 'message.received',
    message_id: 'msg_sim_2',
    external_id: GROUP,
    internal_id: '+15559876543',
    protocol: 'sms',
    text: 'lmao commish that trade was robbery',
    sender: '+15551110002',
    is_group: true,
    timestamp: Date.now() + 1000,
  },
  {
    event: 'message.status',
    message_id: 'msg_sim_2',
    external_id: GROUP,
    internal_id: '+15559876543',
    protocol: 'sms',
    status: 'delivered',
    is_group: true,
    timestamp: Date.now() + 2000,
  },
];

(async () => {
  for (const e of events) {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(e),
    });
    console.log(`POST ${e.event} (${e.protocol}) -> ${res.status}`);
  }

  await new Promise(r => setTimeout(r, 300));
  const verdict = await fetch(URL.replace('/webhooks/blooio', '/m0')).then(r => r.json());
  console.log('\n--- /m0 verdict ---');
  console.log(verdict.notes.join('\n'));
  console.log(JSON.stringify(verdict.chats, null, 2));
})().catch(err => {
  console.error('ERROR:', err.message);
  console.error('Is the server running?  npm start');
  process.exit(1);
});
