#!/usr/bin/env node
/**
 * "bot stop" is a mute, not an opt-out.
 *
 * The failure that matters is a FALSE POSITIVE: muting a league because
 * somebody said "bot stop picking on Kellan" leaves twelve people with a silent
 * bot and no idea why. A missed mute is recoverable by saying it again, so the
 * matcher is anchored at both ends and these pin the cases that separate an
 * imperative from a sentence.
 *
 * STOP on its own is deliberately absent here. That is a carrier level opt-out
 * and must never be reachable from a group chat matcher.
 */
const assert = require('assert');
const { isMute, isWake } = require('../src/mute');

let pass = 0;
const it = (n, f) => {
  try { f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

const L = { config: { botNames: ['bot', 'commish', 'jarvis'] } };

console.log('an imperative with nothing after it');

it('the plain forms all mute', () => {
  for (const t of ['bot stop', 'bot please stop', 'bot stop please', 'Bot, stop.',
                   'bot shut up', 'jarvis be quiet', 'commish pause', 'bot enough!']) {
    assert.ok(isMute(t, L), `should have muted: ${t}`);
  }
});

it('any configured name works, not just the first', () => {
  assert.ok(isMute('jarvis stop', L));
  assert.ok(isMute('commish stop', L));
});

console.log('\na sentence about stopping is not a command to stop');

it('a complement after the verb means it is not a mute', () => {
  // Sean's case. This is somebody defending Kellan, not muting the bot.
  for (const t of ['bot stop picking on Kellan',
                   "bot why don't you stop picking on Kellan",
                   'bot stop it with the josh stuff',
                   'bot can you stop talking about the draft']) {
    assert.ok(!isMute(t, L), `wrongly muted: ${t}`);
  }
});

it('the bot has to be addressed first', () => {
  for (const t of ['I wish the bot would stop', 'we should stop', 'stop']) {
    assert.ok(!isMute(t, L), `wrongly muted: ${t}`);
  }
});

it('a bare STOP is never a mute, it belongs to the carrier', () => {
  // Reaching it from here would turn five minutes of irritation into a
  // permanent opt-out on a compliance list.
  assert.ok(!isMute('stop', L));
  assert.ok(!isMute('STOP', L));
});

it('stop inside a word does not count', () => {
  assert.ok(!isMute('bot stopped working', L));
  assert.ok(!isMute('bot stopping by later', L));
});

console.log('\nwaking it back up');

it('the wake forms work', () => {
  for (const t of ['bot start', 'bot resume', 'bot wake up', 'jarvis come back', 'bot unmute']) {
    assert.ok(isWake(t, L), `should have woken: ${t}`);
  }
});

it('a wake is not also a mute, and the reverse', () => {
  assert.ok(!isMute('bot start', L));
  assert.ok(!isWake('bot stop', L));
});

it('a sentence containing start does not wake it', () => {
  assert.ok(!isWake('bot who should I start at flex', L),
    'a lineup question would have woken a muted bot');
  assert.ok(!isWake('bot start Kamara or Taylor', L));
});

console.log(`\n${pass} passing`);
