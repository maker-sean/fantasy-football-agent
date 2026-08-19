-- An email path alongside the texted signup.
--
-- Two reasons, and the second matters more than it looks.
--
-- Capacity: the messaging plan caps contacts, so an SMS-only funnel starts
-- failing at exactly the moment a launch starts working — silently, from the
-- visitor's side. Email has no such ceiling and no carrier in the path.
--
-- Reach: a real share of people will not text an unknown number from a website
-- they just met, but will leave an email. Those are not lost leads, they are a
-- different risk appetite.

alter table signups alter column phone drop not null;
alter table signups add column if not exists email text;

-- One row per contact per league, whichever contact they gave.
drop index if exists signups_phone_league_idx;
create unique index if not exists signups_phone_league_idx
  on signups (phone, coalesce(sleeper_league_id, '')) where phone is not null;
create unique index if not exists signups_email_league_idx
  on signups (lower(email), coalesce(sleeper_league_id, '')) where email is not null;

-- A signup with neither is not a signup.
alter table signups drop constraint if exists signups_has_contact;
alter table signups add constraint signups_has_contact
  check (phone is not null or email is not null);
