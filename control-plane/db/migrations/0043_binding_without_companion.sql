-- A chat can be bound to a trip before — or without — a companion profile.
--
-- A4 of docs/onboarding-to-active-plan.md. Until now `hermes_profile` was NOT
-- NULL, which coupled two independent facts: "this chat belongs to this trip"
-- and "there is an assistant to route it to". The coupling was not theoretical
-- — on 2026-09-06 the companion install failed and the binding, gated behind
-- it in the same `if`, was never attempted, so a provisioned trip had no
-- routing at all and the organizer got "I don't have a trip for this chat".
--
-- Splitting them lets the two components be retried independently, which is
-- the point: a companion install can be fixed and re-run without first
-- reconstructing routing, and routing can exist while the assistant behind it
-- is still being repaired.
--
-- The safety property this must NOT break: a binding row existing is not a
-- claim that the destination works. That claim lives in `trips.reachability`
-- (migration 0042), written only by the code that opens the binding to a
-- profile that actually installed. NULL here means exactly "bound, no
-- assistant yet" — visible, retryable, and never mistaken for healthy.
ALTER TABLE control_plane.telegram_chat_bindings
  ALTER COLUMN hermes_profile DROP NOT NULL;

-- An empty string would be a third state meaning the same thing as NULL, and
-- two spellings of "absent" is how a reader ends up handling one and not the
-- other.
ALTER TABLE control_plane.telegram_chat_bindings
  DROP CONSTRAINT IF EXISTS telegram_chat_bindings_profile_not_blank_ck;
ALTER TABLE control_plane.telegram_chat_bindings
  ADD CONSTRAINT telegram_chat_bindings_profile_not_blank_ck
  CHECK (hermes_profile IS NULL OR char_length(btrim(hermes_profile)) > 0);
