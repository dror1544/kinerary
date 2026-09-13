-- A session-level override of the agent floor, for the one turn kind where
-- 30 seconds was never realistic: a document or photo upload. Run 12
-- (2026-09-05) measured a real document turn taking over a minute of genuine
-- Hermes work before its first write, well past the general floor — the
-- watchdog correctly followed its own rule and reclaimed a turn that was not
-- actually stalled, producing the exact "returned 404 NOT_FOUND twice"
-- failure Dror reported.
--
-- NULL means "use the caller's default" (AGENT_FLOOR_SECONDS) — every
-- existing session and every markAwaitingMachine call that does not pass an
-- override keeps today's behavior exactly. Only a media-triggering inbound
-- event sets this, and only until the next markAwaitingMachine call clears it.
ALTER TABLE control_plane.intake_sessions
  ADD COLUMN IF NOT EXISTS awaiting_floor_seconds integer;
