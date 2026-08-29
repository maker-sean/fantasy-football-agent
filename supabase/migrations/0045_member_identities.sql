-- Who a person is on the transport they actually use.
--
-- members.phone has been THE identity anchor since 0001_init.sql, and
-- 0004_identity_binding.sql argues for why: a number is verified by the
-- transport rather than typed by a third party, and Blooio had already minted
-- two contact ids for one human in a single group. That reasoning is right and
-- this does not undo it. It generalises it.
--
-- The anchor was never really "a phone number". It was "the id the transport
-- proves, rather than a name somebody typed". On SMS that is an E.164 number.
-- On Discord it is a snowflake. Same property, different alphabet — and a
-- snowflake cannot go in the phone column, because db.normalizePhone would
-- turn a numeric id into a plausible-looking "+1..." that matches nothing and
-- looks correct in every log.
--
-- ADDITIVE ON PURPOSE. members.phone stays exactly where it is and keeps
-- working; twenty-three live leagues and every query in src/claims.js,
-- src/ballots.js and src/invites.js depend on it. A row here is written
-- alongside it, so the two agree for SMS and only this table has anything to
-- say about Discord. Backfilled below, so it is true for existing leagues from
-- the moment it exists rather than only for whoever signs up next.
create table if not exists member_identities (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references members(id) on delete cascade,
  -- 'sendblue' | 'discord'. Matches leagues.provider, deliberately: resolving a
  -- sender means asking "who is this id, on this provider".
  provider    text not null,
  -- E.164 for sms, a snowflake for discord. Opaque here — normalising is the
  -- provider's job, and doing it in one place for both is how they get mixed up.
  external_id text not null,
  -- What their league calls them on that platform: a Discord server nickname,
  -- or null for SMS where there is nothing to read a name from.
  handle      text,
  created_at  timestamptz not null default now(),

  -- One person per id per provider. The constraint the whole table exists for:
  -- two rows claiming the same Discord user in one league is the two-contact-ids
  -- bug 0001_init.sql was written about, in a new alphabet.
  unique (provider, external_id, member_id)
);

-- Inbound resolution: "a message from this id on this provider" -> member.
create index if not exists member_identities_lookup_idx
  on member_identities (provider, external_id);

create index if not exists member_identities_member_idx
  on member_identities (member_id);

-- Every phone already bound becomes a sendblue identity, so the new table is
-- complete rather than only forward-looking. Re-runnable.
insert into member_identities (member_id, provider, external_id)
select m.id, 'sendblue', m.phone
  from members m
 where m.phone is not null
on conflict (provider, external_id, member_id) do nothing;
