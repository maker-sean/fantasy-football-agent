-- Passes exist from the moment a league goes live. They are not HANDED OVER
-- then.
--
-- The referral ask lands badly on day zero. Somebody who has had the bot in
-- their group chat for four minutes has no idea yet whether it is any good, so
-- asking them to vouch for it to a friend is asking for a recommendation they
-- are not yet in a position to make — and burning the one moment they would
-- have made it gladly, a week later, after it caught something.
--
-- So the codes are minted at go-live, because that is when the league and its
-- name and its commissioner are known and stable, and they sit unreleased
-- until somebody decides the league has used the thing long enough to mean it.
-- released_at is that decision. Null means the commissioner has never been
-- shown the code and the API will not return it.
--
-- Minting early and releasing late, rather than minting late, keeps the code
-- stable: FOUNDER-DAVE is the same string whether it is handed over on day
-- three or day thirty, and it is already in the table if anybody needs to look
-- up who was referred by whom.
alter table promo_codes add column if not exists released_at timestamptz;

comment on column promo_codes.released_at is
  'When this pass was given to the league that earned it. Null = minted but never shown.';

-- The operator asks "which leagues are ready and have not been sent theirs",
-- which is a scan of unreleased referral codes.
create index if not exists promo_codes_unreleased_idx
  on promo_codes (created_by_league_id)
  where created_by_league_id is not null and released_at is null;
