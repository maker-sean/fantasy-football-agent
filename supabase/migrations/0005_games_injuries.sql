-- Real kickoff times, and the injury fields needed to warn before them.
--
-- A fixed weekly cron cannot support a pre-kickoff alert. Week 10 of 2025
-- kicked off at 09:30 ET in Berlin, three and a half hours before the "early"
-- Sunday window — and an alert that fires after kickoff is worthless, silently.
-- London, Germany, Thanksgiving, Black Friday, Christmas and late-season
-- Saturdays all break the grid, so timing has to come from the schedule itself.

create table if not exists games (
  id            bigserial primary key,
  espn_id       text not null,
  season        text not null,
  week          integer not null,
  kickoff_at    timestamptz not null,
  home_team     text not null,     -- Sleeper abbreviations, not ESPN's
  away_team     text not null,
  short_name    text,
  state         text not null default 'pre',   -- pre | in | post
  neutral_site  boolean not null default false,
  venue         text,
  updated_at    timestamptz not null default now()
);

create unique index if not exists games_espn_idx on games (espn_id);
create index if not exists games_week_idx on games (season, week, kickoff_at);
create index if not exists games_kickoff_idx on games (kickoff_at) where state = 'pre';

-- Injury status was trimmed out when the 15 MB player feed was slimmed to
-- name/position/team. It is the whole basis of the alert.
alter table players
  add column if not exists injury_status text,
  add column if not exists injury_body_part text,
  add column if not exists player_status text;

create index if not exists players_injury_idx on players (injury_status)
  where injury_status is not null;

-- One alert per player per league-week. Warning the same person about the same
-- player every fifteen minutes is how a genuinely useful feature becomes noise.
create table if not exists injury_alerts (
  id            bigserial primary key,
  league_id     uuid not null references leagues(id) on delete cascade,
  season        text not null,
  week          integer not null,
  roster_id     integer,
  player_id     text not null,
  player_name   text,
  injury_status text,
  kickoff_at    timestamptz,
  sent_at       timestamptz not null default now(),
  detail        jsonb not null default '{}'::jsonb
);

create unique index if not exists injury_alerts_once_idx
  on injury_alerts (league_id, season, week, player_id);
