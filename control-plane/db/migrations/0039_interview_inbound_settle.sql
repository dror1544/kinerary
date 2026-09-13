-- A settle buffer on the INBOUND side, mirroring 0033's router_prompt_due_at
-- on the outbound side.
--
-- Run 9, 2026-09-05, in the organizer's own words: "it still seems that hermes
-- and gw are competing." He answered "who's travelling" as five separate
-- Telegram messages — one line per family member, an ordinary way to type on
-- a phone. Each one, forwarded immediately, tore down the PREVIOUS turn and
-- opened a new one (openAgentTurn closes whatever is open before opening the
-- next) — and Hermes does not know or care that we closed its turn row, so it
-- keeps its own, now-orphaned conversation loop running regardless. Seven
-- distinct turn ids were logged for that one burst: several overlapping,
-- uncoordinated agent invocations, each free to nominate or answer something
-- on its own. Two of them independently deciding to ask about trip_pace is
-- what produced one buttoned ask and one buttonless one; a checkbox tap
-- refused because a different invocation had already finalized that question
-- is what read as "buttons does not move it".
--
-- The fix has to sit upstream of openAgentTurn, which is correct for what it
-- does — closing a genuinely stale turn before starting a real new one. What
-- was missing is deciding WHEN a new inbound message really starts a new
-- turn, versus continuing a burst that is still arriving. `pending_inbound`
-- holds the text (and media, if any) collected so far; `inbound_settle_due_at`
-- is pushed forward by every new message in the burst, the same "keeps
-- getting further away while writes keep coming" shape as router_prompt's
-- settle window. Once nothing new arrives for INBOUND_SETTLE_SECONDS, the
-- whole burst is flushed as ONE combined message, through ONE opened turn.

ALTER TABLE control_plane.intake_sessions
  ADD COLUMN IF NOT EXISTS pending_inbound jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE control_plane.intake_sessions
  ADD COLUMN IF NOT EXISTS inbound_settle_due_at timestamptz;

-- Claimed the same way router_prompt_due_at is: `FOR UPDATE SKIP LOCKED` in
-- claimSettledInboundBursts, so two poll ticks can never both flush the same
-- burst — the same race the flood-fix guards already needed.
CREATE INDEX IF NOT EXISTS intake_sessions_inbound_settle_due_at_idx
  ON control_plane.intake_sessions (inbound_settle_due_at)
  WHERE inbound_settle_due_at IS NOT NULL;
