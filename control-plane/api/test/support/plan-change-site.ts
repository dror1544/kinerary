import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import type pg from "pg";

/**
 * A stand-in for a trip's own site, answering the one route the group line reads
 * (GET /api/internal/control-plane/plan-changes, server/living-journey.js), and the rows that make the control
 * plane find it: a trip, its ready runtime route and a succeeded job carrying the site's private URL.
 * Shared by the poller's and the end-to-end group-line tests.
 */

export interface StubPlan {
  active_revision_id: string;
  active_created_at: string;
  since_known: boolean;
  group_change_line: boolean;
  time_zone: string;
  language: "he" | "en";
  today: string;
  now_local: string;
  changes: Array<Record<string, unknown>>;
}

export interface StubRequest {
  url: string;
  since: string | null;
  apiKey: string | undefined;
  tripId: string | undefined;
}

export interface StubSite {
  /** http://localhost:<port> (a loopback IP literal is refused inside a job result, so the host is a name) */
  origin: string;
  requests: StubRequest[];
  /** What to answer. Absent keys fall to `plan`. */
  plan: StubPlan;
  /** Overrides the whole answer: a status and a raw body (a broken site). */
  broken: { status: number; body?: string; headers?: Record<string, string> } | null;
  close(): Promise<void>;
}

export const BASE_PLAN: StubPlan = {
  active_revision_id: "rev_base0001",
  active_created_at: "2026-12-03T12:00:00Z",
  since_known: true,
  group_change_line: true,
  time_zone: "Europe/Paris",
  language: "en",
  today: "2026-12-03",
  now_local: "14:00",
  changes: [],
};

export async function startStubSite(initial: Partial<StubPlan> = {}): Promise<StubSite> {
  const site: StubSite = {
    origin: "",
    requests: [],
    plan: { ...BASE_PLAN, ...initial },
    broken: null,
    close: async () => { await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }); },
  };
  const server: Server = createServer((req: IncomingMessage, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    site.requests.push({
      url: req.url ?? "",
      since: url.searchParams.get("since"),
      apiKey: req.headers["x-api-key"] as string | undefined,
      tripId: req.headers["x-control-plane-trip-id"] as string | undefined,
    });
    if (site.broken) {
      res.writeHead(site.broken.status, { "content-type": "application/json", ...(site.broken.headers ?? {}) });
      return res.end(site.broken.body ?? "{}");
    }
    if (url.pathname !== "/api/internal/control-plane/plan-changes") { res.writeHead(404); return res.end("{}"); }
    const since = url.searchParams.get("since");
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ...site.plan, since_known: since ? site.plan.since_known : false }));
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const address = server.address();
  site.origin = `http://localhost:${typeof address === "object" && address ? address.port : 0}`;
  return site;
}

const id = (prefix: string) => `${prefix}_${randomBytes(12).toString("hex")}`;

/** A trip with a ready runtime route to `origin`. Returns the trip id. */
export async function seedTrip(pool: pg.Pool, slug: string, origin: string): Promise<string> {
  const tripId = id("trip");
  await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'ready_private')", [tripId, slug]);
  const releaseId = id("rls");
  const digest = `sha256:${randomBytes(32).toString("hex")}`;
  await pool.query(
    `INSERT INTO control_plane.releases(id, source_revision, artifact_digest, application_schema, data_schema_min, data_schema_max, status, promoted_to_available_at, promoted_by)
     VALUES ($1, $2, $3, 1, 1, 1, 'available', now(), 'test:fixture')`,
    [releaseId, randomBytes(20).toString("hex"), digest],
  );
  const planId = id("plan");
  await pool.query(
    `INSERT INTO control_plane.plans(id, trip_id, release_id, kind, digest, status, desired)
     VALUES ($1, $2, $3, 'provision', $4, 'executed', '{}'::jsonb)`,
    [planId, tripId, releaseId, `sha256:${randomBytes(32).toString("hex")}`],
  );
  await pool.query(
    `INSERT INTO control_plane.jobs(id, trip_id, plan_id, job_type, idempotency_key, correlation_id, state, result)
     VALUES ($1, $2, $3, 'provision', $4, $5, 'succeeded', $6::jsonb)`,
    [id("job"), tripId, planId, id("idem"), id("corr"), JSON.stringify({ private_url: origin })],
  );
  await pool.query(
    "INSERT INTO control_plane.runtime_routes(trip_id, route_ref, state) VALUES ($1, $2, 'ready')",
    [tripId, `route_${randomBytes(8).toString("hex")}`],
  );
  return tripId;
}

/** An open Telegram group binding for the trip. Returns the binding id. */
export async function bindGroup(pool: pg.Pool, tripId: string, chatId: string): Promise<string> {
  const bindingId = id("tcb");
  await pool.query(
    "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ($1, $2, $3, 'profile')",
    [bindingId, chatId, tripId],
  );
  return bindingId;
}
