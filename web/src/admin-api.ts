// The super-admin dashboard's client (Sprint 6 slice 1, docs/sprint6-tracks.md
// decision 23). A separate file from api.ts, deliberately: api.ts's `api()`
// sends the organizer's cookie session and a CSRF token, because it talks to
// routes scoped to the caller's own trips. Every route here is read-only and
// gated by a shared operator key (X-API-Key) instead — reusing `api()` would
// either send a cookie these routes ignore, or tempt a future edit to add a
// mutation through a helper that was never CSRF-protected for one.
//
// DESIGN CHOICE, not a spec: the key is kept in `sessionStorage`, not
// `localStorage` — it does not outlive the tab — and never sent anywhere but
// these six routes. There is no server-side admin session; entering the key
// again after closing the tab is the deliberate cost of that simplicity for a
// slice 1 read surface.

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

export type AdminFailure = {
  id: string;
  tripId: string;
  tripSlug: string;
  jobType: string;
  attempt: number;
  safeErrorCode: string | null;
  result: unknown;
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
