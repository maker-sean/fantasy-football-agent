-- Short codes for the signup text.
--
-- The first version of this flow asked people to text
-- "START 1400000000000000001". That works when they tap a prefilled link and
-- is hostile every other way: unreadable on a QR, impossible to dictate, and
-- one mistyped digit fails silently against a league that does not exist.
--
-- A four-character code is issued when someone picks their league on the site,
-- so the text becomes "COMMISH 4F2K".

create table if not exists signup_codes (
  code               text primary key,
  sleeper_league_id  text not null,
  league_name        text,
  season             text,
  total_rosters      integer,
  used_at            timestamptz,
  used_by_phone      text,
  created_at         timestamptz not null default now()
);

-- Codes are short, so they must not live forever — the space is small enough
-- that stale codes would eventually collide with live ones.
create index if not exists signup_codes_created_idx on signup_codes (created_at);
