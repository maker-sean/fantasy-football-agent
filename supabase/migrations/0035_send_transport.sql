-- Which transport actually carried a message.
--
-- send_log has recorded, from the beginning, whether a send was accepted and
-- whether it landed. It has never recorded HOW. That gap surfaced when a reply
-- to a twelve-person group failed with
--
--   ERROR 5504  Could not determine target service for group;
--               refusing to default to iMessage
--
-- and the automatic retry then succeeded — over SMS. Both facts were visible in
-- Sendblue's message feed and neither was visible in this database, so "this
-- chat works on SMS and fails on iMessage" could not be asked of our own data.
--
-- Sendblue exposes no way to REQUEST a transport for a group send: the body
-- takes group_id, content, from_number, status_callback, send_style, media_url,
-- and nothing else. So this cannot be used to choose. It is here to know, which
-- is what tells a chronically broken chat apart from one bad night, and what
-- turns a support ticket from a description into evidence.
alter table send_log add column if not exists service text;

-- The reconcile pass fills this in for sends it resolves, so it only covers
-- messages checked after this migration. Older rows stay null rather than
-- guessing: a guessed transport is worse than an absent one here, because the
-- whole point is telling two transports apart.
create index if not exists send_log_chat_service_idx
  on send_log (chat_id, at desc) where service is not null;
