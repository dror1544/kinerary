import type pg from "pg";

/**
 * Where a trip's own site answers: the one lookup the runtime gateway's route lookup
 * (`GET /internal/runtime-routes/:tripId`, portal.ts) makes. The group-line poller
 * (plan-change-poller.ts) calls it too, but only to learn whether a trip has a ready, valid route
 * before asking the gateway; it never uses the origin (the control plane sends no key to a trip
 * site, the gateway does), so the allow-list that decides where a key may go is still applied in
 * one place, here, on the gateway's behalf.
 *
 * The answer comes from `runtime_routes` (state `ready`) and the trip's last succeeded job's
 * `private_url`. The URL must be http(s) with no userinfo, query or fragment, and its host must
 * be one of `suffixes` (or a subdomain of one); anything else is `RUNTIME_ROUTE_INVALID`, and a
 * trip with no ready route or no URL is `RUNTIME_NOT_READY`.
 *
 * When the route has a registered LAN `upstream_url` (a trip served through the gateway,
 * docs/specs/sprint-9/x-wildcard-host-and-shared-bridge.md AC-R1.11 and AC-R2.5), that LAN origin is the
 * answer instead: the trip's public name routes through the gateway's host mode, which refuses
 * `/api/internal/*`. An `upstream_url` that fails `web.runtime_upstream_allowed_hosts`, or any
 * `upstream_url` when that list is empty or absent, or one another ready route also registers, is
 * `RUNTIME_ROUTE_INVALID`: never a fall-back to the public URL. `tripKey` is the KIND of exchange key
 * the trip's site holds (`shared` or `derived`), never a key.
 */
/**
 * SQL for "another READY route registers the same LAN origin as row `r`" (trailing slash and case ignored). One
 * address is one trip: when two ready rows share one, the gateway would send one trip's visitors and key to the
 * other's container, so both lookups refuse such a row (boundary review of #599, 2026-11-19, F2). The worker
 * refuses to write one; this holds whatever wrote the rows.
 */
export const UPSTREAM_SHARED_SQL = `EXISTS (
  SELECT 1 FROM control_plane.runtime_routes o
  WHERE o.trip_id <> r.trip_id AND o.state = 'ready' AND o.upstream_url IS NOT NULL
    AND lower(rtrim(o.upstream_url, '/')) = lower(rtrim(r.upstream_url, '/')))`;

export type RuntimeUpstream =
  | { ok: true; routeRef: string; upstreamOrigin: string; upstreamBasePath: string; tripKey: string }
  | { ok: false; status: 404 | 503; error: "RUNTIME_NOT_READY" | "RUNTIME_ROUTE_INVALID" };

export async function runtimeUpstreamFor(
  db: Pick<pg.Pool, "query">,
  tripId: string,
  suffixes: readonly string[],
  allowedHosts?: readonly string[],
): Promise<RuntimeUpstream> {
  const result = await db.query<{ route_ref: string; private_url: string | null; upstream_url: string | null; trip_key: string; shared: boolean }>(
    `SELECT r.route_ref, r.trip_key, r.upstream_url, j.result->>'private_url' AS private_url,
            (r.upstream_url IS NOT NULL AND ${UPSTREAM_SHARED_SQL}) AS shared
     FROM control_plane.runtime_routes r
     LEFT JOIN LATERAL (
       SELECT result FROM control_plane.jobs
       WHERE trip_id = r.trip_id AND state = 'succeeded' AND result ? 'private_url'
       ORDER BY updated_at DESC LIMIT 1
     ) j ON true
     WHERE r.trip_id = $1 AND r.state = 'ready'`, [tripId]);
  const row = result.rows[0];
  if (!row?.private_url) return { ok: false, status: 404, error: "RUNTIME_NOT_READY" };
  if (row.upstream_url) {
    // The row says this trip's public name is served THROUGH the gateway (AC-R2.5), whose host mode refuses
    // `/api/internal/*`: the public URL is never the answer for it. With no list there is nothing to validate
    // the LAN origin against, so it is refused like an off-list one (boundary review of #599, F4).
    if (!allowedHosts?.length || row.shared) return { ok: false, status: 503, error: "RUNTIME_ROUTE_INVALID" };
    let lan: URL;
    try { lan = new URL(row.upstream_url); } catch { return { ok: false, status: 503, error: "RUNTIME_ROUTE_INVALID" }; }
    if (!["http:", "https:"].includes(lan.protocol) || lan.username || lan.password || lan.pathname !== "/"
      || lan.search || lan.hash || /[?#]/.test(row.upstream_url) || !upstreamHostAllowed(lan.hostname, allowedHosts)) {
      return { ok: false, status: 503, error: "RUNTIME_ROUTE_INVALID" };
    }
    return { ok: true, routeRef: row.route_ref, upstreamOrigin: lan.origin, upstreamBasePath: "", tripKey: row.trip_key };
  }
  let upstream: URL;
  try { upstream = new URL(row.private_url); } catch { return { ok: false, status: 503, error: "RUNTIME_ROUTE_INVALID" }; }
  const allowed = suffixes.some((suffix) => upstream.hostname === suffix || upstream.hostname.endsWith(`.${suffix}`));
  if (!["http:", "https:"].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash || !allowed) {
    return { ok: false, status: 503, error: "RUNTIME_ROUTE_INVALID" };
  }
  return { ok: true, routeRef: row.route_ref, upstreamOrigin: upstream.origin, upstreamBasePath: upstream.pathname.replace(/\/$/, ""), tripKey: row.trip_key };
}

/**
 * Is the registered upstream's host one the operator named in `web.runtime_upstream_allowed_hosts`?
 * Entries are exact hostnames, IPv4 addresses and IPv4 CIDR blocks (config.ts); an absent or empty list
 * allows nothing. `hostname` is `URL.hostname`, which has already canonicalised an IPv4 spelling such as
 * `0x7f.1`; an IPv6 literal (bracketed) matches nothing.
 */
export function upstreamHostAllowed(hostname: string, allowed: readonly string[] | undefined): boolean {
  if (!allowed?.length) return false;
  const host = hostname.toLowerCase();
  const ipv4 = (value: string): number | null => {
    const parts = value.split(".");
    if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return null;
    return ((Number(parts[0]) << 24) | (Number(parts[1]) << 16) | (Number(parts[2]) << 8) | Number(parts[3])) >>> 0;
  };
  const address = ipv4(host);
  for (const raw of allowed) {
    const entry = raw.toLowerCase();
    if (entry === host) return true;
    const slash = entry.indexOf("/");
    if (slash === -1 || address === null) continue;
    const base = ipv4(entry.slice(0, slash)), bits = Number(entry.slice(slash + 1));
    if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((address & mask) >>> 0) === ((base & mask) >>> 0)) return true;
  }
  return false;
}
