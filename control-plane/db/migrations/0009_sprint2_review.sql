-- Sprint 2 review: DB-backed uniqueness for active enrollments
--
-- Without this index, the app-layer check in issueEnrollment has a TOCTOU gap:
-- two concurrent calls can both read zero 'issued' rows and both insert, leaving
-- two active enrollment tokens for the same trip. This partial unique index lets
-- PostgreSQL enforce the invariant transactionally and lets the app catch the
-- resulting unique_violation (SQLSTATE 23505) to return ACTIVE_ENROLLMENT_EXISTS.

CREATE UNIQUE INDEX interview_enrollments_trip_issued_idx
  ON control_plane.interview_enrollments (trip_id)
  WHERE state = 'issued';
