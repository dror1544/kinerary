// The super-admin dashboard's client (Sprint 6, docs/sprint6-tracks.md
// decision 23: slice 1's reads below, slice 2's suspend/retry mutations
// after them). A separate file from api.ts, deliberately: api.ts's `api()`
// sends the organizer's cookie session and a CSRF token, because it talks to
// routes scoped to the caller's own trips. Every route here — reads AND
// slice 2's mutations alike — is gated by a shared operator key (X-API-Key)
// instead, sent as an explicit header this file sets on every call. Reusing
// `api()` would either send a cookie these routes ignore, or carry a CSRF
// token these routes don't need: CSRF is an attack on AMBIENT credentials a
// browser attaches on its own (a cookie); an explicit header only this
// client code ever sets is not ambient, so a cross-site request cannot forge
// it the way it could a cookie-authenticated POST. That is also why slice 2's
// mutations could live here safely at all, rather than needing their own
// CSRF story bolted on afterward.
//
// DESIGN CHOICE, not a spec: the key is kept in `sessionStorage`, not
// `localStorage` — it does not outlive the tab — and never sent anywhere but
// these routes. There is no server-side admin session; entering the key
// again after closing the tab is the deliberate cost of that simplicity.

const ADMIN_KEY_STORAGE = "kinerary-admin-key";

export function getStoredAdminKey(): string {
  try {
    return sessionStorage.getItem(ADMIN_KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

export function storeAdminKey(key: string): void {
  try {
    sessionStorage.setItem(ADMIN_KEY_STORAGE, key);
  } catch {
    // Storage can be unavailable (private browsing, quota); the key still
    // works for the current render, it just will not survive a reload.
  }
}

export function clearAdminKey(): void {
  try {
    sessionStorage.removeItem(ADMIN_KEY_STORAGE);
  } catch {
    // Nothing to clean up if storage never worked in the first place.
  }
}

export class AdminApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
  }
}

async function adminApi<T>(key: string, path: string): Promise<T> {
  const response = await fetch(path, { headers: { "X-API-Key": key }, credentials: "same-origin" });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}) as Record<string, unknown>);
    throw new AdminApiError(
      typeof payload.error === "string" ? payload.error : "The request could not be completed.",
      response.status,
    );
  }
  return response.json() as Promise<T>;
}

// Slice 2 (suspend/retry, docs/sprint6-tracks.md decision 23): mutations,
// not reads, but still gated by the same operator key over the same header —
// there is no second credential here, see admin-mutations.ts's module doc
// for why. POST with a JSON body, never a GET-with-side-effects.
async function adminApiPost<T>(key: string, path: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "X-API-Key": key, "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}) as Record<string, unknown>);
    throw new AdminApiError(
      typeof payload.error === "string" ? payload.error : "The request could not be completed.",
      response.status,
    );
  }
  return response.json() as Promise<T>;
}

export type AdminJob = {
  id: string;
  tripId: string;
  tripSlug: string;
  jobType: string;
  state: string;
  attempt: number;
  safeErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminFunnelConversion = { from: string; to: string; fromCount: number; toCount: number; rate: number | null };
export type AdminFunnelSummary = {
  since: string | null;
  until: string | null;
  counts: Record<string, number>;
  conversions: AdminFunnelConversion[];
};

export type AdminRelease = {
  id: string;
  sourceRevision: string;
  artifactDigest: string;
  status: string;
  sanitationPassed: boolean | null;
  promotedToAvailableAt: string | null;
  promotedBy: string | null;
};

// NOT `result` — the route deliberately does not serve it (F1, boundary
// review on PR #275: jobs.result is unfiltered caller-shaped JSON, no
// allow-list worth building for it). safeErrorCode is the whole answer.
export type AdminFailure = {
  id: string;
  tripId: string;
  tripSlug: string;
  jobType: string;
  attempt: number;
  safeErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminAuditEvent = {
  id: string;
  actorRef: string;
  action: string;
  targetRef: string;
  correlationId: string;
  evidence: unknown;
  occurredAt: string;
};

export type AdminReport = {
  date: string;
  windowStart: string;
  windowEnd: string;
  funnel: AdminFunnelSummary;
  jobs: { byTypeAndState: { jobType: string; state: string; count: number }[] };
  releases: { byStatus: Record<string, number> };
  notMeasuredYet: readonly string[];
};

export const getAdminReport = (key: string) => adminApi<AdminReport>(key, "/v1/admin/report");
export const getAdminFunnel = (key: string) => adminApi<AdminFunnelSummary>(key, "/v1/admin/funnel");
export const getAdminJobs = (key: string) => adminApi<{ jobs: AdminJob[] }>(key, "/v1/admin/jobs");
export const getAdminFailures = (key: string) => adminApi<{ failures: AdminFailure[] }>(key, "/v1/admin/failures");
export const getAdminVersions = (key: string) => adminApi<{ releases: AdminRelease[] }>(key, "/v1/admin/versions");
export const getAdminAudit = (key: string) => adminApi<{ events: AdminAuditEvent[] }>(key, "/v1/admin/audit");

// ── Slice 2: suspend/retry mutations ────────────────────────────────────────
//
// Each call takes the trip id straight off a jobs-table row — this page has
// no separate trip picker — and reports the server's own refusal reason
// rather than guessing one client-side; app.ts's routes are the actual
// authorization, this is just the transport.

export type AdminRetryResult = { planId: string; planDigest: string; releaseId: string; jobId: string; supersededPlanId: string | null };
export type AdminSuspendResult = { tripId: string; suspendedAt: string };
export type AdminResumeResult = { tripId: string; reapprovalNeeded: boolean };

export const retryTrip = (key: string, tripId: string) =>
  adminApiPost<AdminRetryResult>(key, `/v1/admin/trips/${encodeURIComponent(tripId)}/retry`);

// `reason` is required server-side (app.ts: REASON_REQUIRED/REASON_TOO_LONG/
// REASON_INVALID on a 400) — the mandatory, audited justification that is
// this mutation's authorization story beyond the shared key.
export const suspendTrip = (key: string, tripId: string, reason: string) =>
  adminApiPost<AdminSuspendResult>(key, `/v1/admin/trips/${encodeURIComponent(tripId)}/suspend`, { reason });

export const resumeTrip = (key: string, tripId: string) =>
  adminApiPost<AdminResumeResult>(key, `/v1/admin/trips/${encodeURIComponent(tripId)}/resume`);
