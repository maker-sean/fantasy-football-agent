-- Has this league's trade history been pulled in yet.
--
-- The obvious check — "does this league have any trades on file" — is wrong in
-- both directions. Trades attach to the ARCHIVE row for the season they
-- happened in, each of which carries that season's own Sleeper id, so a lookup
-- by the current id sees only this year. And a league that has genuinely never
-- traded would look un-backfilled forever, re-walking seven years of
-- transactions every night to find the same nothing.
--
-- A timestamp says what actually happened: the walk ran. Zero trades is a
-- finding, not a reason to run it again.
alter table leagues
  add column if not exists trades_backfilled_at timestamptz;

comment on column leagues.trades_backfilled_at is
  'When the whole-history trade walk last ran. Null means never; a league with no trades still gets a timestamp.';
