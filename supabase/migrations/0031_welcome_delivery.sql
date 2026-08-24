-- Welcomed means DELIVERED, not accepted.
--
-- Sigma Chi Dynasty was stamped welcomed_at 2026-08-24 01:45:29 on a send that
-- failed at the device layer with "Message was dropped by gateway". welcome.js
-- stamps after send() does not throw, and not throwing means Sendblue answered
-- 200 — which is acceptance. The comment above that line already promised the
-- stamp happens "only AFTER a successful send"; the word doing the damage was
-- successful.
--
-- The cost is not one lost message. welcomed_at is the guard that stops a
-- league being introduced twice, so a false stamp means it is never introduced
-- at all: twelve people meet a bot that says nothing about itself and then
-- starts answering questions.
--
-- The handle is what lets the delivery sweep undo it. src/delivery.js already
-- reconciles every send against Sendblue every six minutes and knows which ones
-- failed; it just had no way to tell that a particular failure WAS the welcome.
alter table leagues
  add column if not exists welcome_message_handle text;

comment on column leagues.welcome_message_handle is
  'Sendblue handle for the introduction. Set when it is accepted, cleared when it is confirmed delivered or when the sweep finds it failed and unsets welcomed_at so it goes again.';
