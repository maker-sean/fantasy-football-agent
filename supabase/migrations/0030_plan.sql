-- Season or dynasty, captured where the choice is actually made.
--
-- Both pricing tiles had a Start trial button and both pointed at the same
-- page, which never asked. So a visitor made a real decision — one of them
-- costs $8 a manager and runs all twelve months — and the funnel dropped it on
-- the floor. There was no way to answer "do people pick dynasty", which is the
-- question that decides whether the offseason features are worth building.
--
-- On BOTH tables for the same reason the profile is: the signup row does not
-- exist when somebody is standing on the code screen, so the answer rides on
-- the code and is copied across on redemption.
alter table signups
  add column if not exists plan text
  check (plan is null or plan in ('season', 'dynasty'));

alter table signup_codes
  add column if not exists plan text
  check (plan is null or plan in ('season', 'dynasty'));

create index if not exists signups_plan_idx on signups (plan) where plan is not null;

comment on column signups.plan is
  'season | dynasty. Nullable because every signup before 2026-08-23 predates the question, and a default would invent an answer nobody gave.';
