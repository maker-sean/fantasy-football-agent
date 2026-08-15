-- Every reply decision, including the ones where the bot stayed quiet.
--
-- Logging only what the bot SAID makes the gate untunable: you cannot see what
-- it declined or why, so you cannot tell "correctly silent" from "missed an
-- obvious mention." Silence is the common case and the interesting one.

create table if not exists decisions (
  id                  bigserial primary key,
  league_id           uuid references leagues(id) on delete set null,
  provider            text not null,
  chat_id             text,

  -- The burst that was evaluated. Group chats arrive in flurries, and each
  -- burst produces exactly one decision — not one per message.
  trigger_message_id  text,
  message_count       integer not null default 1,

  -- Which layer settled it: suppress | mention | heuristic | gate | default
  layer               text not null,
  decision            text not null check (decision in ('reply', 'silent')),
  reason              text not null,
  detail              jsonb not null default '{}'::jsonb,

  latency_ms          integer,
  replied_text        text,
  created_at          timestamptz not null default now()
);

create index if not exists decisions_league_time_idx on decisions (league_id, created_at desc);
create index if not exists decisions_chat_time_idx   on decisions (chat_id, created_at desc);
create index if not exists decisions_layer_idx       on decisions (layer, decision);

-- One decision per burst. A retry must not double-count in the engagement
-- metric, whose denominator is bot messages.
create unique index if not exists decisions_trigger_idx
  on decisions (provider, trigger_message_id) where trigger_message_id is not null;
