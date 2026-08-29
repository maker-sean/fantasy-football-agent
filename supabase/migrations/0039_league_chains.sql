-- The league's own history, which never changes and was fetched on every reply.
--
-- A Sleeper league links to its predecessor by previous_league_id, so finding
-- six seasons of history means six HTTP calls. history.chain() did exactly that
-- with no cache, and four separate callers each walked it independently during a
-- single reply: 28 of the 55 Sleeper calls a reply made were re-deriving, over
-- the network, four times over, a fact that does not change.
--
-- It CANNOT change for a given id. A league's previous_league_id is fixed when
-- the league is created, so the chain hanging off any one id is immutable — this
-- is about as safe as a cache gets. refreshed_at exists to allow a rebuild if a
-- chain is ever found to be wrong, not because it is expected to go stale.
create table if not exists league_chains (
  sleeper_league_id text primary key,
  chain             jsonb not null,
  refreshed_at      timestamptz not null default now()
);
