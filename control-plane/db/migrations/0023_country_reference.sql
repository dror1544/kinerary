-- Cross-trip reference store for facts that are true of a destination country
-- regardless of which trip is asking — starting with consular contacts (the
-- traveler's home-country embassy/consulate in the destination). There is no
-- keyless API for this, so it is filled by a web search at interview time
-- (interview-mcp's lookup_consular_contacts tool) and then reused: every later
-- trip to the same (destination, home) pair reads the row instead of
-- searching again. enrich_config populates travel_info.emergency_contacts
-- from it at provision time.
--
-- Keyed by (destination_country, home_country) because which embassy matters
-- is the traveler's nationality, not just where they are. Both are free-text
-- country names as the interview captured them (normalised lower-case), not
-- ISO codes — the search prompt and the site card both use the display name.

CREATE TABLE control_plane.country_reference (
  destination_country text        NOT NULL,
  home_country        text        NOT NULL,
  contacts            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  source              text,
  fetched_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (destination_country, home_country)
);

COMMENT ON TABLE control_plane.country_reference IS
  'Cross-trip destination facts (consular contacts) keyed by (destination_country, home_country); populated by a web search at interview time, read by enrich_config at provision time.';
