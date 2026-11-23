-- rollback: compatible — adds a column with a default; older code ignores it
-- Per-trip exchange keys (docs/specs/sprint-9/597-per-gateway-and-per-trip-keys.md, K2).
--
-- Which kind of key does this trip's site hold in its .env?
--   shared   the control plane's old, deployment-wide exchange key (what every trip held before).
--   derived  HMAC-SHA256(trip master, "kinerary-trip-exchange:v1:" + trip_id): this trip's own key.
-- The runtime gateway reads it from the route lookups and sends the matching key to the trip. It never
-- tries one key and then the other. The column holds a KIND, never a key.
--
-- Every row that exists now holds the shared key, so 'shared' is the truth for all of them, and the
-- default is the only value an older worker (one that does not know this column) can leave behind.
-- The worker sets 'derived' when it writes a new trip's key (AC-K2.4).

ALTER TABLE control_plane.runtime_routes
  ADD COLUMN trip_key text NOT NULL DEFAULT 'shared' CHECK (trip_key IN ('shared', 'derived'));
