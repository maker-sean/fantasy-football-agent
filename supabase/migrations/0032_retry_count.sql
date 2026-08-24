-- How many times this message has already been tried.
--
-- A retry is a NEW send_log row, and the sweep only ever looks at rows whose
-- delivery is still null — so once a row is reconciled it is never revisited
-- and the attempt count could not be read off the table. is_retry answered
-- "is this a retry" and nothing answered "the how-manyth".
--
-- That was fine while the budget was one. The group transport failure it exists
-- for FLAPS rather than fails: on 2026-08-24 a league's sends failed 5504 at
-- 01:45, 01:48 and 01:54 with one going through cleanly at 01:51. One retry is
-- the right shape and the wrong number against a roughly even success rate.
--
-- Carried forward from the parent when a retry is sent, so the chain is bounded
-- however many rows it spans. Age still does the real limiting: a reply landing
-- a few minutes late is worth having, one landing an hour later drops into a
-- conversation that has moved on.
alter table send_log
  add column if not exists retry_count int not null default 0;

comment on column send_log.retry_count is
  'Attempts already spent on this message, carried across retry rows. is_retry says whether this row IS one; this says how many came before it.';
