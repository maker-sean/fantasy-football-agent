-- An account can be anchored to a phone instead of an email.
--
-- The signup funnel collects a PHONE. Someone texts COMMISH from a number
-- Sendblue verified, and that is the strongest identity claim this system ever
-- receives — stronger than an emailed magic link, which proves only that
-- somebody can read an inbox. But accounts.email was NOT NULL, so the person
-- who just proved themselves could not be given an account without inventing an
-- address for them.
--
-- Which is how the funnel ended up dead-ending. /app/ requires an account, an
-- account required an email, and the only way to get one was a magic link
-- delivered over SMTP that has never successfully sent in production. The fix
-- is not more email. It is to let the channel that already works carry the
-- identity it already proved.
--
-- signups solved this exact problem first — it takes a phone or an email and
-- has two partial unique indexes rather than one, because either contact may be
-- absent. This mirrors that, deliberately, so the two tables reason about
-- identity the same way.

alter table accounts alter column email drop not null;
alter table accounts add column if not exists phone text;

-- The old index covered every row, which is fine while email is mandatory and
-- wrong the moment it is not: many phone-only accounts would all collide on
-- lower(null). Partial, so nulls simply do not participate.
drop index if exists accounts_email_idx;
create unique index if not exists accounts_email_idx
  on accounts (lower(email)) where email is not null;

create unique index if not exists accounts_phone_idx
  on accounts (phone) where phone is not null;

-- An account with neither contact is unreachable and unrecoverable: nothing
-- could ever sign in to it, and no support path could prove ownership. Better
-- to refuse the row than to create one nobody can ever get back into.
alter table accounts drop constraint if exists accounts_has_a_contact;
alter table accounts add constraint accounts_has_a_contact
  check (email is not null or phone is not null);

comment on column accounts.phone is
  'Normalized E.164, set when the account was created from a texted signup. The identity anchor for anyone who arrived by SMS — see 0004_identity_binding.sql for why the transport is trusted over what someone typed.';
