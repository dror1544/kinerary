-- Keep the raw plan document an organizer shared during the interview, so a
-- later run can re-extract phases[].days from it without asking them to
-- re-upload. Not needed for the first extraction (that happens live in the
-- interview-mcp extract_itinerary tool) — this is purely for re-derivation.
--
-- Staged on the session as it comes in, copied onto the immutable
-- intake_versions row at confirm. Shape: { filename, text, savedAt }.
-- Deliberately a sibling jsonb column, not a key inside intake_versions.data:
-- `data` carries the answer store under a canonical-safety CHECK (migration
-- 0015) and a fixed digest; the document is bulk text with neither concern.

ALTER TABLE control_plane.intake_sessions
  ADD COLUMN source_document jsonb;

ALTER TABLE control_plane.intake_versions
  ADD COLUMN source_document jsonb;
