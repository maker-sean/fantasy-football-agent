-- Operator observability, and a kill switch that does not need a deploy.
--
-- Three things, all additive:
--
--   1. Token usage on recap drafts. generateRecap already returns meta.usage and
--      weekly.js dropped it on the floor, so cost per league was unanswerable.
--
--   2. prompt_sha, NOT the prompt itself. The facts are already stored, PERSONA
--      lives in git, and factsBlock(facts) is deterministic, so the exact prompt
--      is reconstructable from facts plus a commit. Storing a sha is smaller and
--      it structurally keeps prompts in version control: a prompt pasted into a
--      dashboard text box can never be traced back to the output it produced.
--
--   3. system_flags, for the global kill.
--
-- On the kill switch specifically. REPLY_DRY_RUN already exists as an env var,
-- but flipping it means a Render dashboard visit and a worker restart, and
-- render.yaml re-applies literal values on deploy, which has silently reset it
-- before. A row here is read on the next poll, which is ten seconds. That is
-- the difference between stopping a bot mid-Sunday and watching it finish.

alter table recap_drafts add column if not exists usage      jsonb;
alter table recap_drafts add column if not exists prompt_sha text;

create table if not exists system_flags (
  key        text primary key,
  value      jsonb       not null default 'null'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);

-- Seeded explicitly rather than relying on "absent means off". An operator
-- looking for the kill switch should find a row, not an absence they have to
-- interpret.
insert into system_flags (key, value, updated_by)
values ('replies_paused', 'false'::jsonb, 'migration 0013')
on conflict (key) do nothing;

-- The thread viewer reads messages for one league in time order, and the health
-- view groups decisions by layer over a window. Neither had an index.
create index if not exists messages_league_time_idx  on messages  (league_id, occurred_at desc);
create index if not exists decisions_league_time_idx on decisions (league_id, created_at desc);
create index if not exists decisions_layer_idx       on decisions (layer, created_at desc);
