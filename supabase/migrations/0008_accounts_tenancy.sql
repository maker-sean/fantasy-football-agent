-- Multi-tenancy. The one change that cannot be retrofitted cheaply.
--
-- Every table before this assumed a single operator. The moment a second
-- commissioner signs up, any query without a tenant scope returns someone
-- else's league — and the failure is silent, which is the worst kind.
--
-- Shape: one account per login (email), many leagues per account, one
-- subscription per league. A commissioner running three leagues logs in once
-- and is billed three times, which is what Stripe's customer/subscription model
-- already expresses: one Customer, N Subscriptions.

create table if not exists accounts (
  id                 uuid primary key default gen_random_uuid(),
  email              text not null,
  -- Supabase Auth's `sub`. Nullable because an account can exist before its
  -- first login (a signup that paid, an operator-created bootstrap row).
  auth_user_id       uuid unique,
  display_name       text,

  -- Consent is versioned. "They accepted the terms" is not a useful record if
  -- you cannot say which terms, and A2P reviewers do ask.
  terms_accepted_at  timestamptz,
  terms_version      text,

  -- The card lives at Stripe. This is an opaque handle and the only billing
  -- identifier that ever touches this database — no PAN, no last4, no expiry.
  stripe_customer_id text unique,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Case-insensitive uniqueness without requiring the citext extension.
create unique index if not exists accounts_email_idx on accounts (lower(email));

alter table leagues add column if not exists account_id uuid references accounts(id) on delete cascade;

-- Onboarding is a resumable state machine, not a wizard held in browser memory.
-- People pay, close the tab, and come back tomorrow; without persisted state
-- they start over, and half of them do not.
--
--   draft -> league_linked -> members_bound -> awaiting_chat -> live
--
-- `awaiting_chat` is the one that matters: the commissioner has to add the
-- number to their group chat, and the only way to know it worked is to receive
-- a message from it. That screen holds until the poller confirms receipt.
alter table leagues add column if not exists onboarding_state text not null default 'live';
alter table leagues add column if not exists chat_linked_at timestamptz;

-- Sleeper issues a NEW league id every season and links the old one via
-- previous_league_id. Without carrying that, every onboarded league silently
-- breaks the following August.
alter table leagues add column if not exists season text;
alter table leagues add column if not exists previous_sleeper_league_id text;

create index if not exists leagues_account_idx on leagues (account_id);
create index if not exists leagues_onboarding_idx on leagues (onboarding_state)
  where onboarding_state <> 'live';

-- Billing is per league, deliberately. A commissioner with three leagues pays
-- three times, and one lapsing must not silence the other two.
create table if not exists subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  league_id              uuid not null unique references leagues(id) on delete cascade,
  account_id             uuid not null references accounts(id) on delete cascade,
  stripe_subscription_id text unique,
  -- none | trialing | active | past_due | canceled
  -- Written from Stripe webhooks, never from a browser redirect: people close
  -- the tab before the redirect fires, and the webhook is the only source that
  -- always arrives.
  status                 text not null default 'none',
  current_period_end     timestamptz,
  season                 text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists subscriptions_account_idx on subscriptions (account_id);

-- Adopt everything that already exists into a bootstrap account, so the running
-- worker keeps operating and nothing is orphaned by this migration.
insert into accounts (email, display_name, terms_accepted_at, terms_version)
values ('seanmihm@gmail.com', 'Bootstrap (pre-accounts)', now(), 'bootstrap')
on conflict (lower(email)) do nothing;

update leagues
   set account_id = (select id from accounts where lower(email) = 'seanmihm@gmail.com')
 where account_id is null;
