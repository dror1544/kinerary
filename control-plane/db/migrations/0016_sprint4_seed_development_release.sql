-- Sprint 4's build list called for seeding a development release record so
-- generatePlan (Sprint 3) can select a compatible release: "One migration or
-- seed script is sufficient; no release-build pipeline yet." That step was
-- never actually written -- every planner/provisioner test seeds its own
-- throwaway release row and cleans it up, so the gap was invisible to CI,
-- but generatePlan has had no 'available' release to select against the real
-- database since Sprint 3 landed. This is that seed, not a superseding
-- change: the release-artifact renderer, sanitation scan, sealed manifest
-- and promotion pipeline (`candidate` -> `available`) remain deferred
-- hardening work per the sprint plan's Sprint 4 section.
INSERT INTO control_plane.releases (
  id, source_revision, artifact_digest, application_schema,
  data_schema_min, data_schema_max, status
) VALUES (
  'release_localdev0001',
  '2131ba61b6fa02eabdb0f388a4d707fea875961f',
  'sha256:2620da679849b515032d360a27a018b58e92f036d5b3902271fac94035e43ac1',
  1, 1, 1, 'available'
);
