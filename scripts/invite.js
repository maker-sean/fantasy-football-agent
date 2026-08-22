#!/usr/bin/env node
/**
 * Text somebody on the waitlist their setup link.
 *
 * This is the step the signup confirmation promises — "we'll text you here when
 * we are ready to set it up" — and until now nothing implemented it. The link
 * signs them in on arrival, so there is no email, no password and no code to
 * type. The phone already proved itself when they texted in; see
 * src/onboardlink.js for why that is the stronger claim.
 *
 *   npm run invite -- --list
 *   npm run invite -- +19415550123            # compose and PRINT, send nothing
 *   npm run invite -- +19415550123 --send     # actually text it
 *
 * Printing is the default deliberately. Every other script here that can reach
 * a real person does the same, because the failure mode of a send script is not
 * an error message — it is a stranger's phone buzzing.
 */
require('dotenv').config();
const db = require('../src/db');
const onboardlink = require('../src/onboardlink');
const { SendblueProvider } = require('../src/sendblue');

const argv = process.argv.slice(2);
const has = n => argv.includes('--' + n);
const flag = n => { const i = argv.indexOf('--' + n); return i !== -1 ? argv[i + 1] : null; };
const target = argv.find(a => !a.startsWith('--'));

function message({ leagueName, url, days }) {
  const league = leagueName ? ` Set up ${leagueName} here:` : ' Set up your league here:';
  return `Commish AI — you're up.${league}\n${url}\n\n`
       + `This link signs you in, so keep it to yourself. It expires in ${days} days.\n\n`
       + `Msg & data rates may apply. Reply STOP to opt out, HELP for help.`;
}

(async () => {
  if (has('list') || !target) {
    const { rows } = await db.query(
      'select id, phone, league_name, status, created_at from signups order by created_at');
    if (!rows.length) { console.log('\n  The waitlist is empty.\n'); return; }
    console.log('');
    for (const r of rows) {
      console.log('  ' + String(r.phone).padEnd(16) + String(r.league_name || '—').padEnd(22)
                + String(r.status).padEnd(10) + new Date(r.created_at).toLocaleString());
    }
    console.log('\n  npm run invite -- <phone> --send\n');
    return;
  }

  // A uuid or a phone in any of the shapes a human writes one.
  const isId = /^[0-9a-f-]{36}$/i.test(target);
  const { rows: [signup] } = isId
    ? await db.query('select * from signups where id = $1', [target])
    : await db.query('select * from signups where phone = $1', [db.normalizePhone(target)]);

  if (!signup) throw new Error(`nobody on the waitlist matches ${target}`);
  if (!signup.phone) throw new Error('that signup has no phone — it came in by email, so it cannot be texted');

  const days = Number(flag('days') || onboardlink.DEFAULT_TTL_DAYS);
  const url = onboardlink.linkFor(signup.id, { days });
  const text = message({ leagueName: signup.league_name, url, days });

  console.log('');
  console.log('  to      ' + signup.phone);
  console.log('  league  ' + (signup.league_name || '(none recorded)'));
  console.log('  expires ' + new Date(Date.now() + days * 86400000).toLocaleString());
  console.log('');
  console.log(text.split('\n').map(l => '  | ' + l).join('\n'));
  console.log('');

  if (!has('send')) {
    console.log('  NOTHING WAS SENT. Add --send to text it.\n');
    return;
  }

  // A localhost link in a real text is unrecoverable — it is already on
  // somebody's phone by the time anyone notices. This has bitten the repo
  // before, from the worker having no RENDER_EXTERNAL_URL to fall back on.
  if (/localhost|127\.0\.0\.1/.test(url)) {
    throw new Error('PUBLIC_BASE_URL is not set, so this link points at localhost. Refusing to send.');
  }

  const provider = new SendblueProvider(
    process.env.SENDBLUE_API_KEY_ID,
    process.env.SENDBLUE_API_SECRET_KEY,
    { fromNumber: process.env.SENDBLUE_FROM_NUMBER }
  );
  const res = await provider.send(signup.phone, text);
  console.log('  sent — sendblue says ' + (res?.status || 'accepted'));
  console.log('  An accepted response is not delivery. Confirm with: npm run sendblue-status\n');

  await db.query(
    `update signups set status = 'invited', updated_at = now() where id = $1`, [signup.id]);
})().catch(e => { console.error('\n  ' + e.message + '\n'); process.exitCode = 1; })
    .finally(() => db.pool.end());
