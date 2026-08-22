-- The two things that fail silently, and the one that decides the margin.
--
-- SEND OUTCOMES. Nothing recorded whether a send SUCCEEDED. Replies happened to
-- capture it — responder.js writes detail.sendError on the decision — but the
-- signup path caught its error, logged the verdict under layer 'default', and
-- threw the reason away. That is exactly how a 403 on a retired from_number
-- stayed invisible for twenty minutes while sitting in plain sight in
-- Sendblue's own API: a league could go completely silent and the operator
-- board would report it healthy, because a failed send left no queryable trace.
--
-- Written at the transport, in sendUnchecked, which is the single funnel every
-- send passes through. One row per attempt, success or failure, so "failed
-- sends today" and "why" are one query rather than a log grep.
create table if not exists send_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  league_id  uuid references leagues(id) on delete set null,
  chat_id    text,
  is_group   boolean not null default false,
  ok         boolean not null,
  -- Sendblue's own status string when it gave one. It can return HTTP 200 with
  -- {"status":"ERROR"} in the body, so the HTTP code alone is not the answer.
  status     text,
  error      text
);

create index if not exists send_log_at_idx on send_log (at desc);
-- The query that matters is "what is failing, recently", so failures get their
-- own partial index rather than scanning every successful send to find them.
create index if not exists send_log_fail_idx on send_log (at desc) where not ok;

comment on table send_log is
  'One row per send attempt at the transport. The only place a FAILED send is recorded — messages only ever holds sends that worked.';

-- MODEL COST. recap_drafts.usage captured recap tokens, but a conversational
-- reply returned usage in meta and worker.js discarded it, keeping only the
-- text. Fine at one league; it is the entire margin at a hundred, and it cannot
-- be reconstructed after the fact.
create table if not exists model_usage (
  id            bigserial primary key,
  at            timestamptz not null default now(),
  league_id     uuid references leagues(id) on delete set null,
  kind          text not null,            -- reply | recap | injury | …
  model         text,
  input_tokens  int not null default 0,
  output_tokens int not null default 0
);

create index if not exists model_usage_at_idx on model_usage (at desc);
create index if not exists model_usage_league_idx on model_usage (league_id, at desc);

comment on table model_usage is
  'Tokens per call, per league. Separate from recap_drafts.usage so replies and recaps are countable together.';
