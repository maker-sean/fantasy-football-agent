#!/usr/bin/env node
/**
 * Build a draft recap, look at it, then send it — in that order.
 *
 * The announcer posts recaps to the group by itself, which is right once you
 * trust it and wrong the first time. This is the manual path: compose, read it
 * on your own phone, and only then put it in front of twelve people. Nothing
 * here is reachable by the cron.
 *
 *   npm run recap                        # every live league, printed only
 *   npm run recap -- --league "Halcyon" # one league
 *   npm run recap -- --league "Halcyon" --to-me      # text it to OPERATOR_PHONE
 *   npm run recap -- --league "Halcyon" --send       # post it to the group
 *
 * --send is the irreversible one and asks for --yes as well, because a draft
 * recap cannot be unsent and this script exists precisely because the automatic
 * version was not wanted yet.
 *
 * A league whose recap goes out this way is MARKED, so the announcer will not
 * send it again on the next tick.
 */
require('dotenv').config();
const db = require('../src/db');
const sleeper = require('../src/sleeper');
const da = require('../src/draftannounce');
const drafts = require('../src/drafts');
const { splitMessages } = require('../src/recap');

const arg = k => {
  const i = process.argv.indexOf('--' + k);
  return i === -1 ? null : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : true);
};

function provider() {
  const id = process.env.SENDBLUE_API_KEY_ID;
  const secret = process.env.SENDBLUE_API_SECRET_KEY;
  if (!id || !secret) throw new Error('no Sendblue credentials in this environment');
  const { SendblueProvider } = require('../src/sendblue');
  return new SendblueProvider(id, secret, { fromNumber: process.env.SENDBLUE_FROM_NUMBER });
}

(async () => {
  const want = arg('league');
  const leagues = (await db.activeLeagues())
    .filter(l => !want || want === true
      || l.name.toLowerCase().includes(String(want).toLowerCase()));

  if (!leagues.length) return console.log('No league matched.');

  for (const lg of leagues) {
    const sch = await sleeper.draftSchedule(lg.sleeper_league_id).catch(() => null);
    console.log(`\n=== ${lg.name} === draft: ${sch?.status || 'none'}`);
    if (sch && sch.status !== 'complete') {
      console.log('  Draft is not finished. A recap now would be a recap of a partial board.');
      continue;
    }

    const text = await da.recapText(lg);
    if (!text) { console.log('  Nothing to say yet — Sleeper has not written the picks out.'); continue; }

    const parts = splitMessages(text);
    parts.forEach((p, i) => {
      console.log(`\n--- message ${i + 1} of ${parts.length} (${p.length} chars) ---`);
      console.log(p);
    });

    if (arg('to-me')) {
      const to = require('../src/notify').operatorPhone();
      if (!to) { console.log('\n  OPERATOR_PHONE is not set, so there is nowhere to send it.'); continue; }
      const p = provider();
      for (const [i, part] of parts.entries()) {
        if (i) await new Promise(r => setTimeout(r, 1200));
        await p.send(to, part);
      }
      console.log(`\n  Sent ${parts.length} messages to you for review. Nothing went to the league.`);
    }

    if (arg('send')) {
      if (!arg('yes')) {
        console.log('\n  --send needs --yes as well. This posts to the whole league and cannot be undone.');
        continue;
      }
      if (!lg.chat_id) { console.log('\n  That league has no chat linked.'); continue; }
      const out = await drafts.sendRecap(provider(), lg.chat_id, text);
      // Marked so the cron does not send a second copy on its next pass.
      if (sch?.draftId) {
        await da.markSent(lg.id, sch.draftId, 'recap',
          { at: new Date().toISOString(), by: 'scripts/draft-recap.js' });
      }
      console.log(`\n  POSTED ${out.parts.length} messages to ${lg.name}, and marked so the`
                + ' announcer will not repeat it.');
    }
  }

  await db.pool.end();
})().catch(async e => {
  console.error(e.message);
  process.exitCode = 1;
  await db.pool.end().catch(() => {});
});
