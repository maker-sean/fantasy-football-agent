-- What people say about the product, as opposed to about each other.
--
-- There was no way to tell anybody anything. The gaps list catches "I don't
-- have that", which is demand inferred from a refusal, and it cannot catch "the
-- Tuesday recap is too long" or "it got Kellan's record wrong" — the things
-- somebody would say if asked. Those were landing in a group chat and staying
-- there.
--
-- A TABLE RATHER THAN A QUERY, unlike gaps. Gaps are derivable from replies
-- already stored; feedback needs somebody to mark a message as feedback, and
-- once it is marked it needs a state, because the whole point is reviewing it
-- later and knowing what you have already dealt with.
create table if not exists feedback (
  id          uuid primary key default gen_random_uuid(),
  league_id   uuid references leagues(id) on delete set null,
  phone       text,
  -- The name at the time, denormalised on purpose: a member row can be merged
  -- or renamed and the feedback should still say who said it.
  said_by     text,
  -- bug | idea | feedback. Taken from the word they used, because "it's broken"
  -- and "you should add" are different queues and they already told us which.
  kind        text not null default 'feedback',
  body        text not null,
  -- Where it was said. In-group feedback is public and often performative,
  -- 1:1 is considered. Both are worth having and they read differently.
  in_group    boolean not null default false,
  status      text not null default 'new'
              check (status in ('new', 'reviewed', 'actioned', 'declined')),
  created_at  timestamptz not null default now(),
  reviewed_at timestamptz
);

create index if not exists feedback_new_idx on feedback (created_at desc) where status = 'new';

comment on table feedback is
  'Said deliberately, unlike the gaps list which is inferred from refusals. Has a status because the point is reviewing it later.';
