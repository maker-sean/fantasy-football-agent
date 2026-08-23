-- Who they are, captured on the website before the first text.
--
-- The three intake questions (name, email, where the league actually chats)
-- were asked over SMS, straight after the signup confirmed. That works, and it
-- is the wrong moment: by then the person has already texted a number they had
-- never seen, and the operator has a lead they cannot email.
--
-- Sean's expectation, and he is right, is that the answers are on the screen
-- that hands you the code. The signup row does not exist yet at that point —
-- it is created when the code is texted in — so the answers ride on the code
-- and are copied across on redemption.
--
-- NULL still has to work. Every field is optional for the same reason the
-- texted version accepts "skip": a form that refuses to hand over the code
-- until three boxes are filled trades a signup for a profile. Whatever is
-- missing here, src/intake.js still asks for over SMS, so the form is the
-- primary and the conversation is the backstop.
alter table signup_codes
  add column if not exists first_name     text,
  add column if not exists last_name      text,
  add column if not exists email          text,
  add column if not exists platform       text,
  add column if not exists platform_other text;

comment on column signup_codes.email is
  'Captured before the code is texted, so a lead is reachable off SMS from the first minute rather than after an intake conversation that may never happen.';
comment on column signup_codes.platform is
  'Where their league actually chats, which is not where onboarding happens. Copied onto the signup on redemption.';
