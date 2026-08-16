-- Numbers that asked us to stop.
--
-- The messaging provider already suppresses these at its own layer, so an
-- outbound to an opted-out number is blocked before it leaves. This table
-- exists anyway for three reasons: we should know, without asking a vendor;
-- the knowledge has to survive changing providers, since a suppression list
-- held only by Sendblue would be lost on migration; and a carrier reviewer
-- asking "how do you honour opt-outs" deserves a better answer than "our
-- vendor does it".

create table if not exists suppressions (
  phone        text primary key,
  reason       text not null default 'stop',
  raw_text     text,
  provider     text,
  opted_out_at timestamptz not null default now(),
  -- Set rather than deleted when someone opts back in, so the history of a
  -- number saying no is never quietly erased.
  opted_in_at  timestamptz
);

create index if not exists suppressions_active_idx on suppressions (phone) where opted_in_at is null;
