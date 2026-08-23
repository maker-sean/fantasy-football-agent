-- Whether a send actually landed.
--
-- send_log.ok has always meant "Sendblue's API answered 200", and the comment
-- in sendblue.js says so plainly. It is not delivery, and the gap between the
-- two is not theoretical: a reply to the league was accepted, recorded ok with
-- status QUEUED, and then failed at the device layer with
--
--   ERROR 5504  Could not determine target service for group;
--               refusing to default to iMessage
--
-- Every record this system keeps says that message went out. It never arrived,
-- and the way it got noticed was somebody reading the group chat and asking.
--
-- Two columns close it. The handle is the part that matters most: without it
-- there is no way to ask Sendblue what became of a specific send, so no amount
-- of polling could ever have been correlated back to a row.
alter table send_log
  add column if not exists message_handle text,
  add column if not exists delivery       text,
  add column if not exists checked_at     timestamptz;

comment on column send_log.ok is
  'Sendblue accepted the request. NOT delivery — see delivery, which is reconciled afterwards.';
comment on column send_log.message_handle is
  'Sendblue''s id for the send. Without it a row cannot be matched to what became of it.';
comment on column send_log.delivery is
  'Terminal state from Sendblue: SENT, DELIVERED, ERROR. Null means not yet checked.';

-- The reconcile job reads recent unchecked rows, so it is worth an index.
create index if not exists send_log_unchecked_idx
  on send_log (at desc) where message_handle is not null and delivery is null;
