-- Cross-trip reference store for a venue's official / ticket URL, filled by the
-- same web search as country_reference (migration 0023) and reused the same
-- way: extract_itinerary web-searches for a venue's first-party link when the
-- uploaded document didn't print one, and every later trip that names the same
-- place in the same destination reads the row instead of searching again.
--
-- A row with url IS NULL is a *deferred* lookup: the interview-time search hit
-- a provider rate limit, so the name is parked here for the API's background
-- drain (resolvePendingVenueLinks) to retry later. enrich_config's per-venue
-- pass reads url IS NOT NULL rows at provision time, so a link the drain fills
-- after CONFIRM still reaches the site on the next provision.
--
-- Keyed by (destination, venue_name) as free-text display names the interview
-- captured (normalised lower-case), not ids — the search prompt and the site
-- card both use the display name.

CREATE TABLE control_plane.venue_links (
  destination text        NOT NULL,
  venue_name  text        NOT NULL,
  url         text,
  source      text,
  attempts    integer     NOT NULL DEFAULT 0,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (destination, venue_name)
);

-- The drain scans for unresolved rows; keep that lookup off a seq scan as the
-- table grows across trips.
CREATE INDEX venue_links_unresolved_idx
  ON control_plane.venue_links (destination)
  WHERE url IS NULL;

COMMENT ON TABLE control_plane.venue_links IS
  'Cross-trip venue official/ticket URLs keyed by (destination, venue_name); url IS NULL means a rate-limited lookup awaiting the API background retry. Populated by web search, read by enrich_config at provision time.';
