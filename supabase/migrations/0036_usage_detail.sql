-- What the router decided, alongside what the reply cost.
--
-- Retrieval loads only the context a question needs. Its failure mode is not an
-- error: a section the router did not ask for comes back as a confident answer
-- with something missing from it, which is indistinguishable from a good answer
-- unless you know what was loaded. model_usage records the cost of every reply
-- and nothing about the decision that produced it.
--
-- jsonb rather than columns because the shape will change: sections today, a
-- lookup name and its arguments now, and whatever the next retriever needs.
-- Nothing queries it in application code; it exists to be read after the fact
-- when an answer looks wrong.
alter table model_usage add column if not exists detail jsonb;

-- Routing rows are their own kind, so 'reply' averages stay comparable across
-- the rollout. Mixing a 300-token router call into the reply average would hide
-- exactly the number the rollout is judged on.
create index if not exists model_usage_kind_at_idx on model_usage (kind, at desc);
