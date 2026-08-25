-- INTAKE_SCHEMA_VERSION moved 1 -> 2 when the interview gained the assistant
-- persona, dietary and pace questions (and the 'multi_choice' answer kind that
-- carries them). generatePlan selects a release with
-- `data_schema_min <= $1 AND data_schema_max >= $1` (api/src/planner.ts), and
-- the only seeded release advertises 1..1 — so without this widening every
-- newly confirmed intake plans against nothing and provisioning stops dead.
--
-- Widening rather than seeding a second release: the v1 and v2 answer sets are
-- additive (every new question is optional, and transform_intake reproduces
-- its v1 output byte-for-byte when they're absent), so one release genuinely
-- does serve both. A second release row would also need its own artifact
-- digest, which the deferred release-build pipeline is what actually produces.
UPDATE control_plane.releases
   SET data_schema_max = 2
 WHERE id = 'release_localdev0001'
   AND data_schema_max < 2;
