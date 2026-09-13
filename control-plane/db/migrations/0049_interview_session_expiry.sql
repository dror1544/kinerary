-- An interview session that can end.
--
-- Until now nothing in `intake_sessions` expired. The deep-link enrollment
-- expires (24h) and an agent turn expires (5 min), but the conversation itself
-- ran forever: an organizer who opened a link, answered two questions and put
-- their phone down left a session that would still be sitting there, open and
-- writable, weeks later. It also meant the bot could never say anything about
-- time, so someone coming back after a week got a question mid-thought with no
-- indication that a week had passed.
--
-- IDLE, not absolute. An absolute cap punishes exactly the organizer we want:
-- the one carefully working through a real trip with documents to dig out. An
-- idle timeout only ever catches someone who has walked away, which is the
-- person the warning is for. Every inbound message pushes `expires_at` out
-- again, so a live conversation never expires under anyone.
--
-- `expired_at` rather than a new `state` value: `state` is CHECK-constrained to
-- ('interviewing','awaiting_confirmation','confirmed') and read in a dozen
-- places that would all have to learn a fourth value. Expiry is orthogonal to
-- where the interview got to — and keeping it that way means an expired
-- session still knows what it had collected, which is what lets the copy say
-- "nothing is lost" and be telling the truth.
ALTER TABLE control_plane.intake_sessions
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS expiry_warned_at timestamptz,
  ADD COLUMN IF NOT EXISTS expired_at timestamptz;

COMMENT ON COLUMN control_plane.intake_sessions.expires_at IS
  'When this session goes idle-stale. Pushed forward by every inbound message; a live conversation never reaches it.';
COMMENT ON COLUMN control_plane.intake_sessions.expiry_warned_at IS
  'When the "about to close" warning was sent. Set once, so the warning cannot repeat on every poll tick.';
COMMENT ON COLUMN control_plane.intake_sessions.expired_at IS
  'When the session was closed for idleness. Orthogonal to state: an expired session still knows what it collected.';

-- The claim queries below scan for "due a warning" and "due expiry", both of
-- which are a range test on expires_at over the small set of unfinished
-- sessions. Partial, because a confirmed session is never either.
CREATE INDEX IF NOT EXISTS intake_sessions_expiry_idx
  ON control_plane.intake_sessions (expires_at)
  WHERE expired_at IS NULL AND state <> 'confirmed';

-- ONE LIVE INTERVIEW PER CHAT — now counting expiry.
--
-- `intake_sessions_live_chat_idx` (migration 0028) scoped uniqueness to
-- "still running", which it defined as `state <> 'confirmed'`. An expired
-- session satisfies that, so it kept holding the chat's one live slot: the
-- fresh deep link that the closing message tells the organizer to go and get
-- would fail on this constraint, locking them out of the trip they were half
-- way through setting up.
--
-- The index's own comment says what it is for — "a chat may hold many
-- CONFIRMED sessions over time… so the uniqueness is scoped to sessions that
-- are still running". An idle-closed session is not still running. This is the
-- same rule, told the truth about a second way a session can end.
DROP INDEX IF EXISTS control_plane.intake_sessions_live_chat_idx;
CREATE UNIQUE INDEX intake_sessions_live_chat_idx
  ON control_plane.intake_sessions (telegram_chat_id)
  WHERE telegram_chat_id IS NOT NULL AND state <> 'confirmed' AND expired_at IS NULL;

-- Sessions that predate this column have no deadline and would be expired
-- instantly by the first poll tick. Give them a full window from now.
UPDATE control_plane.intake_sessions
   SET expires_at = now() + interval '60 minutes'
 WHERE expires_at IS NULL AND state <> 'confirmed';
