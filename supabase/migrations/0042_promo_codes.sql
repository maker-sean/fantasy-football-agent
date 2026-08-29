-- Promo codes, and the slots they hand out.
--
-- WHAT THIS DOES NOT DO: charge anybody. There is no Stripe integration in this
-- codebase — website/index.html says so in as many words, and subscriptions
-- .stripe_subscription_id has never been written. So a row here is a RECORDED
-- PROMISE, not a discount applied at a till. It says what a league was offered
-- and what they accepted, so that whenever billing does land, the entitlement
-- is already sitting here with a date on it rather than being reconstructed
-- from memory and a Reddit thread.
--
-- That is also why discount_value is stored rather than a price. A price would
-- be a second place for "$60" to live and a second place for it to go stale.
--
-- TWO COUNTERS, NOT ONE. The spec asked for current_uses against max_uses, and
-- that alone cannot hold a cap open across this funnel. Somebody who fills in
-- the start page is not onboarded — they get a four character code, text it in,
-- and an operator invites them (src/invites.js). The league goes live later,
-- from a real message arriving in the group chat (src/chatlink.js). Counting at
-- the front oversells the cohort to anyone who abandons the form; counting only
-- at the back means fifty-one people can all be told they got the last slot.
--
-- So a claim is RESERVED when the form is filled in and REDEEMED when the
-- league goes live, and the cap counts both. A reservation that never turns
-- into a league expires and returns the slot.
create table if not exists promo_codes (
  code                text primary key,
  -- percentage | fixed_amount | full_free
  discount_type       text not null
    check (discount_type in ('percentage', 'fixed_amount', 'full_free')),
  -- 100 for free, 50 for half off, 30 for a flat thirty dollars. Read against
  -- discount_type and meaningless without it.
  discount_value      numeric not null check (discount_value >= 0),
  max_uses            integer not null check (max_uses > 0),
  -- Committed redemptions only: leagues that actually went live. Reservations
  -- are counted from promo_claims, so this never has to be walked back when
  -- somebody abandons the form.
  current_uses        integer not null default 0 check (current_uses >= 0),
  valid_until         timestamptz,
  -- Which league earned the right to hand this out. Null for codes we minted
  -- ourselves, like the Reddit cohort.
  created_by_league_id uuid references leagues(id) on delete set null,
  is_active           boolean not null default true,
  -- Free text for the operator board: "Reddit pilot cohort", "founder pass".
  label               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists promo_codes_creator_idx
  on promo_codes (created_by_league_id) where created_by_league_id is not null;

-- One row per attempt to use a code.
--
-- Separate from a counter on promo_codes because the counter answers "are there
-- slots left" and this answers "who, and when, and did it stick" — which is the
-- entire point of a referral loop. Without it, a founder pass that gets
-- redeemed is indistinguishable from one that was never sent.
create table if not exists promo_claims (
  id           uuid primary key default gen_random_uuid(),
  code         text not null references promo_codes(code) on delete cascade,
  -- THE JOIN KEY, and the only one present at every step.
  --
  -- A claim is made on the start page and settled when the league goes live,
  -- and almost nothing survives that trip. There is no signups row yet at the
  -- start page — that appears when they text the four character code in — and
  -- no league row until they finish onboarding days later. The Sleeper league
  -- id is the one identifier the start page, the texted signup and the live
  -- league all carry, so it is what the claim is anchored to.
  sleeper_league_id text not null,
  -- The four character code the start page issued, for tracing one specific
  -- visit when two people from the same league both filled in the form.
  signup_code  text,
  -- Filled in as they appear, for the operator board. Neither is the join key.
  signup_id    uuid references signups(id) on delete set null,
  league_id    uuid references leagues(id) on delete set null,
  email        text,
  -- Which door they came through: a ?promo= link (the Reddit post), a ?ref=
  -- link (another commissioner's founder pass), or an operator typing it in.
  --
  -- This is the column that answers "who are my fifty, as opposed to everyone
  -- who happened to sign up that month". A league with no row in this table at
  -- all is organic — including the twenty-three that predate the pilot.
  source       text not null default 'promo'
    check (source in ('promo', 'ref', 'manual')),
  -- reserved | redeemed | released
  state        text not null default 'reserved'
    check (state in ('reserved', 'redeemed', 'released')),
  -- A reservation holds a slot only for so long. Null once redeemed.
  expires_at   timestamptz,
  redeemed_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- A league redeems at most one code, whatever it clicked on the way in.
create unique index if not exists promo_claims_league_idx
  on promo_claims (league_id) where league_id is not null and state = 'redeemed';

-- One live reservation per Sleeper league, so a refreshed start page — or the
-- co-commissioner filling the form in again — is a retry rather than a second
-- slot off a pile of fifty.
create unique index if not exists promo_claims_reserved_idx
  on promo_claims (sleeper_league_id) where state = 'reserved';

create index if not exists promo_claims_code_state_idx on promo_claims (code, state);

-- The Reddit pilot cohort.
--
-- max_uses is the promise made in the post: fifty leagues, free for the 2026
-- season. It counts REDEMPTIONS OF THIS CODE and not leagues in the table —
-- there are already twenty-three live leagues that predate the pilot and never
-- saw the post, and counting them would close the cohort at twenty-seven.
insert into promo_codes (code, discount_type, discount_value, max_uses, valid_until, label)
values ('REDDIT50', 'full_free', 100, 50, '2027-02-15T00:00:00Z', 'Reddit pilot cohort — free 2026 season')
on conflict (code) do nothing;
