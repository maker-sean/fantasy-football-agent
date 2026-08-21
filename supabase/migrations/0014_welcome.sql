-- The welcome is a precondition, not a feature.
--
-- Every other message this bot sends assumes the group already knows what it
-- is. Recaps and injury alerts are SCHEDULED, so without this a league that
-- nobody addressed before Tuesday would receive a roast as its first ever
-- message from us: no identification, no STOP, and that is the one message a
-- carrier reviewer is most likely to read.
--
-- A timestamp rather than a boolean. It is still binary in use, null or not,
-- but it records WHEN this group was told what it is, which is the evidence
-- A2P registration asks for. A boolean discards that for nothing.
--
-- Nullable and no default on purpose: leagues that already exist have NOT been
-- welcomed, and pretending otherwise would skip the introduction for exactly
-- the league already in a real group chat.

alter table leagues add column if not exists welcomed_at timestamptz;

comment on column leagues.welcomed_at is
  'When this group was sent the introduction. Null means it has not been, and no other outbound message should go out until it has.';
