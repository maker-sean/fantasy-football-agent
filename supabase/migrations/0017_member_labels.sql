-- Three different names were sharing one column, and the nightly job kept winning.
--
-- members.display_name was meant to be the HUMAN: "Marcus". But members:sync
-- calls bindMember once a night with rosterOwners().displayName, which resolves
-- to metadata.team_name — so the commissioner types "Marcus", and by morning
-- the bot is calling him "Big Yardage". Every recap, every alert, every roll call.
-- The league in this database is currently storing "Punt Intended" and
-- "Ruiz's Onside Bandits" as people's names for exactly this reason.
--
-- The fix is not to make the job gentler. It is that these are three facts, not
-- one, and they have three different owners:
--
--   display_name      the human. A person typed it. Nothing automatic may write it.
--   sleeper_username  Sleeper's account name — gowreckers42, tdermott96. Stable,
--                     refreshed by the sync, and the only durable way to tell
--                     two rosters apart when the team names are jokes.
--   team_name         whatever they have called their team this week. Cosmetic,
--                     changes mid-season, refreshed by the sync.
--
-- Once they are separate columns the job can refresh what it owns on every run
-- and never touch what a person entered.

alter table members
  add column if not exists sleeper_username text,
  add column if not exists team_name        text;

comment on column members.display_name is
  'The human. Entered by a commissioner or claimed in chat. NEVER written by members:sync — that is what clobbered it before.';
comment on column members.sleeper_username is
  'Sleeper account name. Refreshed from Sleeper; the durable label when team names are jokes.';
comment on column members.team_name is
  'Current Sleeper team name. Cosmetic and changes mid-season.';

-- The rows already carrying a team name in the human field.
--
-- Copied ACROSS rather than cleared: it is the only label those rosters have
-- until someone types a real name, and a blank roster row in the onboarding
-- form is harder to match to a person than a wrong-but-familiar one. The
-- commissioner overwrites display_name in the form; team_name keeps the value
-- either way.
update members set team_name = display_name
 where team_name is null and display_name is not null;

-- A member is a person on a roster, and a roster may now hold more than one.
--
-- Co-owners are common in real leagues and Sleeper does not model them for this
-- league — co_owners comes back empty — so a second owner is ours to record: a
-- row sharing sleeper_roster_id, with its own phone and its own name, and a
-- NULL sleeper_user_id because Sleeper has no account to point at.
--
-- No new constraint is needed and that is worth stating explicitly rather than
-- leaving to be rediscovered: members_league_sleeper_idx is PARTIAL, on
-- (league_id, sleeper_user_id) WHERE sleeper_user_id IS NOT NULL, so any number
-- of NULL rows already coexist. members_league_phone_idx still holds one phone
-- to one member, which is the rule that actually matters.
create index if not exists members_league_roster_idx
  on members (league_id, sleeper_roster_id) where sleeper_roster_id is not null;
