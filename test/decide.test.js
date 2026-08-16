#!/usr/bin/env node
/**
 * Reply-decision tests.
 *
 * The bias under test is silence. Too chatty gets the number muted — which you
 * are never told about and cannot undo — while too quiet costs a week. Most of
 * these assert that the bot stays QUIET.
 */
const assert = require('assert');
const { decide, mentionsBot, DEFAULTS } = require('../src/decide');
const { BurstCollector } = require('../src/burst');

let pass = 0;
const it = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass += 1; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};
const itAsync = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); pass += 1; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const now = Date.now();
const msg = (text, over = {}) => ({
  chatId: 'grp_1', messageId: 'm' + Math.random(), senderId: '+15551110001',
  text, direction: 'inbound', timestamp: now, isGroup: true, raw: {}, ...over,
});
const quiet = (over = {}) => ({
  chatId: 'grp_1', provider: 'sendblue', now, totalSeen: 10,
  lastBotAt: null, msSinceLastBot: null, botStreak: 0, humansSinceBot: 5,
  sentInLastHour: 0, sentToday: 0, inbound5: 0, inbound60: 1,
  distinctSpeakers60: 1, temperature: 'cold', ...over,
});
const run = (burst, state = quiet(), league = {}) => decide({ burst, state, league });

console.log('mention matching');
it('plain mention', () => assert.strictEqual(mentionsBot('hey bot what up', ['bot']), 'bot'));
it('@ prefix', () => assert.strictEqual(mentionsBot('@bot standings?', ['bot']), 'bot'));
it('case insensitive', () => assert.strictEqual(mentionsBot('BOT!', ['bot']), 'bot'));
it('start of message', () => assert.strictEqual(mentionsBot('bot, who do I start', ['bot']), 'bot'));
it('does NOT match inside a word — robot', () => assert.strictEqual(mentionsBot('robots cant play ball', ['bot']), null));
it('does NOT match inside a word — botched', () => assert.strictEqual(mentionsBot('he botched that lineup', ['bot']), null));
it('matches a second configured name', () => assert.strictEqual(mentionsBot('kings help', ['bot', 'kings']), 'kings'));
it('"commish" is NOT a default trigger — it is a human in every league', () => {
  assert.strictEqual(mentionsBot('commish can you fix the waiver order', DEFAULTS.botNames), null);
  assert.strictEqual(mentionsBot('commish is asleep at the wheel again', DEFAULTS.botNames), null);
});
it('empty text is not a mention', () => assert.strictEqual(mentionsBot('', ['bot']), null));

console.log('\nlayer 1 — direct address');
it('replies when mentioned', () => {
  const v = run([msg('@bot who should I start')]);
  assert.strictEqual(v.reply, true);
  assert.strictEqual(v.layer, 'mention');
});
it('finds the mention anywhere in the burst', () => {
  const v = run([msg('hold on'), msg('bot what were the standings')]);
  assert.strictEqual(v.reply, true);
});
it('stays silent on ordinary banter', () => {
  const v = run([msg('Sean is actually the doofus')]);
  assert.strictEqual(v.reply, false);
  assert.strictEqual(v.reason, 'not_addressed');
});
it('stays silent on a question not addressed to it', () => {
  const v = run([msg('anyone know if Kupp is playing?')]);
  assert.strictEqual(v.reply, false);
});

console.log('\nlayer 0 — hard suppression');
it('never reacts to its own outbound message', () => {
  const v = run([msg('@bot hello', { direction: 'outbound' })]);
  assert.strictEqual(v.reply, false);
  assert.strictEqual(v.reason, 'own_message');
});
it('suppression outranks a mention', () => {
  const v = run([msg('@bot hi')], quiet({ sentInLastHour: 999 }));
  assert.strictEqual(v.reply, false);
  assert.strictEqual(v.layer, 'suppress');
});
it('ignores stale backlog after a restart', () => {
  const old = now - 60 * 60 * 1000;
  const v = run([msg('@bot hi', { timestamp: old })], quiet());
  assert.strictEqual(v.reply, false);
  assert.strictEqual(v.reason, 'stale_backlog');
});
it('respects a paused league', () => {
  const v = run([msg('@bot hi')], quiet(), { config: { paused: true } });
  assert.strictEqual(v.reason, 'league_paused');
});
it('the pacing gap does NOT silence a direct question', () => {
  // Observed live: a second person asked the bot something 40s after it spoke
  // and got ignored. Being unanswered is worse than being slightly chatty.
  const v = run([msg('jarvis who won last year?')], quiet({ msSinceLastBot: 5000, lastBotAt: now - 5000 }),
    { config: { botNames: ['jarvis'] } });
  assert.strictEqual(v.reply, true, 'a direct address should still get through');
});
it('the pacing gap still applies when nobody addressed us', () => {
  // Dead code until Layer 2 exists, which is the point — pacing is for
  // unprompted interjection, not for answering a question.
  const { decide: d } = require('../src/decide');
  const v = d({ burst: [msg('just chatting')], state: quiet({ msSinceLastBot: 5000, lastBotAt: now - 5000 }), league: {} });
  assert.strictEqual(v.reply, false);
});
it('an unprompted reply is capped lower than an answer', () => {
  // Observed live: the bot capped out mid-conversation and ignored four direct
  // questions in a row. A group talking TO it is engagement, not runaway.
  const atUnpromptedCap = quiet({ sentInLastHour: DEFAULTS.maxPerHour });
  assert.strictEqual(run([msg('@bot hi')], atUnpromptedCap).reply, true,
    'a direct question should still get through the unprompted cap');
});
it('the addressed cap still binds eventually', () => {
  const v = run([msg('@bot hi')], quiet({ sentInLastHour: DEFAULTS.maxPerHourAddressed }));
  assert.strictEqual(v.reason, 'hourly_cap');
});
it('the addressed daily cap still binds', () => {
  const v = run([msg('@bot hi')], quiet({ sentToday: DEFAULTS.maxPerDayAddressed }));
  assert.strictEqual(v.reason, 'daily_cap');
});
it('the streak cap still binds on a direct mention', () => {
  const v = run([msg('@bot hi')], quiet({ botStreak: 2, humansSinceBot: 0, msSinceLastBot: 999999 }));
  assert.strictEqual(v.reason, 'bot_streak');
});
it('stops a bot talking to itself', () => {
  const v = run([msg('@bot hi')], quiet({ botStreak: 2, humansSinceBot: 0, msSinceLastBot: 999999 }));
  assert.strictEqual(v.reason, 'bot_streak');
});

it('the unprompted daily cap does not silence a question', () => {
  const v = run([msg('@bot hi')], quiet({ sentToday: DEFAULTS.maxPerDay }));
  assert.strictEqual(v.reply, true);
});
it('an empty burst decides nothing', () => assert.strictEqual(run([]).reply, false));

console.log('\nlayers 2+ stay off');
it('heuristics do not fire when disabled', () => {
  const v = decide({ burst: [msg('who should I start at flex?')], state: quiet(), league: {} });
  assert.strictEqual(v.layer, 'default');
});
it('enabling an unbuilt layer fails loudly rather than silently', () => {
  assert.throws(() => decide({
    burst: [msg('hi')], state: quiet(), league: {}, overrides: { enableHeuristics: true },
  }), /not implemented/);
});

console.log('\nper-league overrides');
it('a league can set its own bot name', () => {
  const v = run([msg('kings what happened')], quiet(), { config: { botNames: ['kings'] } });
  assert.strictEqual(v.reply, true);
});
it('a league can tighten its own rate limit', () => {
  const v = run([msg('@bot hi')], quiet({ sentToday: 2 }), { config: { maxPerDay: 2 } });
  assert.strictEqual(v.reason, 'daily_cap');
});

(async () => {
  console.log('\nburst collection');
  await itAsync('groups messages arriving together into one burst', async () => {
    const seen = [];
    const c = new BurstCollector({ quietMs: 20, maxWaitMs: 500, onBurst: (id, m) => seen.push(m) });
    c.add(msg('@bot'));
    c.add(msg('who do I start'));
    await new Promise(r => setTimeout(r, 60));
    assert.strictEqual(seen.length, 1, 'one burst');
    assert.strictEqual(seen[0].length, 2, 'both messages in it');
    c.stop();
  });
  await itAsync('separates bursts across a quiet gap', async () => {
    const seen = [];
    const c = new BurstCollector({ quietMs: 20, maxWaitMs: 500, onBurst: (id, m) => seen.push(m) });
    c.add(msg('first'));
    await new Promise(r => setTimeout(r, 60));
    c.add(msg('second'));
    await new Promise(r => setTimeout(r, 60));
    assert.strictEqual(seen.length, 2);
    c.stop();
  });
  await itAsync('keeps separate chats separate', async () => {
    const seen = [];
    const c = new BurstCollector({ quietMs: 20, maxWaitMs: 500, onBurst: (id, m) => seen.push([id, m.length]) });
    c.add(msg('a', { chatId: 'grp_1' }));
    c.add(msg('b', { chatId: 'grp_2' }));
    await new Promise(r => setTimeout(r, 60));
    assert.strictEqual(seen.length, 2);
    c.stop();
  });
  await itAsync('flushes during a sustained flurry rather than waiting forever', async () => {
    const seen = [];
    const c = new BurstCollector({ quietMs: 1000, maxWaitMs: 60, onBurst: (id, m) => seen.push(m) });
    const t = setInterval(() => c.add(msg('chatter')), 10);
    await new Promise(r => setTimeout(r, 150));
    clearInterval(t);
    assert.ok(seen.length >= 1, 'max-wait timer fired despite continuous traffic');
    c.stop();
  });
  await itAsync('flushes pending work on shutdown', async () => {
    const seen = [];
    const c = new BurstCollector({ quietMs: 9999, maxWaitMs: 9999, onBurst: (id, m) => seen.push(m) });
    c.add(msg('pending'));
    await c.flushAll();
    assert.strictEqual(seen.length, 1);
    c.stop();
  });

  console.log(`\n${pass} passing`);
})();
