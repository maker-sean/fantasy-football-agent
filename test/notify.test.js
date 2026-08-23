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

  await it('it can be acted on by replying, not by opening a terminal', async () => {
    // The gap between finding out and acting was a terminal, a script name
    // nobody remembers, and a phone number that had to be looked up first.
    const t = notify.waitlistText({ leagueName: 'X', teams: 10, phone: '+15551234567' });
    assert.match(t, /Reply INVITE/);
  });

  await it('the ref is in every alert, before it is needed', async () => {
    // Two signups landing close together makes a bare INVITE ambiguous, and by
    // then the first alert has already gone out. Printing the ref always means
    // the message you scroll back to is still actionable.
    const t = notify.waitlistText({ leagueName: 'X', teams: 10, phone: '+15551234567' });
    assert.match(t, /4567/);
  });

  await it('with several waiting it insists on the number', async () => {
    const t = notify.waitlistText({ leagueName: 'X', teams: 10, phone: '+15551234567', pendingCount: 3 });
    assert.match(t, /INVITE 4567/);
    assert.match(t, /3 are waiting/);
  });

  await it('a signup with no league still produces a usable alert', async () => {
    const t = notify.waitlistText({ leagueName: null, teams: null, phone: '+15551234567' });
    assert.match(t, /no Sleeper id/);
    assert.match(t, /Reply INVITE/);
  });

  console.log('\na lead nobody can text');

  await it('a signup with no phone is not told to reply INVITE', async () => {
    /*
     * The first real website signup produced "Reply INVITE .com". The ref is
     * the last four characters of the contact and, with no phone, the caller
     * was passing the email address in that slot.
     *
     * The instruction was wrong underneath the typo too: invites.pending()
     * filters on `phone is not null` and invites.send() refuses without one, so
     * INVITE could never have reached that row however it was typed.
     */
    const t = notify.waitlistText({
      leagueName: 'Halcyon Kings', teams: 12, source: 'web',
      email: 'someone@example.invalid', name: 'Sean Mihm',
    });
    assert.doesNotMatch(t, /Reply INVITE/, 'told the operator to do something that cannot work');
    assert.doesNotMatch(t, /\.com/, 'sliced a ref out of an email address again');
    assert.match(t, /Email them yourself/);
  });

  await it('an email-only lead carries the name and address, since that is all there is', async () => {
    const t = notify.waitlistText({
      leagueName: 'X', teams: 12, source: 'web',
      email: 'someone@example.invalid', name: 'Sean Mihm',
    });
    assert.match(t, /Sean Mihm/);
    assert.match(t, /someone@example\.invalid/);
  });

  await it('a lead with neither contact says the dashboard is the only copy', async () => {
    const t = notify.waitlistText({ leagueName: 'X', teams: 10, source: 'web' });
    assert.match(t, /dashboard is the only place/);
  });

  await it('a name rides along on a normal texted signup too', async () => {
    const t = notify.waitlistText({
      leagueName: 'X', teams: 12, phone: '+15551234567', name: 'Dana Reyes' });
    assert.match(t, /Dana Reyes/);
    assert.match(t, /Reply INVITE/, 'a phone signup still carries the command');
    assert.match(t, /4567/);
  });

  console.log(`\n${pass} passing`);
})();
