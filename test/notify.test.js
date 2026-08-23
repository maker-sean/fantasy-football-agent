#!/usr/bin/env node
/**
 * Telling the operator somebody is waiting.
 *
 * A signup landed and the only trace was a console.log in the worker output.
 * The admin dashboard shows signup COUNTS, so the evidence available was a
 * number going from 1 to 2 with no way to see who or which league without
 * opening a terminal. It got noticed because somebody queried the database.
 *
 * The rules worth pinning: alerts are off unless configured, a failure never
 * costs the signup, and the message carries the command rather than just the
 * news.
 */
const assert = require('assert');
const notify = require('../src/notify');

let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

const withEnv = async (val, fn) => {
  const prev = process.env.OPERATOR_PHONE;
  if (val === null) delete process.env.OPERATOR_PHONE;
  else process.env.OPERATOR_PHONE = val;
  try { return await fn(); }
  finally { if (prev === undefined) delete process.env.OPERATOR_PHONE; else process.env.OPERATOR_PHONE = prev; }
};

(async () => {
  console.log('it stays off unless somebody turns it on');

  await it('no OPERATOR_PHONE means no alert and no error', async () => {
    await withEnv(null, async () => {
      const r = await notify.operator({ send: () => { throw new Error('should not send'); } }, 'hi');
      assert.strictEqual(r.sent, false);
      assert.strictEqual(r.reason, 'no_operator_phone');
    });
  });

  await it('a dry run composes and sends nothing', async () => {
    await withEnv('+15550000000', async () => {
      const r = await notify.operator({ send: () => { throw new Error('should not send'); } },
        'hi', { dryRun: true });
      assert.strictEqual(r.sent, false);
      assert.strictEqual(r.reason, 'dry_run');
    });
  });

  console.log('\na failed alert never costs the thing it reports');

  await it('a provider that throws is swallowed, not raised', async () => {
    await withEnv('+15550000000', async () => {
      const r = await notify.operator({ send: async () => { throw new Error('sendblue down'); } }, 'hi');
      assert.strictEqual(r.sent, false);
      assert.strictEqual(r.reason, 'send_failed');
    });
  });

  await it('it sends to the configured number, normalised', async () => {
    await withEnv('941 313 0151', async () => {
      let sentTo = null;
      const r = await notify.operator({ send: async (to) => { sentTo = to; } }, 'hi');
      assert.strictEqual(r.sent, true);
      assert.match(sentTo, /^\+1941/, `sent to ${sentTo}`);
    });
  });

  console.log('\nthe message carries the command, not just the news');

  await it('it names the league and the size', async () => {
    const t = notify.waitlistText({ leagueName: 'The Danger Zone!', teams: 12, phone: '+15551234567' });
    assert.match(t, /The Danger Zone!/);
    assert.match(t, /12 teams/);
  });

  await it('it includes the invite command with the number filled in', async () => {
    // The gap between finding out and acting was a terminal, a script name
    // nobody remembers, and a phone number that had to be looked up first.
    const t = notify.waitlistText({ leagueName: 'X', teams: 10, phone: '+15551234567' });
    assert.match(t, /npm run invite -- \+15551234567 --send/);
  });

  await it('a signup with no league still produces a usable alert', async () => {
    const t = notify.waitlistText({ leagueName: null, teams: null, phone: '+15551234567' });
    assert.match(t, /no Sleeper id/);
    assert.match(t, /npm run invite/);
  });

  console.log(`\n${pass} passing`);
})();
