#!/usr/bin/env node
/**
 * Introduce the bot to a league that never got introduced.
 *
 * src/responder.js gates the introduction on verdict.reply, so a league whose
 * first outbound came from the CLAIMS path — someone unbound addressing the bot
 * before it had ever decided to answer anything — gets the roster menu as its
 * first message and no introduction at all. That happened to Halcyon Kings on
 * 2026-08-23: twelve people met an unknown number with "I do not know which of
 * you is which yet" and never got the contact card.
 *
 * This exists to repair that case by hand while the ordering is fixed properly.
 * It is not a substitute for the fix.
 *
 *   npm run welcome -- --list
 *   npm run welcome -- "Halcyon Kings"          # compose and PRINT
 *   npm run welcome -- "Halcyon Kings" --send   # actually send it
 *
 * Printing is the default, same as every other script here that can reach real
 * people. The failure mode of a send script is not an error message, it is
 * twelve phones buzzing.
 */
require('dotenv').config();
const db = require('../src/db');
const welcome = require('../src/welcome');
const drafts = require('../src/drafts');
const { SendblueProvider } = require('../src/sendblue');

const argv = process.argv.slice(2);
const has = n => argv.includes('--' + n);
const target = argv.find(a => !a.startsWith('--'));

(async () => {
  if (has('list') || !target) {
    const { rows } = await db.query(
      `select name, chat_id, onboarding_state, welcomed_at, claims_asked_at
         from leagues where chat_id is not null order by created_at desc`);
    if (!rows.length) { console.log('\n  No league is linked to a chat.\n'); return; }
    console.log('');
    for (const r of rows) {
      console.log('  ' + String(r.name).padEnd(24)
        + String(r.onboarding_state || '-').padEnd(14)
        + (r.welcomed_at ? 'introduced ' + new Date(r.welcomed_at).toLocaleString()
                         : 'NEVER INTRODUCED'));
    }
    console.log('\n  npm run welcome -- "<name>" --send\n');
    return;
  }

  const { rows: [league] } = await db.query(
    'select * from leagues where name = $1 and chat_id is not null', [target]);
  if (!league) throw new Error(`no chat-linked league called "${target}"`);
  if (league.welcomed_at) {
    throw new Error(`${league.name} was already introduced on `
      + `${new Date(league.welcomed_at).toLocaleString()}. Refusing to do it twice.`);
  }

  const needs = await welcome.needsBinding(league.id).catch(() => false);

  // dryRun builds the real text — menu, roll call and all — and sends nothing.
  const preview = await welcome.ensureWelcomed(league, {
    send: async () => {},
    needsBinding: needs,
    dryRun: true,
  });

  console.log('');
  console.log('  league   ' + league.name);
  console.log('  chat     ' + league.chat_id);
  console.log('  binding  ' + (needs ? 'some rosters are unclaimed' : 'everyone is bound'));
  console.log('');
  console.log(preview.text.split('\n').map(l => '  | ' + l).join('\n'));
  console.log('');

  if (!has('send')) {
    console.log('  NOTHING WAS SENT. Add --send to introduce the bot.\n');
    return;
  }

  /*
   * The contact card is attached by ensureWelcomed only when the base URL is a
   * real origin, and it drops it SILENTLY otherwise. Run from a laptop whose
   * .env points PUBLIC_BASE_URL at localhost, this script therefore sends a
   * perfect introduction with no card and stamps welcomed_at, so the league can
   * never be introduced again and never gets one. That is exactly what happened
   * to Halcyon Kings on 2026-08-23 and it had to be sent separately by hand.
   *
   * Refused here rather than warned about, for the same reason invite.js
   * refuses to text a localhost link: by the time anyone notices, it is already
   * on twelve phones.
   */
  const base = require('../src/onboardlink').baseUrl();
  if (/localhost|127\.0\.0\.1/.test(base)) {
    throw new Error(
      `PUBLIC_BASE_URL resolves to ${base}, so the contact card would be dropped\n`
      + '  and the introduction would go out without it. Set PUBLIC_BASE_URL to the\n'
      + '  production origin before sending.');
  }

  const provider = new SendblueProvider(
    process.env.SENDBLUE_API_KEY_ID,
    process.env.SENDBLUE_API_SECRET_KEY,
    { fromNumber: process.env.SENDBLUE_FROM_NUMBER }
  );

  // Same path the responder uses, so the split and the contact card behave
  // exactly as they would have if the ordering had been right.
  const res = await welcome.ensureWelcomed(league, {
    send: (chat, text, opts) => drafts.sendRecap(provider, chat, text, opts),
    needsBinding: needs,
  });

  if (!res.sent) throw new Error('the introduction did not go out — nothing was stamped');
  console.log('  sent. welcomed_at is now stamped.');
  console.log('  An accepted response is not delivery. Confirm with: npm run sendblue-status\n');
})().catch(e => { console.error('\n  ' + e.message + '\n'); process.exitCode = 1; })
    .finally(() => db.pool.end());
