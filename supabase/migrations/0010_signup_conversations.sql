-- Where someone is in the texted signup, between messages.
--
-- The short-code path assumes the sender came from the website. Someone who
-- saw the number in a Reddit comment has no code, and sending them to a
-- website to fetch one reintroduces exactly the friction the code removed. So
-- a bare keyword starts a conversation instead, and this remembers the thread.
--
-- Keyed on phone: a person has at most one signup conversation at a time.

create table if not exists signup_conversations (
  phone       text primary key,
  -- awaiting_username | awaiting_league_choice
  state       text not null,
  -- Candidate leagues, the resolved Sleeper user, and anything else the next
  -- turn needs. Kept here rather than re-fetched so a reply cannot silently
  -- resolve against a different list than the one the sender was shown.
  data        jsonb not null default '{}'::jsonb,
  -- A conversation that never finishes must not sit forever waiting to
  -- misinterpret an unrelated text months later as an answer.
  expires_at  timestamptz not null default now() + interval '24 hours',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists signup_conversations_expiry_idx on signup_conversations (expires_at);
