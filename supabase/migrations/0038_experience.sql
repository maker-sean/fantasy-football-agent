-- How long a player has been in the league, and how old he is.
--
-- Dynasty market values DO price future production — that is what they are for.
-- But rookies are the part of that market with the least to go on: no NFL snaps,
-- a projection built on college tape and draft capital. So a roster grade
-- resting mostly on rookies rests on the least certain prices in the source,
-- and a grade that does not say so implies a confidence it has not got.
--
-- player_values has an is_rookie column that is entirely null — the value sheet
-- is dates and asset columns with no metadata, so nothing ever filled it.
-- Sleeper has years_exp for 12,157 of 12,225 players.
--
-- age comes along because it is the other half of the same question in a
-- dynasty league, where a 31 year old and a 24 year old at identical value are
-- not identical assets.
alter table players add column if not exists years_exp integer;
alter table players add column if not exists age integer;
