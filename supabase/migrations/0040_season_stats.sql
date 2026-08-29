-- Finished seasons, which cannot change and were being re-downloaded weekly.
--
-- Sleeper serves season stats one POSITION at a time, so a single season costs
-- four calls and five seasons of draft history costs twenty. They were cached
-- in a Map inside the worker — which is thrown away on every deploy and every
-- restart, so the next reply after a deploy paid all twenty again.
--
-- A COMPLETED season is immutable. 2021's final points were fixed in January
-- 2022 and no amount of re-fetching will change them, so they belong in a table.
-- The CURRENT season deliberately does not live here: it moves every week, and a
-- stale row would be worse than the call.
create table if not exists season_stats (
  season       text not null,
  scoring      text not null,
  player_id    text not null,
  position     text,
  rank         integer,
  points       numeric,
  games_played integer,
  name         text,
  primary key (season, scoring, player_id)
);
