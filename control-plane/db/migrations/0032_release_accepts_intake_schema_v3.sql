-- INTAKE_SCHEMA_VERSION moved 2 -> 3 when `group_size` and `trip_duration`
-- were removed from the interview: headcount is now counted off the traveler
-- roster, and duration is the difference between the two date questions, both
-- of which the interview already required (capture ledger, Step 3 #3 and #4).
-- generatePlan selects a release with
-- `data_schema_min <= $1 AND data_schema_max >= $1` (api/src/planner.ts), so
-- without a widening every newly confirmed intake plans against nothing.
--
-- This is NOT the same situation migration 0018 widened for, and the
-- difference is the reason the version moved at all. 2 -> 3 REMOVES two
-- questions that the previous transformer lists in REQUIRED_QUESTIONS and
-- raises a ValueError on when absent. So a release is only genuinely able to
-- serve v3 if its artifact contains a transformer that derives both — the one
-- in this commit. Widening a release that predates it would buy an eligible
-- release and then fail at transform time, holding a confirmed intake with
-- nowhere to go. The version's whole job here is to make that release visibly
-- ineligible instead.
--
-- Which is why this widens exactly one row, and a hand-seeded one. Local dev
-- runs `release_localdev0001` unsealed, where the "artifact" is the ambient
-- REPO_ROOT checkout (CONTROL_PLANE_ALLOW_UNSEALED_RELEASE in
-- compose.local.yml) — so it carries the new transformer by construction, and
-- widening it is truthful. Every sealed release is digest-verified against a
-- built artifact and must advertise its own range at build time; none is
-- retroactively widened here, and a real deployment needs a release built
-- from this commit or later before it can serve a v3 intake.
UPDATE control_plane.releases
   SET data_schema_max = 3
 WHERE id = 'release_localdev0001'
   AND data_schema_max < 3;
