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
 */
export type RuntimeUpstream =
  | { ok: true; routeRef: string; upstreamOrigin: string; upstreamBasePath: string }
  | { ok: false; status: 404 | 503; error: "RUNTIME_NOT_READY" | "RUNTIME_ROUTE_INVALID" };

export async function runtimeUpstreamFor(
  db: Pick<pg.Pool, "query">,
  tripId: string,
  suffixes: readonly string[],
): Promise<RuntimeUpstream> {
  const result = await db.query<{ route_ref: string; private_url: string | null }>(
    `SELECT r.route_ref, j.result->>'private_url' AS private_url
     FROM control_plane.runtime_routes r
     LEFT JOIN LATERAL (
       SELECT result FROM control_plane.jobs
       WHERE trip_id = r.trip_id AND state = 'succeeded' AND result ? 'private_url'
       ORDER BY updated_at DESC LIMIT 1
     ) j ON true
     WHERE r.trip_id = $1 AND r.state = 'ready'`, [tripId]);
  const row = result.rows[0];
  if (!row?.private_url) return { ok: false, status: 404, error: "RUNTIME_NOT_READY" };
  let upstream: URL;
  try { upstream = new URL(row.private_url); } catch { return { ok: false, status: 503, error: "RUNTIME_ROUTE_INVALID" }; }
  const allowed = suffixes.some((suffix) => upstream.hostname === suffix || upstream.hostname.endsWith(`.${suffix}`));
  if (!["http:", "https:"].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash || !allowed) {
    return { ok: false, status: 503, error: "RUNTIME_ROUTE_INVALID" };
  }
  return { ok: true, routeRef: row.route_ref, upstreamOrigin: upstream.origin, upstreamBasePath: upstream.pathname.replace(/\/$/, "") };
}
