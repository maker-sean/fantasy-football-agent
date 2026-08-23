-- Who they are, and where they want the bot.
--
-- The waitlist recorded a phone, a league and a timestamp. That is enough to
-- text somebody a setup link and nothing else: no way to reach them when the
-- product ships something, and no way to tell which platform to build for next.
--
-- Asked at signup because that is the moment somebody is most willing to
-- answer — they have just chosen to be here, and every later moment is an
-- interruption.
--
-- PLATFORM IS THE ONE THAT CHANGES WHAT GETS BUILT. Onboarding runs over SMS
-- because that is what works today, and somebody answering "Discord" is not
-- confused about that; they are saying where their league actually lives. A
-- waitlist sorted by platform is a build order.
alter table signups
  add column if not exists first_name     text,
  add column if not exists last_name      text,
  -- imessage | messenger | whatsapp | groupme | discord | other
  add column if not exists platform       text,
  -- Free text when they picked other. Kept verbatim: the whole value of an
  -- "other" box is the answer nobody predicted.
  add column if not exists platform_other text;

comment on column signups.platform is
  'Where they want the bot, which is not the same as where onboarding happens. Sorting the waitlist by this is a build order.';
comment on column signups.platform_other is
  'Verbatim. The value of an other box is the answer nobody thought to list.';

create index if not exists signups_platform_idx on signups (platform) where platform is not null;
