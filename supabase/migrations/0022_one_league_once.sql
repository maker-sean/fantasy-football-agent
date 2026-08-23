-- One Sleeper league, one live league row.
--
-- leagues_sleeper_idx exists and is NOT unique, and the only uniqueness on this
-- table is (provider, chat_id), which stops two leagues sharing a chat rather
-- than stopping one league being onboarded twice. POST /api/leagues checked
-- leaguesForAccount, scoped to the account, so the same person re-adding a
-- league resumed correctly while a DIFFERENT person onboarding the same league
-- created a second row. In a twelve person league that is not a rare accident,
-- it is the second person who gets excited and follows the link.
--
-- Two live rows for one Sleeper league means two sets of members, two chat
-- links racing for the same thread, and recaps computed twice from the same
-- snapshots. None of it errors.
--
-- ARCHIVE ROWS ARE EXCLUDED. src/history.js writes one row per past season with
-- provider='archive', each carrying its own sleeper_league_id, and those are
-- legitimately not unique against the live table: a league onboarded for 2026
-- may also have 2025 sitting in the archive. The partial index draws the line
-- exactly where the meaning changes.
create unique index if not exists leagues_one_live_per_sleeper_idx
  on leagues (sleeper_league_id)
  where sleeper_league_id is not null and provider <> 'archive';

comment on index leagues_one_live_per_sleeper_idx is
  'A Sleeper league can be onboarded once. Archive rows are excluded: history.js writes one per past season and they share the id space by design.';
