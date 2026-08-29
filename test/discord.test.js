#!/usr/bin/env node
/**
 * Discord as a second transport: the provider, the registry, and identity.
 *
 * WHAT IS WORTH PINNING HERE is not "does it call the API" — that is one fetch
 * and a token. It is the three places where having two providers can go wrong
 * quietly:
 *
 * THE REGISTRY MUST NOT SILENTLY PICK THE WRONG ONE. leagues.provider has
 * existed since 0001_init.sql and nothing resolved it, so every league was on
 * whichever instance the worker happened to build. A league that resolves to
 * the wrong provider does not error, it sends to a chat id that belongs to a
 * different system.
 *
 * A SNOWFLAKE MUST NOT BECOME A PHONE NUMBER. db.normalizePhone turns a numeric
 * string into a plausible "+1..." that matches nothing and looks right in every
 * log. Discord ids must never travel through it.
 *
 * THE BOT MUST NOT ANSWER ITSELF. The gateway echoes the bot's own posts back,
 * and a loop that replies to itself is the most expensive bug this could ship.
 */
require('dotenv').config();
const assert = require('assert');
const discord = require('../src/discord');
const providers = require('../src/providers');

let pass = 0;
/*
 * Awaits. The sync version reported ok for an async body the moment it returned
 * a promise, so a rejecting assertion passed — which is the shape of bug this
 * file exists to catch, found in this file.
 */
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

(async () => {
console.log('\nthe invite');

await it('asks for four permissions and no more', () => {
  // 1<<10 view, 1<<11 send, 1<<14 embed, 1<<16 history.
  assert.strictEqual(discord.PERMISSIONS, 84992);
  // Administrator is 1<<3. Requesting it gets the invite declined silently.
  assert.strictEqual(discord.PERMISSIONS & (1 << 3), 0, 'must never request Administrator');
});

await it('carries the state token through, since it is the only link back', () => {
  const url = discord.inviteUrl({ clientId: '42', state: 'signed.token.here' });
  assert.ok(url.includes('client_id=42'));
  assert.ok(url.includes('permissions=84992'));
  assert.ok(/scope=bot(\+|%20)applications\.commands/.test(url), url);
  assert.ok(url.includes('state=signed.token.here'));
});

await it('is null rather than broken when Discord is not set up', () => {
  assert.strictEqual(discord.inviteUrl({ clientId: null }), null);
});

console.log('\nthe 2000 character wall');

await it('a normal message is one part', () => {
  // Measured: the longest message this product has ever sent is 654 chars.
  assert.deepStrictEqual(discord.split('short'), ['short']);
  assert.strictEqual(discord.split('x'.repeat(654)).length, 1);
});

await it('nothing ever exceeds the limit, whatever the shape', () => {
  const shapes = [
    'A'.repeat(1500) + '\n\n' + 'B'.repeat(900),   // paragraph
    'A'.repeat(1500) + '\n' + 'B'.repeat(900),     // line
    'word '.repeat(500),                            // spaces
    'x'.repeat(4100),                               // no boundary at all
  ];
  for (const s of shapes) {
    for (const part of discord.split(s)) {
      assert.ok(part.length <= discord.MAX_LEN, `${part.length} > ${discord.MAX_LEN}`);
    }
  }
});

await it('splits on the largest boundary that fits, not mid-word', () => {
  const parts = discord.split('A'.repeat(1500) + '\n\n' + 'B'.repeat(900));
  assert.deepStrictEqual(parts.map(p => p.length), [1500, 900]);
});

console.log('\nreading a message');

const msg = over => ({ d: {
  id: '111', channel_id: '222', content: 'worst trade in league history?',
  author: { id: '333', username: 'daveo', global_name: 'Dave', bot: false },
  member: { nick: 'Commish Dave' }, ...over } });

await it('a channel id is the chat id and a snowflake is the sender', () => {
  const p = new discord.DiscordProvider('token').parseInbound(msg());
  assert.strictEqual(p.chatId, '222');
  assert.strictEqual(p.senderId, '333');
  assert.strictEqual(p.text, 'worst trade in league history?');
  assert.strictEqual(p.protocol, 'discord');
});

await it('the server nickname wins, because it is what the league calls them', () => {
  const p = new discord.DiscordProvider('token').parseInbound(msg());
  assert.strictEqual(p.senderName, 'Commish Dave');
  const noNick = new discord.DiscordProvider('t').parseInbound(msg({ member: {} }));
  assert.strictEqual(noNick.senderName, 'Dave', 'falls back to global name');
});

await it('the bot never hears itself', () => {
  const own = msg({ author: { id: '999', username: 'commish', bot: true } });
  assert.strictEqual(new discord.DiscordProvider('t').parseInbound(own), null);
});

await it('anything without a channel is not a message', () => {
  const p = new discord.DiscordProvider('t');
  assert.strictEqual(p.parseInbound({}), null);
  assert.strictEqual(p.parseInbound(null), null);
});

console.log('\nwhich provider a league is on');

await it('a league with no provider recorded is on the original one', () => {
  assert.strictEqual(providers.DEFAULT, 'sendblue');
});

await it('an unknown provider is an error, not a silent fallback', () => {
  // Falling back would send a Discord league's recap to a phone number.
  assert.throws(() => providers.require('carrier-pigeon'), /unknown messaging provider/);
});

await it('an unconfigured provider says which variable is missing', () => {
  const had = process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_BOT_TOKEN;
  providers.reset();
  assert.throws(() => providers.require('discord'), /DISCORD_BOT_TOKEN/);
  if (had) process.env.DISCORD_BOT_TOKEN = had;
  providers.reset();
});

await it('a league with no chat id is refused rather than sent nowhere', async () => {
  await assert.rejects(
    () => providers.sendToLeague({ id: 'abc', provider: 'sendblue' }, 'hi'),
    /no chat_id/);
});

console.log(`\n${pass} passing`);
})();
