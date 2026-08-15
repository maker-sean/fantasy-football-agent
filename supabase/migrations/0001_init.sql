-- Phase 1 schema: chat log + immutable snapshot store + league registry.
--
-- Two decisions carried over from the Milestone 0 findings:
--
-- 1. Identity anchors on normalized E.164, NOT a provider contact id. Blooio
--    minted two contact_ids for the same human in one group; provider handles
--    are disposable, phone numbers are the stable key we control.
-- 2. Snapshots are insert-only. A lineup captured at kickoff cannot be
--    reconstructed later, so a re-run must never overwrite the original.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- leagues --
create table if not exists leagues (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  sleeper_league_id text,
  provider          text not null default 'sendblue',
  chat_id           text,          -- provider group id (e.g. sb_group_...)
  from_number       text,          -- the line this league's bot sends from
  config            jsonb not null default '{}'::jsonb,
  active            boolean not null default true,
  created_at        timestamptz not null default now()
);

-- One league per provider thread. Inbound routing resolves on this.
create unique index if not exists leagues_provider_chat_idx
  on leagues (provider, chat_id) where chat_id is not null;

create index if not exists leagues_sleeper_idx
  on leagues (sleeper_league_id) where sleeper_league_id is not null;

-- ---------------------------------------------------------------- members --
create table if not exists members (
  id               uuid primary key default gen_random_uuid(),
  league_id        uuid not null references leagues(id) on delete cascade,
  phone            text,           -- normalized E.164 — the identity anchor
  sleeper_user_id  text,
  sleeper_roster_id integer,
  display_name     text,
  is_bot           boolean not null default false,
  created_at       timestamptz not null default now()
);

-- Same human must not appear twice in one league, whatever the provider says.
create unique index if not exists members_league_phone_idx
  on members (league_id, phone) where phone is not null;

create unique index if not exists members_league_sleeper_idx
  on members (league_id, sleeper_user_id) where sleeper_user_id is not null;

-- --------------------------------------------------------------- messages --
create table if not exists messages (
  id                  bigserial primary key,
  league_id           uuid references leagues(id) on delete set null,
  provider            text not null,
  provider_message_id text,
  direction           text not null check (direction in ('inbound', 'outbound')),
  chat_id             text,
  sender_phone        text,
  is_group            boolean not null default false,
  protocol            text,        -- imessage | sms | rcs | pending | unknown
  body                text,
  raw                 jsonb not null default '{}'::jsonb,
  occurred_at         timestamptz not null default now(),
  created_at          timestamptz not null default now()
);

-- Webhooks retry. Without this, one reply becomes three rows and every
-- engagement metric in Phase 2 is inflated.
create unique index if not exists messages_provider_msgid_idx
  on messages (provider, provider_message_id) where provider_message_id is not null;

create index if not exists messages_league_time_idx
  on messages (league_id, occurred_at desc);

create index if not exists messages_chat_time_idx
  on messages (chat_id, occurred_at desc);

-- -------------------------------------------------------------- snapshots --
-- The irreplaceable artifact. A Week 3 lineup not captured at kickoff is gone.
create table if not exists snapshots (
  id          bigserial primary key,
  league_id   uuid not null references leagues(id) on delete cascade,
  season      text not null,
  week        integer not null,
  kind        text not null,       -- lock_thu | lock_sun_early | lock_sun_late | lock_mon | postscore | daily
  captured_at timestamptz not null default now(),
  payload     jsonb not null
);

-- Insert-only: a retry must not clobber the original capture.
create unique index if not exists snapshots_unique_idx
  on snapshots (league_id, season, week, kind);

create index if not exists snapshots_league_week_idx
  on snapshots (league_id, season, week);

-- ---------------------------------------------------------------- players --
-- Slimmed from Sleeper's ~15 MB dump. Refreshed daily, never per-request.
create table if not exists players (
  player_id   text primary key,
  full_name   text,
  position    text,
  team        text,
  updated_at  timestamptz not null default now()
);

-- ------------------------------------------------------------- job_runs ----
-- Did the kickoff snapshot actually fire? Answering that after the fact is
-- the difference between "we have Week 3" and "we think we have Week 3."
create table if not exists job_runs (
  id          bigserial primary key,
  job         text not null,
  status      text not null check (status in ('ok', 'error', 'skipped')),
  detail      jsonb not null default '{}'::jsonb,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists job_runs_job_time_idx on job_runs (job, started_at desc);
