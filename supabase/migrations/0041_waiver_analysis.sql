-- What a season's waiver wire was worth, computed once.
--
-- The analysis needs every week's transactions, which is eighteen Sleeper calls
-- per season. Doing that per question would reintroduce the exact cost that was
-- just taken out of the reply path — 55 calls a reply down to 7 — for a feature
-- nobody asks about more than a few times a year.
--
-- A FINISHED season cannot change: the claims were made, the points were
-- scored. The current season can, so it is stored with its week and recomputed
-- once the season moves past it.
create table if not exists waiver_analysis (
  sleeper_league_id text not null,
  season            text not null,
  through_week      integer not null,
  result            jsonb not null,
  computed_at       timestamptz not null default now(),
  primary key (sleeper_league_id, season)
);
