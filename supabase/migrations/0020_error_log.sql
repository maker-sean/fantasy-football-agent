-- Errors, in one place, with the system that produced them.
--
-- They existed already — every one of them. They were in Render's log stream,
-- in Sendblue's API, in decisions.detail, in job_runs.detail, and in a dozen
-- console.error lines. Which is the same as nowhere: an operator cannot answer
-- "what is failing and since when" by grepping four surfaces, and tonight
-- proved it — a 403 on a retired from_number took twenty minutes to find while
-- sitting in plain sight in an API response.
--
-- The point is not new information. It is one table, so the question has one
-- query.
create table if not exists error_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  -- Which moving part failed. The four that can fail independently and need
  -- entirely different fixes: our own API, the messaging provider, the model,
  -- and Sleeper. 'worker' covers scheduled jobs.
  system     text not null check (system in ('web','sendblue','anthropic','sleeper','worker','db')),
  operation  text,                       -- 'POST /api/leagues', 'send', 'weekSnapshot'
  status     int,                        -- HTTP status where there was one
  message    text not null,
  league_id  uuid references leagues(id) on delete set null,
  detail     jsonb not null default '{}'::jsonb
);

create index if not exists error_log_at_idx on error_log (at desc);
create index if not exists error_log_system_idx on error_log (system, at desc);

comment on table error_log is
  'Every failure, one table. Not new information — the same errors were already scattered across Render logs, Sendblue, decisions.detail and job_runs, which is the same as nowhere.';
