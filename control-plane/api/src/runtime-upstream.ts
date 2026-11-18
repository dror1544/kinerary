import type pg from "pg";

/**
 * Where a trip's own site answers: the one lookup both the runtime gateway's route lookup
 * (`GET /internal/runtime-routes/:tripId`, portal.ts) and the group-line poller
 * (plan-change-poller.ts) make, so the two apply the SAME allow-list. A poller that read
 * `private_url` on its own would be a second place that decides which hosts the exchange key may
 * be sent to.
 *
 * The answer comes from `runtime_routes` (state `ready`) and the trip's last succeeded job's
 * `private_url`. The URL must be http(s) with no userinfo, query or fragment, and its host must
 * be one of `suffixes` (or a subdomain of one); anything else is `RUNTIME_ROUTE_INVALID`, and a
 * trip with no ready route or no URL is `RUNTIME_NOT_READY`.
 *
 * When the operator lists `web.runtime_upstream_allowed_hosts` and the route has a registered LAN
 * `upstream_url` (a wildcard-routed trip, docs/specs/sprint-9/x-wildcard-host-and-shared-bridge.md
 * AC-R1.11), that LAN origin is the answer instead: the trip's public name routes through the
 * gateway's host mode, which refuses `/api/internal/*`. An `upstream_url` that fails the allow-list is
 * `RUNTIME_ROUTE_INVALID`, never a fall-back to the public URL. `tripKey` is the KIND of exchange key
 * the trip's site holds (`shared` or `derived`), never a key.
 */
export type RuntimeUpstream =
  | { ok: true; routeRef: string; upstreamOrigin: string; upstreamBasePath: string; tripKey: string }
  | { ok: false; status: 404 | 503; error: "RUNTIME_NOT_READY" | "RUNTIME_ROUTE_INVALID" };

export async function runtimeUpstreamFor(
  db: Pick<pg.Pool, "query">,
  tripId: string,
  suffixes: readonly string[],
  allowedHosts?: readonly string[],
): Promise<RuntimeUpstream> {
  const result = await db.query<{ route_ref: string; private_url: string | null; upstream_url: string | null; trip_key: string }>(
    `SELECT r.route_ref, r.trip_key, r.upstream_url, j.result->>'private_url' AS private_url
     FROM control_plane.runtime_routes r
     LEFT JOIN LATERAL (
       SELECT result FROM control_plane.jobs
       WHERE trip_id = r.trip_id AND state = 'succeeded' AND result ? 'private_url'
       ORDER BY updated_at DESC LIMIT 1
     ) j ON true
     WHERE r.trip_id = $1 AND r.state = 'ready'`, [tripId]);
  const row = result.rows[0];
  if (!row?.private_url) return { ok: false, status: 404, error: "RUNTIME_NOT_READY" };
  if (row.upstream_url && allowedHosts?.length) {
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
