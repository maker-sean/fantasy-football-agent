-- Asking the group a question and getting an answer back.
--
-- Every other feature in this system reads a league someone else governs and
-- reports on it. This is the first one that asks the league to DECIDE — a trade
-- veto, a rule change, a draft date. That difference is why this is not a
-- generic poll table.
--
-- WHO VOTED IS THE ENTIRE FEATURE.
--
-- The obvious design is a public link and a browser fingerprint: hash the IP
-- and the User-Agent, call it a voter, refuse a second vote from the same hash.
-- That is wrong here in both directions at once. Two league mates on the same
-- house wifi with the same phone model produce the SAME hash, so the second
-- one is silently rejected and never learns it. iOS Private Relay and carrier
-- NAT rotate the address, so one person gets as many votes as they have
-- patience. At ten voters either failure decides the outcome.
--
-- 0004_identity_binding.sql already settled this argument for messages: a phone
-- number is the only thing we can verify about a person, because it comes from
-- the transport rather than from what somebody typed. The same rule applies to
-- a vote, so votes reference members(id) — a row that exists only because a
-- verified phone was bound to a roster — and never a fingerprint. The webview
-- is still zero-auth for the voter; the binding travels in a signed token in
-- the link, minted per member. See src/ballotlink.js.
--
-- NAMING. "poll" is taken. In this repo it means the Sendblue inbound poller
-- (src/poller.js, POLL_INTERVAL_SECONDS, scripts/poll.js) and the twice-daily
-- trade poll in src/trades.js. A third meaning on top of those two would make
-- every future grep ambiguous, so the thing a league votes on is a BALLOT.

create table if not exists ballots (
  id               uuid primary key default gen_random_uuid(),
  league_id        uuid not null references leagues(id) on delete cascade,
  question         text not null,

  -- What kind of decision this is. Not cosmetic: it picks the default for
  -- results_visible below, and 'veto' is the one that writes back to a trade.
  kind             text not null default 'poll'
                   check (kind in ('poll', 'veto', 'rule', 'date')),

  -- The thing being decided about, when there is one — a trades.id for a veto.
  -- Deliberately untyped text with no foreign key: a ballot outlives the row it
  -- refers to, and a veto whose trade was later deleted should still show what
  -- the league voted, not cascade into nothing.
  subject_kind     text,
  subject_id       text,

  max_choices      int  not null default 1 check (max_choices between 1 and 8),

  -- Whether the running split is visible before voting closes.
  --
  -- This matters more than anonymity, which is the flag a generic poll service
  -- would offer instead. Live percentages bias whoever votes later toward
  -- whichever option is ahead; for "what's for dinner" that is harmless and
  -- fun, and for a trade veto in a league where everyone talks to each other it
  -- decides the result. So the default is after_close, and 'live' is a choice
  -- the asker makes on purpose.
  --
  -- HOW MANY have voted is always visible either way. That is the number that
  -- makes people chase the stragglers, and it reveals nothing about the split.
  results_visible  text not null default 'after_close'
                   check (results_visible in ('live', 'after_close')),

  -- Close early once this many have voted. Null means wait for the deadline.
  quorum           int check (quorum is null or quorum > 0),

  closes_at        timestamptz not null,
  closed_at        timestamptz,

  -- The tally, frozen at close. Stored rather than recomputed because options
  -- and members can be edited afterwards, and a result that changes when
  -- somebody fixes a display name is not a result.
  outcome          jsonb,

  created_by       text,
  created_at       timestamptz not null default now()
);

create index if not exists ballots_league_idx on ballots (league_id, created_at desc);
-- Partial: the worker asks "what is still open and due" every few minutes, and
-- the closed ones are the overwhelming majority within a week.
create index if not exists ballots_open_idx on ballots (closes_at) where closed_at is null;

create table if not exists ballot_options (
  id          uuid primary key default gen_random_uuid(),
  ballot_id   uuid not null references ballots(id) on delete cascade,
  label       text not null,
  emoji       text,
  sort_order  int  not null default 0
);

create index if not exists ballot_options_ballot_idx on ballot_options (ballot_id, sort_order);

-- One row per (member, option) they chose.
--
-- The key is the whole triple, which is what a MULTI-choice ballot needs. It is
-- NOT on its own enough to stop a single-choice voter picking every option once
-- each — that constraint cannot be expressed here, because whether this ballot
-- is single choice lives on the other table and an index predicate cannot reach
-- it. So the cap is enforced in one place in the application, by replacing a
-- member's entire ballot inside a transaction on every vote (src/ballots.js,
-- castVote). Writing it any other way is a bug; there is a test for it.
--
-- Replace-not-append is also what makes changing your mind work. In a group
-- chat "wait, I take that back" is the normal case, not an edge one, and a
-- design that answers the second tap with a duplicate-key error gets it wrong.
create table if not exists ballot_votes (
  ballot_id   uuid not null references ballots(id) on delete cascade,
  member_id   uuid not null references members(id) on delete cascade,
  option_id   uuid not null references ballot_options(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (ballot_id, member_id, option_id)
);

create index if not exists ballot_votes_ballot_idx on ballot_votes (ballot_id);

comment on column ballots.results_visible is
  'live shows the running split to anyone who opens the link; after_close shows only the participation count until the ballot closes.';
comment on table ballot_votes is
  'A vote is anchored to members(id), never to a browser fingerprint. See 0004_identity_binding.sql.';
