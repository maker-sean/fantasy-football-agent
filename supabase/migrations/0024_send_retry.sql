-- One retry for a send that failed transiently.
--
-- ERROR 5504 is Sendblue declining to guess a group's transport, not a
-- rejection of the content: the identical message resent later went
-- ACCEPTED then SENT over SMS. Sendblue does not retry on its own, so a reply
-- that hit this simply never arrived and nothing knew.
--
-- Two columns, both there to stop a retry loop rather than to enable one.
-- retried_at marks a row as already handled. is_retry marks the row a retry
-- CREATED, because that row is itself young and failed-able, and without the
-- flag a thread that cannot resolve its transport would resend every ten
-- minutes forever.
alter table send_log
  add column if not exists retried_at timestamptz,
  add column if not exists is_retry   boolean not null default false;

comment on column send_log.retried_at is
  'This failure was resent once. Null and failed and recent means still eligible.';
comment on column send_log.is_retry is
  'This row IS a retry. Never retried again, so one transient failure costs one resend and not a loop.';
