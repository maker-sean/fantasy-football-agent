-- Where a player sits on his own team's depth chart, and what the injury note says.
--
-- The handcuff detector matched on same NFL team plus same position and could
-- say no more than "a backup". Grading a trade that spent a second round pick
-- on a Raiders running back, it flagged the pick as a handcuff to an injured
-- starter — and would have flagged three other Raiders backs identically, so
-- the finding was "plausibly a handcuff" rather than "the handcuff", and the
-- trade was graded down partly on that ambiguity.
--
-- Sleeper had depth_chart_order the whole time: that player is RB2. 1,812
-- players carry an order and 3,010 carry a depth chart position, and none of it
-- was stored, so every handcuff claim was vaguer than the data allowed.
--
-- injury_notes carries the detail behind a status — 89 players in the offseason
-- and many more in season. "Questionable" and "Questionable, expected to play"
-- are different answers to the only question anybody asks.
alter table players add column if not exists depth_chart_order integer;
alter table players add column if not exists depth_chart_position text;
alter table players add column if not exists injury_notes text;

-- Finding the backup to a given starter is a team-and-position lookup that now
-- wants to come back in depth order.
create index if not exists players_depth_idx
  on players (team, position, depth_chart_order)
  where team is not null and depth_chart_order is not null;
