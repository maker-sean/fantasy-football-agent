#!/usr/bin/env node
/**
 * Ask the bot a question from the command line. Sends nothing.
 *
 * Prints the fact sheet next to the answer so you can check every claim — the
 * same discipline as the recap. Use --context-only to inspect what the bot
 * knows without spending a token.
 *
 * Usage:
 *   node scripts/ask.js --context-only
 *   node scripts/ask.js "do you think nathan is going to win the league?"
 *   node scripts/ask.js "..." --send        # actually post it to the league thread
 */

require('dotenv').config();
const db = require('../src/db');
const { leagueContext, contextBlock } = require('../src/context');

const argv = process.argv.slice(2);
const has = n => argv.includes(`--${n}`);
const flag = n => { const i = argv.indexOf(`--${n}`); return i !== -1 ? argv[i + 1] : null; };
const question = argv.filter(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--league').join(' ');

(async () => {
  const leagueName = flag('league');
  const { rows } = await db.query(
    `select id, name, chat_id, provider from leagues where ($1::text is null or name = $1)
     order by (chat_id is not null) desc, created_at limit 1`,
    [leagueName || null]
  );
  if (!rows.length) { console.error('No league registered.'); process.exitCode = 1; return; }

  const ctx = await leagueContext(rows[0].id);

  console.log('='.repeat(66));
  console.log(`LEAGUE CONTEXT — ${ctx.leagueName}`);
  console.log('='.repeat(66));
  console.log(contextBlock(ctx));

  if (has('context-only') || !question) return;

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('\nANTHROPIC_API_KEY not set — use --context-only to inspect the facts alone.');
    process.exitCode = 1;
    return;
  }

  const { rows: recent } = await db.query(
    `select sender_phone, direction, body from messages
     where league_id = $1 order by occurred_at desc limit 6`,
    [rows[0].id]
  );
  const recentChat = recent.reverse().map(r => ({
    who: r.direction === 'outbound' ? 'bot' : (r.sender_phone || 'someone'),
    text: String(r.body || '').slice(0, 120),
  }));

  const { generateAnswer } = require('../src/answer');
  const out = await generateAnswer(question, ctx, { recentChat });

  console.log('\n' + '='.repeat(66));
  console.log(`Q: ${question}`);
  console.log('='.repeat(66));
  console.log('\n' + out.text + '\n');
  console.log('-'.repeat(66));
  console.log(`${out.text.split(/\s+/).length} words | ${out.meta.model} | linked people: ${out.meta.identityLinked} | known gaps: ${out.meta.unknowns}`);
  console.log('\nCheck every name and number above against the context. Anything not');
  console.log('there is a hallucination, and it is worse in an answer than a recap —');
  console.log('someone asked, and will act on it.');

  if (!has('send')) {
    console.log('\nNothing was sent. To post this to the league thread, re-run with --send.');
    return;
  }

  const league = rows[0];
  if (!league.chat_id) {
    console.error('\nThis league has no chat_id — nothing to send to.');
    console.error('Link one:  node scripts/register-league.js --name "' + league.name + '" --chat <group_id>');
    process.exitCode = 1;
    return;
  }

  // Sending goes to the league's OWN thread, read from the database. Passing a
  // group id by hand is how a message ends up in the wrong chat.
  const { SendblueProvider } = require('../src/sendblue');
  const provider = new SendblueProvider(
    process.env.SENDBLUE_API_KEY_ID,
    process.env.SENDBLUE_API_SECRET_KEY,
    { fromNumber: process.env.SENDBLUE_FROM_NUMBER }
  );

  console.log(`\nSending to ${league.name} (${league.chat_id})...`);
  const res = await provider.send(league.chat_id, out.text);
  console.log(`${res.status} ${res.message_handle || ''}`);

  // Record our own message immediately: the engagement metric is human replies
  // PER BOT MESSAGE, and the denominator has to exist before the next poll.
  await db.recordMessage({
    leagueId: league.id,
    provider: league.provider,
    providerMessageId: res.message_handle || null,
    direction: 'outbound',
    chatId: league.chat_id,
    senderPhone: null,
    isGroup: true,
    protocol: null,
    body: out.text,
    raw: { source: 'ask.js', question },
    occurredAt: Date.now(),
  });

  console.log('\nQUEUED is not delivery. Confirm with:  npm run sendblue-status');
})()
  .catch(err => { console.error('ERROR:', err.message); process.exitCode = 1; })
  .finally(() => db.pool.end().catch(() => {}));
