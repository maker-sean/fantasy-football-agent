/**
 * Promo codes: who was invited, what they were promised, and how many slots
 * are left.
 *
 * THE THING TO BE HONEST ABOUT. Nothing here charges anybody. There is no
 * Stripe integration in this repo and no checkout to apply a discount at, so
 * "50% off" is a promise recorded against a league rather than a price anyone
 * pays. That is genuinely useful — it is the difference between knowing your
 * pilot cohort on the day billing turns on and reconstructing it from a Reddit
 * thread — but it is not a discount, and the wording everywhere here is chosen
 * so nobody reads it as one.
 *
 * COUNTING. A cap has to hold across a funnel with a gap in the middle: the
 * start page issues a four character code, the person texts it in, an operator
 * invites them, and the league goes live later when a real message lands in the
 * group chat. Counting slots at the front oversells the cohort to everyone who
 * abandons the form. Counting only at the back lets fifty-one people be told
 * they got the last one. So a slot is RESERVED at the form and REDEEMED when
 * the league goes live, the cap counts both, and a reservation that never
 * becomes a league expires and gives the slot back.
 */

const db = require('./db');

/** How long a filled-in form holds a pilot slot before it goes back on the pile. */
const RESERVATION_DAYS = Number(process.env.PROMO_RESERVATION_DAYS || 14);

/** The pilot code. Referenced by name in the start page's banner copy. */
const PILOT_CODE = 'REDDIT50';

/** Codes are uppercase, and typed by humans off a phone screen. */
const normalize = v => String(v || '').trim().toUpperCase().replace(/\s+/g, '');

/** Shape of a code as the browser is allowed to see it. */
const publicView = (row, remaining) => ({
  code: row.code,
  discountType: row.discount_type,
  discountValue: Number(row.discount_value),
  label: row.label || null,
  remaining,
  // Whether this code was minted by another league's founder pass, without
  // saying WHICH league — the referrer did not agree to be named to strangers.
  referral: !!row.created_by_league_id,
  // Null until somebody decides the league has used the product long enough
  // to be asked to vouch for it. See 0043_promo_release.sql.
  releasedAt: row.released_at || null,
});

/**
 * Slots left on a code.
 *
 * Redemptions live on the counter, live reservations are counted here. An
 * expired reservation is not counted and is not tidied up first — a slot comes
 * back by going stale, so a crashed process cannot strand one.
 */
async function remainingFor(code, { client = db } = {}) {
  const { rows } = await client.query(
    `select p.max_uses - p.current_uses - (
              select count(*) from promo_claims c
               where c.code = p.code and c.state = 'reserved'
                 and (c.expires_at is null or c.expires_at > now())
            ) as remaining
       from promo_codes p where p.code = $1`, [code]);
  return rows[0] ? Number(rows[0].remaining) : 0;
}

/**
 * Is this code usable right now?
 *
 * Returns a reason rather than a boolean, because every no here has different
 * copy on the page: an exhausted pilot gets a banner explaining the cohort is
 * full, a typo gets "we don't recognise that code", and neither should be
 * rendered as the other.
 */
async function validate(rawCode, { now = new Date() } = {}) {
  const code = normalize(rawCode);
  if (!code) return { ok: false, reason: 'missing' };
  if (!/^[A-Z0-9][A-Z0-9-]{1,39}$/.test(code)) return { ok: false, reason: 'unknown' };

  const { rows } = await db.query('select * from promo_codes where code = $1', [code]);
  const row = rows[0];
  if (!row) return { ok: false, reason: 'unknown' };
  if (!row.is_active) return { ok: false, reason: 'inactive' };
  if (row.valid_until && new Date(row.valid_until) <= now) return { ok: false, reason: 'expired' };

  const remaining = await remainingFor(code);
  if (remaining <= 0) {
    return { ok: false, reason: 'exhausted', promo: publicView(row, 0) };
  }
  return { ok: true, promo: publicView(row, remaining) };
}

/**
 * Hold a slot for somebody who has just filled in the start page.
 *
 * Takes the slot inside a transaction with the row locked, because two people
 * clicking the same Reddit link within a second of each other is exactly how a
 * fifty slot cohort becomes a fifty-two slot cohort.
 */
async function reserve(rawCode, { sleeperLeagueId, signupCode = null,
                                  email = null, source = 'promo' } = {}) {
  const code = normalize(rawCode);
  if (!code) return { ok: false, reason: 'missing' };
  if (!sleeperLeagueId) return { ok: false, reason: 'missing_league' };

  const client = await db.pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(
      'select * from promo_codes where code = $1 for update', [code]);
    const row = rows[0];
    if (!row)             { await client.query('rollback'); return { ok: false, reason: 'unknown' }; }
    if (!row.is_active)   { await client.query('rollback'); return { ok: false, reason: 'inactive' }; }
    if (row.valid_until && new Date(row.valid_until) <= new Date()) {
      await client.query('rollback'); return { ok: false, reason: 'expired' };
    }

    // A league that already holds a slot is not taking a second one, so its
    // own reservation must not count against the remaining figure it is
    // checked against — otherwise a refresh on the last slot rejects itself.
    const { rows: mine } = await client.query(
      `select * from promo_claims
        where sleeper_league_id = $1 and state = 'reserved'`, [String(sleeperLeagueId)]);
    const remaining = await remainingFor(code, { client });
    if (remaining <= 0 && !mine[0]) {
      await client.query('rollback');
      return { ok: false, reason: 'exhausted', promo: publicView(row, 0) };
    }

    const { rows: claim } = await client.query(
      `insert into promo_claims (code, sleeper_league_id, signup_code, email, source, expires_at)
       values ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval)
       on conflict (sleeper_league_id) where state = 'reserved'
       do update set code = excluded.code,
                     signup_code = coalesce(excluded.signup_code, promo_claims.signup_code),
                     email = coalesce(excluded.email, promo_claims.email),
                     source = excluded.source,
                     expires_at = excluded.expires_at,
                     updated_at = now()
       returning *`,
      [code, String(sleeperLeagueId), signupCode, email, source, String(RESERVATION_DAYS)]
    );
    await client.query('commit');
    return { ok: true, claim: claim[0],
             promo: publicView(row, mine[0] ? remaining : remaining - 1) };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Turn a held slot into a used one, because the league is live.
 *
 * Idempotent on purpose: the caller is src/chatlink.js, which runs off an
 * inbound message, and a message that arrives twice must not spend two slots
 * or mint four founder passes.
 */
async function redeem({ leagueId, sleeperLeagueId = null, code = null }) {
  if (!leagueId) return { ok: false, reason: 'missing_league' };

  const already = await db.query(
    `select * from promo_claims where league_id = $1 and state = 'redeemed'`, [leagueId]);
  if (already.rows[0]) return { ok: true, claim: already.rows[0], alreadyRedeemed: true };

  // The slot this league is holding, found by the id it has carried since the
  // start page. `code` is the operator path, for applying one after the fact.
  const found = await db.query(
    `select * from promo_claims
      where state = 'reserved'
        and (($1::text is not null and sleeper_league_id = $1)
          or ($2::text is not null and code = $2 and league_id is null))
      order by created_at asc limit 1`,
    [sleeperLeagueId ? String(sleeperLeagueId) : null, code ? normalize(code) : null]);
  const claim = found.rows[0];
  if (!claim) return { ok: false, reason: 'no_claim' };

  const client = await db.pool.connect();
  try {
    await client.query('begin');
    await client.query('select * from promo_codes where code = $1 for update', [claim.code]);
    const { rows } = await client.query(
      `update promo_claims
          set state = 'redeemed', league_id = $2, redeemed_at = now(),
              expires_at = null, updated_at = now()
        where id = $1 and state = 'reserved'
        returning *`, [claim.id, leagueId]);
    if (!rows[0]) { await client.query('rollback'); return { ok: false, reason: 'race' }; }
    await client.query(
      `update promo_codes set current_uses = current_uses + 1, updated_at = now()
        where code = $1`, [claim.code]);
    await client.query('commit');
    return { ok: true, claim: rows[0] };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** FOUNDER-DAVE, FOUNDER-DAVE2 — readable, and typable into a phone. */
function slugFor(seed) {
  const base = String(seed || '')
    .normalize('NFKD').replace(/[^\w\s-]/g, '')
    .trim().split(/\s+/)[0] || 'LEAGUE';
  return base.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'LEAGUE';
}

/**
 * What to name a league's passes after.
 *
 * The spec said first name or league slug, in that order, and the order is the
 * point: FOUNDER-DAVE is a thing Dave will read out loud to a friend, and
 * FOUNDER-SIGMACHIDYNASTY is a thing he will paste and hope. The first name is
 * on the signup_codes row from the start page, which is the only place it
 * exists this early — accounts carry an email, not a name.
 */
async function seedFor(league) {
  if (!league) return 'LEAGUE';
  const { rows } = await db.query(
    `select first_name from signup_codes
      where sleeper_league_id = $1 and first_name is not null
      order by created_at desc limit 1`, [String(league.sleeper_league_id || '')]);
  return rows[0]?.first_name || league.name || 'LEAGUE';
}

/**
 * The two passes a pilot league gets to hand out.
 *
 * Idempotent by league: called again, it returns the same two codes rather than
 * minting a third and fourth. The success screen polls, and the endpoint is
 * reachable by anyone holding the league's session.
 */
async function mintFounderPasses(leagueId, { seed = null, count = 2 } = {}) {
  // With the real remaining count on each, so a pass somebody has already used
  // renders as spent rather than as a live invitation to send it again.
  const withRemaining = rows =>
    Promise.all(rows.map(async r => publicView(r, await remainingFor(r.code))));

  const existing = await db.query(
    `select * from promo_codes where created_by_league_id = $1 order by created_at asc`,
    [leagueId]);
  if (existing.rows.length >= count) return withRemaining(existing.rows.slice(0, count));

  const slug = slugFor(seed);
  const minted = [...existing.rows];
  for (let i = minted.length; i < count; i++) {
    // FOUNDER-DAVE, then FOUNDER-DAVE2. A collision with another Dave walks to
    // the next suffix rather than failing the onboarding that earned it.
    let code = null;
    for (let n = i; n < i + 40 && !code; n++) {
      const candidate = `FOUNDER-${slug}${n === 0 ? '' : n + 1}`;
      const { rows } = await db.query(
        `insert into promo_codes (code, discount_type, discount_value, max_uses,
                                  created_by_league_id, valid_until, label)
         values ($1, 'percentage', 50, 1, $2, $3, 'Founder VIP pass — 50% off a full season')
         on conflict (code) do nothing returning *`,
        [candidate, leagueId, '2027-02-15T00:00:00Z']);
      if (rows[0]) code = rows[0];
    }
    if (!code) break;      // pathological collision; two passes is a nice-to-have
    minted.push(code);
  }
  return withRemaining(minted.slice(0, count));
}

/**
 * The link and the text a founder pass is shared with.
 *
 * Built here rather than in the page so the SMS body and the copy button
 * cannot drift into quoting different prices at the same friend. The URL uses
 * the same base as every other link this product sends.
 */
function shareFor(code) {
  const { baseUrl } = require('./onboardlink');
  const url = `${baseUrl()}/start?ref=${encodeURIComponent(code)}`;
  const body = 'Hey, got our league into Commish AI. Used my founder access to '
             + `get you 50% off your full season if you want it: ${url}`;
  return { code, url, body, smsUri: `sms:?&body=${encodeURIComponent(body)}` };
}

/**
 * The passes a league is allowed to SEE, which is not the same as the passes
 * it has.
 *
 * Every pass is minted at go-live and none is handed over then. Asking
 * somebody to recommend a product they have used for four minutes wastes the
 * ask, so this returns nothing until a pass has been released — and the
 * onboarding screen, which renders nothing for an empty list, therefore does
 * not appear at all until somebody decides it should.
 */
async function releasedPasses(leagueId) {
  const { rows } = await db.query(
    `select * from promo_codes
      where created_by_league_id = $1 and released_at is not null
      order by created_at asc`, [leagueId]);
  return Promise.all(rows.map(async r => publicView(r, await remainingFor(r.code))));
}

/**
 * Leagues that have used it long enough to be worth asking.
 *
 * Live for at least `days`, holding passes nobody has handed them. The default
 * is three days because that is roughly a Tuesday recap plus a waiver run —
 * the point at which a commissioner has actually seen the thing work rather
 * than seen it arrive.
 */
async function readyToRelease({ days = 3 } = {}) {
  const { rows } = await db.query(
    `select l.id, l.name, l.chat_linked_at,
            extract(day from now() - l.chat_linked_at)::int as days_live,
            array_agg(p.code order by p.created_at) as codes
       from leagues l
       join promo_codes p on p.created_by_league_id = l.id and p.released_at is null
      where l.onboarding_state = 'live'
        and l.chat_linked_at is not null
        and l.chat_linked_at < now() - ($1 || ' days')::interval
      group by l.id, l.name, l.chat_linked_at
      order by l.chat_linked_at asc`, [String(days)]);
  return rows;
}

/** Hand a league its passes. Idempotent; re-releasing keeps the first date. */
async function release(leagueId) {
  const { rows } = await db.query(
    `update promo_codes set released_at = coalesce(released_at, now()), updated_at = now()
      where created_by_league_id = $1
      returning *`, [leagueId]);
  return Promise.all(rows.map(async r => publicView(r, await remainingFor(r.code))));
}

/**
 * Who the cohort actually is.
 *
 * The question this whole table exists to answer: which leagues came in on an
 * invite, which came in on somebody else's referral, and which just turned up.
 * A league with no claim is organic, so the absence of a row is meaningful and
 * this is a left join from leagues rather than a select from claims.
 */
async function cohort({ code = null } = {}) {
  const { rows } = await db.query(
    `select l.id, l.name, l.season, l.onboarding_state, l.created_at,
            c.code, c.source, c.state, c.redeemed_at,
            ref.name as referred_by,
            case
              when c.code is null then 'organic'
              when c.source = 'ref' then 'referral'
              else 'invited'
            end as arrival
       from leagues l
       left join promo_claims c on c.league_id = l.id and c.state = 'redeemed'
       left join promo_codes  p on p.code = c.code
       left join leagues    ref on ref.id = p.created_by_league_id
      where ($1::text is null or c.code = $1)
      order by c.redeemed_at desc nulls last, l.created_at desc`,
    [code ? normalize(code) : null]);
  return rows;
}

/** Counts for the operator board: slots gone, slots left, passes handed out. */
async function summary() {
  const { rows } = await db.query(
    `select p.code, p.label, p.discount_type, p.discount_value, p.max_uses,
            p.current_uses, p.is_active, p.valid_until, p.released_at,
            p.created_by_league_id is not null as is_referral,
            (select count(*) from promo_claims c
              where c.code = p.code and c.state = 'reserved'
                and (c.expires_at is null or c.expires_at > now()))::int as reserved
       from promo_codes p
      order by p.created_by_league_id is not null, p.created_at asc`);
  return rows.map(r => ({
    ...r,
    remaining: Math.max(0, r.max_uses - r.current_uses - r.reserved),
  }));
}

module.exports = {
  PILOT_CODE, RESERVATION_DAYS,
  normalize, slugFor, publicView,
  validate, reserve, redeem, remainingFor, seedFor,
  mintFounderPasses, releasedPasses, readyToRelease, release,
  shareFor, cohort, summary,
};
