#!/usr/bin/env node
/**
 * Claiming a roster from the group chat.
 *
 * The parser runs on EVERY message from every unbound person in a live group
 * chat, so most of this file is about what it must refuse. A false positive
 * here is the bot interrupting a conversation about week 3 to announce that
 * somebody now owns a fantasy team — which is both wrong and the exact
 * behaviour the reply gate exists to prevent.
 */
require('dotenv').config();
process.env.NODE_ENV = 'test';

const assert = require('assert');
const claims = require('../src/claims');

let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

const ROSTERS = [
  { roster: 1, sleeper_username: 'gowreckers42', team_name: 'Tank for Tyler' },
  { roster: 3, sleeper_username: 'tdermott96',   team_name: 'Punt Intended' },
  { roster: 11, sleeper_username: 'smeadows',      team_name: 'Bay Watchers' },
];
const P = (text, opts = {}) => claims.parseClaim(text, {
  rosters: ROSTERS, addressed: false, withinWindow: false, botNames: ['bot', 'jarvis'], ...opts,
});

(async () => {
  console.log('what counts as a claim');

  await it('a bare number counts while the menu is fresh', () => {
    assert.deepStrictEqual(P('3', { withinWindow: true }), { roster: 3, name: null, how: 'window' });
  });

  await it('a bare number is IGNORED once the window has passed', () => {
    // "3" is week 3, or three points, or the third pick. Answering it an hour
    // later would be the bot barging into a conversation.
    assert.strictEqual(P('3'), null);
  });

  await it('naming the bot works with no window at all', () => {
    assert.deepStrictEqual(P('bot 3'), { roster: 3, name: null, how: 'addressed' });
    assert.deepStrictEqual(P('@jarvis 11 Sean'), { roster: 11, name: 'Sean', how: 'addressed' });
  });

  await it('a username or team name needs no window — nobody says it by accident', () => {
    assert.deepStrictEqual(P('tdermott96'), { roster: 3, name: null, how: 'label' });
    assert.deepStrictEqual(P('this is Bay Watchers'), { roster: 11, name: null, how: 'label' });
    assert.deepStrictEqual(P('SUCCOP DEEZ NUTZ'), { roster: 3, name: null, how: 'label' });
  });

  await it('a number nobody is offering is not a claim', () => {
    // 7 is a real roster in the league but not on the unclaimed menu.
    assert.strictEqual(P('7', { withinWindow: true }), null);
  });

  await it('a name rides along with the number', () => {
    assert.deepStrictEqual(P('3 Marcus', { withinWindow: true }),
      { roster: 3, name: 'Marcus', how: 'window' });
  });

  console.log('\nwhat it refuses');

  await it('ordinary chat is never a claim', () => {
    for (const t of [
      'lol', 'who should I start at flex', 'week 3 was brutal',
      'I scored 3 more than you', 'get 3 more points and you win',
      '', '   ', 'bot', 'jarvis',
    ]) assert.strictEqual(P(t, { withinWindow: true }), null, JSON.stringify(t));
  });

  await it('a number followed by conversation is not a claim at all', () => {
    // "3 Marcus" is a claim; "3 and I are winning" is somebody talking. When
    // what follows is not a name, an unaddressed message is conversation.
    assert.strictEqual(P('3 and I are winning', { withinWindow: true }), null);
    assert.strictEqual(P('3 I think I am probably going to win this week', { withinWindow: true }), null);
  });

  await it('naming the bot keeps the claim and drops the junk', () => {
    // Saying the bot's name removes the ambiguity, so intent is not in doubt.
    assert.deepStrictEqual(P('bot 3 and I are winning'), { roster: 3, name: null, how: 'addressed' });
  });

  await it('a phrase that fits the length cap is still not a name', () => {
    // "Marcus and I are winning" is 24 characters. A length cap alone would
    // have let it into every recap from then on.
    assert.strictEqual(claims.cleanName('Marcus and I are winning'), null);
    assert.strictEqual(claims.cleanName('Mary-Jane'), 'Mary-Jane');
    assert.strictEqual(claims.cleanName("O'Brien"), "O'Brien");
    assert.strictEqual(claims.cleanName('Marcus S'), 'Marcus S');
  });

  await it('a number is not a name either', () => {
    assert.strictEqual(claims.cleanName('12'), null);
    assert.strictEqual(claims.cleanName(''), null);
    assert.strictEqual(claims.cleanName('Marcus'), 'Marcus');
    assert.strictEqual(claims.cleanName('"Marc"'), 'Marc');
  });

  console.log('\nthe window');

  await it('freshness is measured from when the menu was actually shown', () => {
    const mins = m => new Date(Date.now() - m * 60000).toISOString();
    assert.strictEqual(claims.withinWindow({ claims_asked_at: mins(5) }), true);
    assert.strictEqual(claims.withinWindow({ claims_asked_at: mins(59) }), true);
    assert.strictEqual(claims.withinWindow({ claims_asked_at: mins(61) }), false);
    assert.strictEqual(claims.withinWindow({ claims_asked_at: null }), false,
      'never asked means a bare number was never an answer to anything');
    assert.strictEqual(claims.withinWindow(null), false);
  });

  await it('the window is sixty minutes', () =>
    assert.strictEqual(claims.CLAIM_WINDOW_MINUTES, 60));

  console.log('\nthe menu');

  await it('numbers the menu by ROSTER id, not by position', () => {
    // A 1..N index shifts as people claim, so somebody scrolling back to an
    // older menu would claim a different team than the one they read — and it
    // would look like it worked.
    const text = claims.menuText(ROSTERS);
    assert.ok(text.includes('  1  Tank for Tyler'));
    assert.ok(text.includes('  3  Punt Intended'));
    assert.ok(text.includes('  11  Bay Watchers'), 'gaps are kept, not renumbered');
  });

  await it('shows both labels, because both are accepted answers', () => {
    const text = claims.menuText(ROSTERS);
    assert.ok(text.includes('gowreckers42') && text.includes('Tank for Tyler'));
  });

  await it('the ask names an example and the way back in later', () => {
    const t = claims.askText(ROSTERS, 'Commish');
    assert.ok(/Reply with your team's number/.test(t));
    assert.ok(/Commish/.test(t), 'says how to claim after the window closes');
  });

  console.log('\nco-owned teams');

  await it('a claimed team is off the menu, so a co-owner cannot be claimed over', () => {
    // The form supports several owners per roster; chat claims support one.
    // That asymmetry is deliberate — see replyFor — and the menu is what
    // enforces it, because unclaimed() only offers rosters with no phone.
    const claimed = ROSTERS.filter(r => r.roster !== 3);
    assert.strictEqual(claims.parseClaim('3', {
      rosters: claimed, addressed: true, withinWindow: true, botNames: ['bot'],
    }), null, 'a roster nobody is offering is not claimable');
  });

  await it('refusing a taken team names the way forward', () => {
    // "Tank for Tyler is already Tyler." on its own is a dead end for somebody
    // who genuinely shares that team.
    const msg = claims.replyFor(
      { outcome: 'rejected_team_taken', existing: { team_name: 'Tank for Tyler', display_name: 'Tyler' } },
      { roster: 1 });
    assert.ok(/already Tyler/.test(msg));
    assert.ok(/commissioner can add you/.test(msg), 'says how to become a co-owner');
  });

  console.log('\nasking for a team to be changed');

  await it('recognises a co-owner request', () => {
    for (const t of ['bot I am a co-owner of this team',
                     'bot me and my brother share this team',
                     'bot can I be a second owner',
                     'bot we co-manage that roster'])
      assert.strictEqual(claims.helpIntent(t)?.key, 'co_owner', t);
  });

  await it('recognises a takeover or reassignment request', () => {
    for (const t of ['bot someone took my account',
                     "bot that's not my team",
                     'bot I need to reassign people',
                     'bot wrong team is showing for me'])
      assert.strictEqual(claims.helpIntent(t)?.key, 'reassign', t);
  });

  await it('ordinary questions are not requests', () => {
    for (const t of ['bot who should I start', 'bot what is my record',
                     'I own the best team in this league', 'bot how many points did I score'])
      assert.strictEqual(claims.helpIntent(t), null, t);
  });

  await it('the answer is never "done" — it names the commissioner and says why', () => {
    // Acting on this from the chat is the takeover 0004 exists to prevent, and
    // it would be exploitable by simply asking.
    for (const i of claims.HELP_INTENTS) {
      const r = i.reply();
      assert.ok(/commissioner/i.test(r), i.key + ' names who can do it');
      assert.ok(/cannot|not be/i.test(r), i.key + ' says the chat cannot');
      assert.ok(/taking over|take over/i.test(r), i.key + ' says why that is the point');
    }
  });

  console.log(`\n${pass} passing`);
})();
