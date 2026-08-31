-- 0027_release_manifest.sql
--
-- Sprint 4.7 — release-artifact hardening (pipeline + promotion).
--
-- control_plane.releases has held only the *outcome* of a release since 0001:
-- a source_revision, an artifact_digest and a status, with the one real row
-- hand-seeded by 0016 and no way to produce another. This adds the sealed
-- manifest the build pipeline emits, and the bookkeeping the candidate ->
-- verified -> available promotion state machine needs.
--
--   manifest                  the sealed file list (path + git blob sha per
--                             file), the schema ranges, and the sanitation
--                             scan report. artifact_digest is a pure function
--                             of manifest.files, so the row's own digest
--                             column re-verifies against it — tampering with
--                             the list breaks the seal. Only finding *metadata*
--                             ({path,line,rule}) is stored, never the offending
--                             text, so the canonical-safety CHECK below holds.
--   sanitation_passed         mirrored out of the manifest for a cheap filter;
--                             promoteRelease() refuses to move a false past
--                             'candidate'.
--   promoted_to_available_at  when it entered the planner-selectable pool.
--   promoted_by               operator ref that approved that promotion.

ALTER TABLE control_plane.releases
  ADD COLUMN manifest jsonb,
  ADD COLUMN sanitation_passed boolean,
  ADD COLUMN promoted_to_available_at timestamptz,
  ADD COLUMN promoted_by text
    CHECK (promoted_by IS NULL OR promoted_by ~ '^[A-Za-z0-9:_.-]{1,128}$');

-- Backfill the hand-seeded dev release (0016) BEFORE the constraints below
-- validate existing rows: it predates the pipeline, so mark it verified legacy
-- rather than leaving it to trip the scanned-before-verified check. It is
-- already 'available' (0016 inserted it so), so it also needs the promotion
-- bookkeeping the releases_available_requires_promotion check demands below —
-- attributed to the migration that seeded it.
UPDATE control_plane.releases
   SET sanitation_passed = true,
       promoted_to_available_at = COALESCE(promoted_to_available_at, now()),
       promoted_by = COALESCE(promoted_by, 'migration:0016'),
       manifest = jsonb_build_object(
         'schema', 1,
         'kind', 'legacy-hand-seed',
         'note', 'seeded by migration 0016 before the release-build pipeline existed',
         'sourceRevision', source_revision,
         'artifactDigest', artifact_digest,
         'sanitation', jsonb_build_object('scannedFiles', 0, 'passed', true, 'findings', '[]'::jsonb)
       )
 WHERE id = 'release_localdev0001';

-- Same guard 0015 put on intake_versions.data: a manifest is a canonical
-- record, so it may never carry a secret, host path or private address —
-- which is also why scan findings store {path,line,rule} and not the match.
ALTER TABLE control_plane.releases
  ADD CONSTRAINT releases_manifest_is_canonical
  CHECK (manifest IS NULL OR control_plane.canonical_json_is_safe(manifest));

-- A pipeline-built release (one that carries a manifest) must have passed its
-- sanitation scan before it can be 'verified' or 'available'. A manifest-less
-- row is a hand seed (the 0016 dev release, test fixtures) and is grandfathered
-- — gating those is a DB-access concern, not this pipeline's. 'candidate' may
-- sit un-scanned; 'deprecated'/'retired' are exits.
ALTER TABLE control_plane.releases
  ADD CONSTRAINT releases_scanned_before_verified
  CHECK (
    manifest IS NULL
    OR status NOT IN ('verified', 'available')
    OR sanitation_passed IS TRUE
  );

-- ── promotion-path enforcement ──────────────────────────────────────────────
--
-- releases_scanned_before_verified only checks sanitation_passed, not that the
-- candidate -> verified -> available walk actually happened. Without the two
-- guards below, a direct
--     UPDATE control_plane.releases SET status = 'available' WHERE id = ...
-- on a clean-looking candidate reaches the planner-selectable pool having
-- skipped verifyManifest() entirely (promoteRelease() is where the manifest is
-- re-derived and the seal re-checked — the DB cannot recompute a sha256 over
-- git blob shas in a CHECK). These make the ordered walk the *only* way in,
-- so bypassing promoteRelease() cannot produce a deployable release.

-- 1. A status change must follow the same edges promoteRelease()'s
--    ALLOWED_TRANSITIONS allows: candidate->verified->available, with
--    deprecated/retired as exits from any live state and nothing back out of
--    retired. INSERT is unrestricted (0016's seed, a fresh 'candidate'); this
--    only governs UPDATE OF status.
CREATE OR REPLACE FUNCTION control_plane.enforce_release_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
       (OLD.status = 'candidate'  AND NEW.status IN ('verified', 'retired'))
    OR (OLD.status = 'verified'   AND NEW.status IN ('available', 'deprecated', 'retired'))
    OR (OLD.status = 'available'  AND NEW.status IN ('deprecated', 'retired'))
    OR (OLD.status = 'deprecated' AND NEW.status = 'retired')
  ) THEN
    RAISE EXCEPTION
      'illegal release status transition: % -> % (release %)', OLD.status, NEW.status, OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER releases_status_transition_guard
  BEFORE UPDATE OF status ON control_plane.releases
  FOR EACH ROW
  EXECUTE FUNCTION control_plane.enforce_release_status_transition();

-- 2. 'available' is unreachable without the promotion bookkeeping promoteRelease()
--    writes on the verified->available hop. A hand UPDATE that sets only status
--    now fails this check instead of landing an unattributed release in the pool.
ALTER TABLE control_plane.releases
  ADD CONSTRAINT releases_available_requires_promotion
  CHECK (
    status <> 'available'
    OR (promoted_to_available_at IS NOT NULL AND promoted_by IS NOT NULL)
  );
