-- Can the bot actually answer questions about this league, checked BEFORE the
-- setup link goes out.
--
-- On 2026-08-23 the bot sat in a thirteen-person group chat with six seasons
-- indexed and told everyone "No league data has been captured yet", because
-- leagueContext returned early for a live league with no snapshot of its own
-- and the archive rows hung below that return. Invisible in the code, obvious
-- in one query against the running system.
--
-- The next league is a stranger's. There is no second first impression, so the
-- query runs before the invite rather than after the complaint.
--
-- A TABLE, not a column on signups. The answers are the artifact: the point is
-- reading what the bot actually said about somebody's league and deciding it is
-- good enough, and that is worth keeping per attempt so two runs can be
-- compared after an ingest is fixed.
create table if not exists preflight_runs (
  id                uuid primary key default gen_random_uuid(),
  signup_id         uuid references signups(id) on delete cascade,
  sleeper_league_id text,

  -- running -> passed | thin | failed. `thin` is a real league with no
  -- completed seasons: nothing is broken, there is simply nothing historical to
  -- say, and whether that is invitable is a judgement the operator makes rather
  -- than one this table makes for them.
  status            text not null default 'running'
                    check (status in ('running', 'passed', 'thin', 'failed')),

  seasons_found     int not null default 0,
  seasons_captured  int not null default 0,
  seasons_failed    int not null default 0,

  -- The provisional archive row the context was built against. provider =
  -- 'archive' on purpose: liveLeagueBySleeperId filters those out, so a
  -- pre-flight can never make a league look already-onboarded and lock its real
  -- commissioner out of the setup flow.
  league_id         uuid references leagues(id) on delete set null,

  -- The fact sheet as it stood, stored next to the answers for the same reason
  -- scripts/ask.js prints them together: an answer you cannot check against the
  -- facts it was given is not evidence of anything.
  context_block     text,
  context_chars     int not null default 0,

  -- [{ question, answer, ms, error }] in the order asked.
  questions         jsonb not null default '[]'::jsonb,

  error             text,
  by_email          text,
  started_at        timestamptz not null default now(),
  finished_at       timestamptz
);

create index if not exists preflight_signup_idx
  on preflight_runs (signup_id, started_at desc);

comment on table preflight_runs is
  'Ran before a setup link is sent. Gates invites.send(), so the button, the INVITE text and the CLI cannot each decide separately whether the check mattered.';
comment on column preflight_runs.status is
  'thin means a real league with no completed seasons — invitable with an explicit override, not a failure.';
