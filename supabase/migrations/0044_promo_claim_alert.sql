-- Which held slots the operator has already been told about.
--
-- A reservation holds one of fifty pilot slots for a fortnight whether or not
-- the person ever texts their code in, and it expires quietly on its own. That
-- is the right behaviour — a slot should come back by going stale rather than
-- by anything having to run — but it means an abandoned form is invisible: the
-- cohort fills faster than leagues actually arrive and nothing says why.
--
-- So a daily check reports claims that have gone quiet. Once each, not daily
-- forever: an alert that repeats trains the one person who can act on it to
-- ignore it, which is the same reasoning that keeps signup.record() from
-- announcing a retry as a second lead.
alter table promo_claims add column if not exists alerted_at timestamptz;

comment on column promo_claims.alerted_at is
  'When the operator was told this reservation had gone quiet. Null = not yet reported.';

create index if not exists promo_claims_quiet_idx
  on promo_claims (created_at)
  where state = 'reserved' and alerted_at is null;
