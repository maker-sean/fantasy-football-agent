-- Early-access signups arriving by text.
--
-- The website's "get started" flow ends in a text message rather than an email
-- form, for two reasons. The product cannot self-serve provision anyone yet —
-- the messaging plan caps contacts and carrier registration is not complete —
-- so the honest endpoint is a queue. And for a texting product, a phone number
-- attached to a validated Sleeper league is a far better lead than an email
-- address, arriving over infrastructure that is already deployed and running.

create table if not exists signups (
  id                 uuid primary key default gen_random_uuid(),
  phone              text not null,
  sleeper_league_id  text,
  -- Resolved from Sleeper after the fact, so a typo'd id is visible rather than
  -- silently sitting in the queue looking valid.
  league_name        text,
  season             text,
  total_rosters      integer,
  status             text not null default 'new',   -- new | contacted | onboarded | declined
  source             text not null default 'sms',
  raw_text           text,
  -- Deliberately not a foreign key to messages: Supabase's realtime schema also
  -- defines a `messages` table, so an unqualified reference is ambiguous and
  -- fails to create. The phone and raw text are enough to find the original.
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- One signup per phone per league. Texting START twice is a retry, not a
-- duplicate lead.
create unique index if not exists signups_phone_league_idx
  on signups (phone, coalesce(sleeper_league_id, ''));

create index if not exists signups_status_idx on signups (status, created_at desc);
