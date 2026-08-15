-- Recaps wait for a human before they reach a league.
--
-- The verifier blocks invented numbers, but it cannot judge a ranking claim —
-- a real generated recap once called the week's NARROWEST margin "the only game
-- decided by a real margin," and every figure in it was correct. Only a person
-- catches that, so the first weeks go through one.

create table if not exists recap_drafts (
  id            bigserial primary key,
  league_id     uuid not null references leagues(id) on delete cascade,
  season        text not null,
  week          integer not null,
  kind          text not null default 'recap',

  body          text not null,
  facts         jsonb not null default '{}'::jsonb,
  verification  jsonb not null default '{}'::jsonb,
  model         text,

  status        text not null default 'pending'
                check (status in ('pending', 'approved', 'sent', 'rejected', 'expired')),

  created_at    timestamptz not null default now(),
  -- A recap approved Thursday for Tuesday's games is worse than no recap.
  expires_at    timestamptz not null,
  decided_at    timestamptz,
  decided_by    text,
  sent_message_id text
);

-- One live draft per league-week. A re-run of the job must not queue a second
-- copy of the same recap for approval.
create unique index if not exists recap_drafts_week_idx
  on recap_drafts (league_id, season, week, kind)
  where status in ('pending', 'approved', 'sent');

create index if not exists recap_drafts_pending_idx
  on recap_drafts (league_id, status, created_at desc);
