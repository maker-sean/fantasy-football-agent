-- Where people fall out of the funnel.
--
-- Almost every stage was already reconstructible — codes issued, codes texted,
-- leagues linked, rosters bound, chats confirmed all leave rows behind. Two
-- things did not, and they are the two ends of the most interesting gap.
--
-- WHAT WE DO NOT COLLECT, and why it is worth being deliberate about.
--
-- page_views records a PATH and a TIME. No IP, no cookie, no user agent, no
-- session identifier. That is not squeamishness, it is the cheapest way to stay
-- out of a whole category of obligation: nothing here identifies a person, so
-- there is no consent banner to show, no row to add to the privacy policy's
-- "what we collect" table, and no personal data to honour a deletion request
-- over. The price is that "visits per hour" is answerable and "how many unique
-- people" is not. For finding a drop-off that is the right trade — the shape of
-- the funnel is what matters, not who is in it.
create table if not exists page_views (
  id    bigserial primary key,
  path  text not null,
  at    timestamptz not null default now()
);

-- The only query this table exists to serve is "how many, per hour, recently",
-- so the index is on time and the path comes along for the grouping.
create index if not exists page_views_at_idx on page_views (at desc);

comment on table page_views is
  'Path and timestamp only. Deliberately anonymous — no IP, cookie, user agent or session id — so it is not personal data and needs no consent.';

-- Two timestamps on the signup itself.
--
-- status already said 'invited', but a status is a state and not an event: it
-- cannot answer "how long between texting in and being sent a link", which is
-- the number that says whether the manual invite step is the bottleneck.
--
-- redeemed_at is the one that was genuinely missing. Nothing recorded that a
-- setup link had ever been opened, so the biggest drop in the funnel — invited
-- but never started — was invisible. It doubles as the audit trail the invite
-- token did not have: a link redeemed twice from two places is the only signal
-- that would ever catch a hijacked link.
alter table signups
  add column if not exists invited_at  timestamptz,
  add column if not exists redeemed_at timestamptz,
  add column if not exists redeem_count int not null default 0;

comment on column signups.redeemed_at is
  'First time this signup''s setup link was exchanged for a session. Null means invited but never started, which is the drop-off worth chasing.';
comment on column signups.redeem_count is
  'How many times the link has been exchanged. Climbing well past one is worth a look — see src/onboardlink.js on bearer tokens.';

-- Existing rows that were already invited before this column existed.
update signups set invited_at = updated_at
 where status = 'invited' and invited_at is null;
