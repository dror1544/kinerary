-- Best-effort, UNVERIFIED Telegram delivery hint for a trip's "your site is
-- ready" DM, captured at interview start (interview.ts's startSession) from
-- the trip-intake-interviewer conversation itself.
--
-- Deliberately NOT written to user_identities: that table's
-- provider = 'telegram' rows are also read as an AUTHENTICATION source
-- (resolveWebAuth's provider+digest lookups in app.ts/signup.ts — anyone who
-- can present a matching X-Telegram-Login digest for that row is treated as
-- that user). This value arrives as an interview-mcp tool-call argument the
-- Hermes agent relays from its own conversation context — real in practice,
-- but not cryptographically verified by Telegram the way signup's Login
-- Widget path is. Writing it into user_identities would let an
-- LLM-relayed value grant login capability, not just a delivery hint — a
-- real authentication-bypass risk, not a hypothetical one.
--
-- provisioner.py's notification recipient lookup falls back to this column
-- ONLY when the trip owner has no verified user_identities.provider_subject_id
-- on file (i.e. they signed up via a non-Telegram identity, such as today's
-- password stopgap) — the verified column is always preferred when present.

ALTER TABLE control_plane.trips
  ADD COLUMN notification_chat_id_hint text;
