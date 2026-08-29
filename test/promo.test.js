#!/usr/bin/env node
/**
 * Promo codes: the cap that has to hold, and the attribution that has to
 * survive the trip.
 *
 * TWO THINGS ARE WORTH PINNING HERE and neither is "does a discount apply",
 * because nothing in this codebase charges anybody yet.
 *
 * The first is the CAP. Fifty free slots were promised in public, and the
 * funnel between clicking the link and the league going live has three steps
 * and several days in it. A cap that counts in only one of those places either
 * oversells the cohort to people who abandon the form or tells fifty-one
 * people they got the last slot. So a slot is reserved at the form and
 * redeemed at go-live, and the tests below spend slots both ways.
 *
 * The second is ATTRIBUTION — which league came off the Reddit post, which
 * came off a friend's founder pass, and which just turned up. That is the
 * question the whole table exists to answer and the one thing that cannot be
 * reconstructed afterwards if it is recorded wrong.
 */
require('dotenv').config();
if (!process.env.DATABASE_URL) {
  console.log('promo\n  SKIPPED — no DATABASE_URL\n\n0 passing');
  process.exit(0);
}
const assert = require('assert');
const db = require('../src/db');
const promo = require('../src/promo');

let pass = 0;
const it = async (n, f) => {
  try { await f(); console.log('  ok   ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; }
};

// Test codes and leagues are namespaced so cleanup can be unambiguous.
const T = 'ZZTEST';
const SL = id => '99999000' + id;

async function scrub() {
  await db.query(`delete from promo_claims where sleeper_league_id like '99999000%'`);
  await db.query(`delete from promo_codes where code like '${T}%' or code like 'FOUNDER-ZZ%'`);
  await db.query(`delete from promo_codes where created_by_league_id in
                    (select id from leagues where sleeper_league_id like '99999000%')`);
  await db.query(`delete from leagues where sleeper_league_id like '99999000%'`);
  await db.query(`delete from signup_codes where sleeper_league_id like '99999000%'`);
  await db.query(`delete from accounts where email like 'promo-zz-%@example.invalid'`);
}

async function makeCode(code, { type = 'full_free', value = 100, max = 2,
                                active = true, until = null } = {}) {
  await db.query(
    `insert into promo_codes (code, discount_type, discount_value, max_uses, is_active, valid_until)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (code) do update set max_uses = excluded.max_uses,
       is_active = excluded.is_active, valid_until = excluded.valid_until,
       current_uses = 0`,
    [code, type, value, max, active, until]);
}

async function makeLeague(n, name) {
  const { rows: [a] } = await db.query(
    `insert into accounts (email) values ($1) returning *`,
    [`promo-zz-${n}@example.invalid`]);
  const { rows: [l] } = await db.query(
    `insert into leagues (name, sleeper_league_id, account_id, provider, season, onboarding_state)
     values ($1,$2,$3,'sendblue','2026','live') returning *`,
    [name, SL(n), a.id]);
  return l;
}

(async () => {
  await scrub();

  console.log('\nreading a code');

  await it('a code is uppercased and stripped, because people type it off a phone', () => {
    assert.strictEqual(promo.normalize('  reddit50 '), 'REDDIT50');
    assert.strictEqual(promo.normalize('found er-1'), 'FOUNDER-1');
  });

  await it('a slug is the first word, letters and digits only', () => {
    assert.strictEqual(promo.slugFor('Dave'), 'DAVE');
    assert.strictEqual(promo.slugFor('Sigma Chi Dynasty'), 'SIGMA');
    assert.strictEqual(promo.slugFor("O'Brien"), 'OBRIEN');
    // Never empty: an unnameable league still gets passes.
    assert.strictEqual(promo.slugFor(''), 'LEAGUE');
    assert.strictEqual(promo.slugFor('🏈🏈'), 'LEAGUE');
  });

  await it('an unknown code is refused without touching the database twice', async () => {
    const r = await promo.validate('NOSUCHCODE-ZZ');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'unknown');
  });

  await it('a code-shaped injection attempt is just an unknown code', async () => {
    const r = await promo.validate("' or 1=1--");
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'unknown');
  });

  await it('an inactive code and an expired one are refused for different reasons', async () => {
    await makeCode(T + 'OFF', { active: false });
    await makeCode(T + 'OLD', { until: '2020-01-01T00:00:00Z' });
    assert.strictEqual((await promo.validate(T + 'OFF')).reason, 'inactive');
    assert.strictEqual((await promo.validate(T + 'OLD')).reason, 'expired');
  });

  console.log('\nthe cap, which was promised in public');

  await it('a reservation spends a slot before any league exists', async () => {
    await makeCode(T + 'CAP', { max: 2 });
    assert.strictEqual(await promo.remainingFor(T + 'CAP'), 2);
    const r = await promo.reserve(T + 'CAP', { sleeperLeagueId: SL(1) });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(await promo.remainingFor(T + 'CAP'), 1);
  });

  await it('the same league filling the form in twice does not spend two', async () => {
    // The case that empties a fifty slot cohort: a refresh, or the
    // co-commissioner having a go at the same form.
    const r = await promo.reserve(T + 'CAP', { sleeperLeagueId: SL(1) });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(await promo.remainingFor(T + 'CAP'), 1);
  });

  await it('the last slot goes, and the next league is told the cohort is full', async () => {
    await promo.reserve(T + 'CAP', { sleeperLeagueId: SL(2) });
    assert.strictEqual(await promo.remainingFor(T + 'CAP'), 0);
    const r = await promo.reserve(T + 'CAP', { sleeperLeagueId: SL(3) });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'exhausted');
  });

  await it('a league already holding the last slot can still re-apply its own code', async () => {
    // Otherwise refreshing the page on slot fifty rejects the person who
    // already has it, which reads as the cohort filling up in front of them.
    const r = await promo.reserve(T + 'CAP', { sleeperLeagueId: SL(1) });
    assert.strictEqual(r.ok, true, 'own reservation must not count against itself');
  });

  await it('an expired reservation puts the slot back without anything sweeping it', async () => {
    await db.query(
      `update promo_claims set expires_at = now() - interval '1 day'
        where code = $1 and sleeper_league_id = $2`, [T + 'CAP', SL(2)]);
    assert.strictEqual(await promo.remainingFor(T + 'CAP'), 1);
  });

  console.log('\ngoing live is what spends it');

  await it('redeeming moves the slot from held to used', async () => {
    const lg = await makeLeague(1, 'ZZ Redeem');
    const d = await promo.redeem({ leagueId: lg.id, sleeperLeagueId: SL(1) });
    assert.strictEqual(d.ok, true);
    const { rows } = await db.query('select current_uses from promo_codes where code = $1', [T + 'CAP']);
    assert.strictEqual(rows[0].current_uses, 1);
  });

  await it('the same message arriving twice does not spend two slots', async () => {
    // chatlink runs off an inbound message and messages are redelivered.
    const lg = (await db.query('select * from leagues where sleeper_league_id = $1', [SL(1)])).rows[0];
    const d = await promo.redeem({ leagueId: lg.id, sleeperLeagueId: SL(1) });
    assert.strictEqual(d.ok, true);
    assert.strictEqual(d.alreadyRedeemed, true);
    const { rows } = await db.query('select current_uses from promo_codes where code = $1', [T + 'CAP']);
    assert.strictEqual(rows[0].current_uses, 1, 'counter moved on a replay');
  });

  await it('a league that never held a claim redeems nothing', async () => {
    const lg = await makeLeague(9, 'ZZ Organic');
    const d = await promo.redeem({ leagueId: lg.id, sleeperLeagueId: SL(9) });
    assert.strictEqual(d.ok, false);
    assert.strictEqual(d.reason, 'no_claim');
  });

  console.log('\nthe passes, and who used whose');

  await it('a league gets exactly two, named after the commissioner', async () => {
    const lg = (await db.query('select * from leagues where sleeper_league_id = $1', [SL(1)])).rows[0];
    await db.query(
      `insert into signup_codes (code, sleeper_league_id, first_name)
       values ('ZZ01', $1, 'Dave')`, [SL(1)]);
    assert.strictEqual(await promo.seedFor(lg), 'Dave', 'first name beats league name');
    const p = await promo.mintFounderPasses(lg.id, { seed: 'Dave' });
    assert.strictEqual(p.length, 2);
    assert.deepStrictEqual(p.map(x => x.code), ['FOUNDER-DAVE', 'FOUNDER-DAVE2']);
    assert.strictEqual(p[0].discountType, 'percentage');
    assert.strictEqual(p[0].discountValue, 50);
  });

  await it('minting again returns the same two rather than a third and fourth', async () => {
    // The success screen is reachable more than once.
    const lg = (await db.query('select * from leagues where sleeper_league_id = $1', [SL(1)])).rows[0];
    const p = await promo.mintFounderPasses(lg.id, { seed: 'Dave' });
    assert.deepStrictEqual(p.map(x => x.code), ['FOUNDER-DAVE', 'FOUNDER-DAVE2']);
  });

  await it('a pass is good for exactly one league', async () => {
    assert.strictEqual((await promo.validate('FOUNDER-DAVE')).ok, true);
    await promo.reserve('FOUNDER-DAVE', { sleeperLeagueId: SL(4), source: 'ref' });
    const after = await promo.validate('FOUNDER-DAVE');
    assert.strictEqual(after.ok, false);
    assert.strictEqual(after.reason, 'exhausted');
  });

  await it('a used pass reports itself spent on the screen that offers it', async () => {
    const lg = (await db.query('select * from leagues where sleeper_league_id = $1', [SL(1)])).rows[0];
    const p = await promo.mintFounderPasses(lg.id, { seed: 'Dave' });
    const used = p.find(x => x.code === 'FOUNDER-DAVE');
    assert.strictEqual(used.remaining, 0, 'a spent pass must not read as available');
  });

  await it('the share link and the text quote the same offer', () => {
    const s = promo.shareFor('FOUNDER-DAVE');
    assert.ok(s.url.endsWith('/start?ref=FOUNDER-DAVE'), s.url);
    assert.ok(s.body.includes(s.url), 'the text must carry the link it describes');
    assert.ok(s.body.includes('50%'));
    assert.ok(s.smsUri.startsWith('sms:?&body='));
  });

  console.log('\nminted at go-live, handed over later');

  await it('a fresh league sees none of the passes it just earned', async () => {
    // The ask is worth one shot. Four minutes in, a commissioner has nothing
    // to base a recommendation on, so nothing is shown.
    const lg = (await db.query('select * from leagues where sleeper_league_id = $1', [SL(1)])).rows[0];
    const minted = await db.query(
      'select code from promo_codes where created_by_league_id = $1', [lg.id]);
    assert.strictEqual(minted.rows.length, 2, 'they exist');
    assert.deepStrictEqual(await promo.releasedPasses(lg.id), [], 'and are not shown');
  });

  await it('a league is only ready once it has been live long enough', async () => {
    const lg = (await db.query('select * from leagues where sleeper_league_id = $1', [SL(1)])).rows[0];
    await db.query(`update leagues set chat_linked_at = now() - interval '1 day' where id = $1`, [lg.id]);
    assert.strictEqual((await promo.readyToRelease({ days: 3 })).length, 0, 'one day is too soon');

    await db.query(`update leagues set chat_linked_at = now() - interval '9 days' where id = $1`, [lg.id]);
    const ready = await promo.readyToRelease({ days: 3 });
    assert.strictEqual(ready.length, 1);
    assert.strictEqual(ready[0].codes.length, 2);
  });

  await it('releasing hands them over, and drops the league off the list', async () => {
    const lg = (await db.query('select * from leagues where sleeper_league_id = $1', [SL(1)])).rows[0];
    const out = await promo.release(lg.id);
    assert.strictEqual(out.length, 2);
    assert.strictEqual((await promo.releasedPasses(lg.id)).length, 2, 'now visible');
    assert.strictEqual((await promo.readyToRelease({ days: 3 })).length, 0, 'no longer pending');
  });

  await it('releasing twice keeps the first date rather than resetting it', async () => {
    const lg = (await db.query('select * from leagues where sleeper_league_id = $1', [SL(1)])).rows[0];
    const first = (await promo.releasedPasses(lg.id))[0].releasedAt;
    await promo.release(lg.id);
    const again = (await promo.releasedPasses(lg.id))[0].releasedAt;
    assert.strictEqual(String(first), String(again));
  });

  console.log('\nheld slots that went quiet');

  await it('a fresh reservation is not a chase yet', async () => {
    await makeCode(T + 'QUIET', { max: 5 });
    await promo.reserve(T + 'QUIET', { sleeperLeagueId: SL(6) });
    const rows = await promo.quietClaims({ days: 3, mark: false });
    assert.ok(!rows.some(r => r.sleeper_league_id === SL(6)), 'today is not three days ago');
  });

  await it('one that has sat for days is reported', async () => {
    await db.query(`update promo_claims set created_at = now() - interval '5 days'
                     where sleeper_league_id = $1`, [SL(6)]);
    const rows = await promo.quietClaims({ days: 3, mark: false });
    assert.ok(rows.some(r => r.sleeper_league_id === SL(6)));
  });

  await it('it is reported once, not every night', async () => {
    // An alert that repeats trains the one person who can act on it to ignore
    // it — the same reason a retried signup is not a second lead.
    const first = await promo.quietClaims({ days: 3 });
    assert.ok(first.some(r => r.sleeper_league_id === SL(6)));
    const second = await promo.quietClaims({ days: 3 });
    assert.ok(!second.some(r => r.sleeper_league_id === SL(6)), 'reported twice');
  });

  await it('a slot that was redeemed or expired is not chased', async () => {
    await db.query(`update promo_claims set alerted_at = null, state = 'redeemed'
                     where sleeper_league_id = $1`, [SL(6)]);
    let rows = await promo.quietClaims({ days: 3, mark: false });
    assert.ok(!rows.some(r => r.sleeper_league_id === SL(6)), 'redeemed is not quiet');

    await db.query(`update promo_claims
                       set state = 'reserved', expires_at = now() - interval '1 day'
                     where sleeper_league_id = $1`, [SL(6)]);
    rows = await promo.quietClaims({ days: 3, mark: false });
    assert.ok(!rows.some(r => r.sleeper_league_id === SL(6)), 'already expired, slot is back');
  });

  await it('the alert names the person, not just the league', async () => {
    const notify = require('../src/notify');
    const withPromo = notify.codeIssuedText({
      leagueName: 'ZZ League', teams: 12, name: 'Dave', email: 'd@example.invalid',
      plan: 'season', code: 'AB12', promo: 'REDDIT50' });
    assert.ok(withPromo.includes('Dave'), 'the name is the point');
    assert.ok(withPromo.includes('AB12'), 'the code ties it to the row');
    assert.ok(/pilot slot is now held/.test(withPromo), 'the cost is stated');
    // No invite instruction: there is no signups row to invite yet, and an
    // action that cannot work costs the minute spent finding that out.
    assert.ok(!/INVITE/.test(withPromo));

    const organic = notify.codeIssuedText({
      leagueName: 'ZZ League', teams: 12, name: 'Dave', code: 'AB12' });
    assert.ok(!/Promo:/.test(organic), 'no promo line when no promo');
  });

  console.log('\nwho the fifty are');

  await it('invited, referred and organic are told apart', async () => {
    const referred = await makeLeague(4, 'ZZ Referred');
    await promo.redeem({ leagueId: referred.id, sleeperLeagueId: SL(4) });

    const rows = await promo.cohort();
    const by = name => rows.find(r => r.name === name);

    assert.strictEqual(by('ZZ Redeem').arrival, 'invited');
    assert.strictEqual(by('ZZ Referred').arrival, 'referral');
    assert.strictEqual(by('ZZ Organic').arrival, 'organic');
    // The referral names its source, which is the point of the loop.
    assert.strictEqual(by('ZZ Referred').referred_by, 'ZZ Redeem');
  });

  await it('every pre-existing league reads as organic, not as a pilot slot', async () => {
    // There were 23 live leagues before any of this existed. Counting them
    // would have closed a fifty league cohort at twenty-seven.
    const rows = await promo.cohort();
    const claimed = rows.filter(r => r.arrival !== 'organic').map(r => r.name).sort();
    assert.deepStrictEqual(claimed, ['ZZ Referred', 'ZZ Redeem'].sort());
  });

  await it('the operator summary counts held and used separately', async () => {
    const s = (await promo.summary()).find(r => r.code === T + 'CAP');
    assert.strictEqual(s.current_uses, 1, 'used');
    assert.strictEqual(s.remaining, s.max_uses - s.current_uses - s.reserved);
  });

  await scrub();
  console.log(`\n${pass} passing`);
  await db.pool.end();
})().catch(async e => {
  console.error('promo tests blew up:', e.message);
  process.exitCode = 1;
  await scrub().catch(() => {});
  await db.pool.end().catch(() => {});
});
