-- rollback: compatible — adds two nullable columns; older code ignores them
-- Wildcard host routing (docs/specs/sprint-9/x-wildcard-host-and-shared-bridge.md, R1).
--
-- The runtime gateway's host mode routes a request by its Host header: it asks
-- GET /internal/runtime-routes/by-host/:host, which reads these two columns.
--   public_host  the trip's own hostname, e.g. <slug>.<trip domain> (lower case)
--   upstream_url the trip site's origin on the LAN, e.g. http://<address>:<port>
-- Both are written by the worker when a trip is provisioned and cleared when it
-- is torn down. NULL means "no host route": a row created before this migration
-- behaves exactly as it does today (the per-trip-id lookup does not read either).
--
-- upstream_url is checked against web.runtime_upstream_allowed_hosts when it is
-- READ, not here: the allow-list is configuration, not schema.

ALTER TABLE control_plane.runtime_routes
  ADD COLUMN public_host text,
  ADD COLUMN upstream_url text;

ALTER TABLE control_plane.runtime_routes
  ADD CONSTRAINT runtime_routes_public_host_dns CHECK (
    public_host IS NULL OR (
      length(public_host) <= 253
      AND public_host ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
    )
  );

-- One name, one trip. A second trip claiming a taken name fails at write time
-- instead of the gateway picking one of two.
CREATE UNIQUE INDEX runtime_routes_public_host_key
  ON control_plane.runtime_routes (public_host)
  WHERE public_host IS NOT NULL;
