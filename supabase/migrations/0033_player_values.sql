-- Community trade values, dated, from a source we do not control.
--
-- WHY A SOURCE COLUMN ON DAY ONE. The values behind this are KeepTradeCut's,
-- and KTC's terms forbid reproducing them in a tool. Sean's call to use them
-- anyway is a defensible one TODAY — nobody pays, three leagues of friends,
-- nothing is redistributed — and it stops being defensible the moment a
-- customer does. So the source is a column rather than an assumption, and
-- swapping it later is a new value of an existing field instead of a migration
-- under time pressure.
--
-- WHY DATED ROWS RATHER THAN CURRENT VALUES. Nobody sells a KTC value series,
-- and one is worth more than any single day's snapshot: it is what makes "he
-- was worth more in June" answerable. Storing a row per player per day builds
-- that series from nothing, and it belongs to us in a way the source never
-- will. A past date is never overwritten.
--
-- WHAT THIS IS NOT FOR. Retrospective trade grading already works off actual
-- points scored — see src/trades.js, which revisits three weeks later. What
-- players DID beats what a crowd guessed they were worth. These values answer
-- the other question: is a trade being proposed right now fair.
create table if not exists player_values (
  id           uuid primary key default gen_random_uuid(),

  -- 'ktc' today. The whole reason this column exists is that it will not be.
  source       text not null,
  captured_on  date not null,

  -- The join to everything else. Nullable because a source will always carry
  -- somebody we cannot map, and a row we can price but not identify is still
  -- worth keeping — it is evidence the crosswalk needs work.
  sleeper_id   text,

  -- Denormalised on purpose: the source's own spelling, kept verbatim, so a
  -- failed join can be diagnosed from this table alone rather than by
  -- re-fetching a sheet that has since changed.
  name         text not null,
  position     text,
  team         text,
  age          numeric(4,1),
  is_rookie    boolean,

  -- The same player has eight different values depending on league settings,
  -- and they are not derivable from one another without KTC's formula. All of
  -- them are stored; the league picks.
  superflex    boolean not null default false,
  tep          text not null default 'none'
               check (tep in ('none', 'te+', 'te++', 'te+++')),

  value        integer not null,
  pos_rank     text,

  created_at   timestamptz not null default now(),

  -- One row per player, per settings combination, per day, per source.
  unique (source, captured_on, name, superflex, tep)
);

create index if not exists player_values_lookup_idx
  on player_values (sleeper_id, captured_on desc) where sleeper_id is not null;
create index if not exists player_values_day_idx
  on player_values (source, captured_on desc);

comment on table player_values is
  'Dated community trade values. Source is a column because the current one cannot be used commercially; retrospective grading uses actual points, not these.';
comment on column player_values.captured_on is
  'The day the value was observed. Past dates are never overwritten — the series is the asset.';
