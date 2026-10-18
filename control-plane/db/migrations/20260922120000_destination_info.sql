-- rollback: compatible — three new columns with defaults; older code selects
-- `contacts` by name and never reads these, so the release before this one
-- keeps running unchanged on the schema it leaves behind.

-- Destination-info enrichment (Health / Money / Communication on the site's
-- Info tab) extends country_reference's scope: it was built for consular
-- contacts, which are a fact about (destination, home) pair, and now also
-- carries facts about the DESTINATION ALONE.
--
-- Those destination-only facts are therefore DUPLICATED once per home-country
-- row that shares a destination. That duplication is a deliberate, recorded
-- decision (Dror, 2026-09-22): a second table keyed by destination alone would
-- be normal-form-correct and would add a second store, a second staleness
-- clock and a second join to every read, for a table whose row count is
-- "countries people have travelled to". The duplication is a storage cost; it
-- is NOT licence to recompute per pairing. The refresh job computes a
-- destination ONCE and fans the same value out to every home_country row for
-- it in a single UPDATE (destination-info-store.ts, `writeDestinationInfo`),
-- so the model is paid for once per destination per month however many home
-- countries point at it.
--
-- `destination_info_fetched_at` is a SECOND clock, deliberately not `fetched_at`.
-- `fetched_at` is the consular clock and `consularContactsFor` reads it for its
-- 180-day staleness test (interview.ts, CONSULAR_MAX_AGE_DAYS). Refreshing
-- destination prose through `fetched_at` would silently re-date the embassy
-- phone numbers as freshly verified when nothing had re-verified them — two
-- facts with different sources and different refresh periods need two clocks.
--
-- NULL means "never fetched", which is what the refresh job selects on. A row
-- inserted by the consular path for a destination whose info is already cached
-- arrives NULL and is picked up on the next pass; that is how the duplicates
-- converge rather than drift (see `bool_or(... IS NULL)` in the selection).

ALTER TABLE control_plane.country_reference
  ADD COLUMN destination_info            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN destination_info_source     text,
  ADD COLUMN destination_info_fetched_at timestamptz;

COMMENT ON COLUMN control_plane.country_reference.destination_info IS
  'Health / money / communication prose for the destination alone: {"health":[{he,en}],"money":[...],"communication":[...]}. Model-sourced (there is no keyless API for it); the deterministic half — currency, calling code, emergency numbers — is computed per trip in the worker and is never stored here. Duplicated across home_country rows by design; kept in sync by a destination-keyed fan-out.';

COMMENT ON COLUMN control_plane.country_reference.destination_info_fetched_at IS
  'When destination_info was last re-verified. NULL = never. Separate from fetched_at, which is the consular-contacts clock.';

COMMENT ON TABLE control_plane.country_reference IS
  'Cross-trip destination facts keyed by (destination_country, home_country): consular contacts (per pair, filled by a web search at interview time) and destination info (per destination, filled by the monthly refresh job and duplicated across the pairs). Both read by enrich_config at provision time.';
