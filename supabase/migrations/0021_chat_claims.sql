-- Letting people say which team is theirs, in the chat.
--
-- The rules for this have existed since 0004 and are tested in
-- identity.test.js — write once, a taken team is refused, a bound phone cannot
-- become someone else. What never existed was a way to USE them from a group
-- chat: db.bindMember is called from exactly two places, a CLI script and the
-- onboarding form. So the only way a phone number ever reached a roster was a
-- commissioner typing it, twelve times, looking each one up in Contacts.
--
-- src/welcome.js says as much in a comment, having deliberately REMOVED a
-- "reply with your name" line because nothing implemented it. This is that line
-- earned rather than promised.

-- When the bot last put the roster menu in front of this chat.
--
-- A bare "3" is ordinary conversation — somebody talking about week 3 — and
-- answering it would be the bot barging in, which is the failure the reply gate
-- exists to prevent. So a bare number only counts as a claim shortly after the
-- menu was actually shown. Addressed claims ("bot 3") need no window, because
-- saying the bot's name is already unambiguous.
alter table leagues add column if not exists claims_asked_at timestamptz;

comment on column leagues.claims_asked_at is
  'When the roster menu was last shown in this chat. A bare number only reads as a claim within CLAIM_WINDOW_MINUTES of it.';

-- 'prompted' is not a claim, it is us asking — recorded so the nudge can be
-- capped at one per phone per day. Without it, every ignored message from an
-- unbound person would produce another prompt, which is a nag loop aimed at
-- exactly the people who have not worked out how to use this yet.
alter table identity_claims drop constraint if exists identity_claims_outcome_check;
alter table identity_claims add constraint identity_claims_outcome_check
  check (outcome in ('bound', 'rejected_phone_taken', 'rejected_team_taken',
                     'rejected_no_match', 'ambiguous', 'rebound_by_commissioner',
                     'prompted'));
