-- Trades: announce them when they happen, judge them three weeks later.
--
-- The judgment is the point. A grade at trade time needs rest-of-season
-- projections, which we do not have and could not verify — exactly the invented
-- number the recap verifier exists to block. A grade three weeks later needs
-- only arithmetic over players_points, which is already captured in every
-- weekly snapshot. So the row records the trade now and is scored later.

create table if not exists trades (
  id                uuid primary key default gen_random_uuid(),
  league_id         uuid not null references leagues(id) on delete cascade,
  -- Sleeper's own id. The whole dedup mechanism: a trade is new if this is not
  -- already here. No cursors, no timestamps, nothing to drift out of sync.
  transaction_id    text not null,
  season            text not null,
  week              integer not null,

  -- Mutable, unlike everything else in this schema. A trade has a lifecycle
  -- (pending -> complete | vetoed) and the poller watches for transitions
  -- rather than only for new rows.
  status            text not null,

  -- roster_id -> [player_id]. Who received what.
  received          jsonb not null default '{}'::jsonb,
  roster_ids        integer[] not null default '{}',
  draft_picks       jsonb not null default '[]'::jsonb,
  raw               jsonb not null default '{}'::jsonb,

  -- The revisit. Set when the trade first completes; the weekly recap job
  -- claims anything due. No second scheduler.
  revisit_week      integer,
  revisited_at      timestamptz,
  verdict           jsonb,

  first_seen_at     timestamptz not null default now(),
  status_updated_at timestamptz,
  created_at        timestamptz not null default now()
);

-- One row per Sleeper transaction per league, forever.
create unique index if not exists trades_txn_idx
  on trades (league_id, transaction_id);

-- The revisit query: due, not yet done.
create index if not exists trades_revisit_idx
  on trades (league_id, revisit_week) where revisited_at is null;

-- Every status change, including ones we chose not to announce. The chat stays
-- quiet about some transitions but the revisit still gets the full history —
-- "this one was vetoed and re-proposed" is a better story than the end state.
create table if not exists trade_events (
  id             uuid primary key default gen_random_uuid(),
  trade_id       uuid not null references trades(id) on delete cascade,
  from_status    text,
  to_status      text not null,
  announced      boolean not null default false,
  -- Set only after a send succeeds, so a failed send retries on the next tick
  -- rather than being silently swallowed. Same ordering as injury_alerts.
  announced_at   timestamptz,
  detail         jsonb not null default '{}'::jsonb,
  occurred_at    timestamptz not null default now()
);

create index if not exists trade_events_pending_idx
  on trade_events (trade_id) where announced = false;

-- When each league was last polled. Drives the twice-daily schedule: due-ness
-- is "past a configured hour and not polled since", which survives a worker
-- restart. Exact clock matching would silently skip a window whenever the
-- process happened to be down at 8:00.
alter table leagues add column if not exists trades_polled_at timestamptz;
