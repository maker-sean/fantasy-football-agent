-- Identity bindings are write-once.
--
-- A phone number is the only thing we can actually verify about a person — it
-- comes from the transport, not from what they typed. Which team that phone
-- belongs to is a CLAIM, and in a group chat anyone can make it: the same
-- number in this league said "This is Marcus" on 12 Aug and "this is Sean" on
-- 16 Aug. If the last claim wins, one member can take over another's identity
-- and the bot will confidently attribute the wrong team, record, and history.
--
-- So: the team binding is set once and then locked. Changing it is a
-- commissioner action, recorded with who did it and why. A display NAME stays
-- freely editable — "Marcus" to "Marc" is cosmetic and carries no authority.

alter table members
  add column if not exists bound_at    timestamptz,
  add column if not exists bound_by    text,     -- 'cli' | 'rollcall' | 'commissioner' | phone
  add column if not exists bound_via   text,     -- how the claim was made
  add column if not exists locked      boolean not null default true;

-- Existing rows were bound manually before this rule existed.
update members
   set bound_at = coalesce(bound_at, created_at),
       bound_by = coalesce(bound_by, 'cli'),
       bound_via = coalesce(bound_via, 'manual')
 where sleeper_user_id is not null;

-- Every attempt to claim an identity, accepted or not.
--
-- The rejections are the interesting rows: a second person claiming a team that
-- is already taken is either a mistake worth correcting or someone testing what
-- the bot will believe. Both are worth being able to see.
create table if not exists identity_claims (
  id             bigserial primary key,
  league_id      uuid references leagues(id) on delete cascade,
  phone          text,
  claimed_text   text,
  matched_user   text,
  matched_team   text,
  outcome        text not null
                 check (outcome in ('bound', 'rejected_phone_taken', 'rejected_team_taken',
                                    'rejected_no_match', 'ambiguous', 'rebound_by_commissioner')),
  detail         jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

create index if not exists identity_claims_league_idx on identity_claims (league_id, created_at desc);
create index if not exists identity_claims_outcome_idx on identity_claims (outcome);
