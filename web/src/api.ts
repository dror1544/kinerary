import { z } from "zod";

export type Me = {
  id: string;
  displayName: string;
  isProvisioningAdmin: boolean;
};

export type InviteSummary = {
  id: string;
  displayName: string;
  runtimeUsername: string;
  status: "unused" | "redeemed" | "expired" | "revoked";
  expiresAt: string;
};

export type TripSummary = {
  id: string;
  title: string;
  destination: string | null;
  startDate: string | null;
  endDate: string | null;
  tripType: string;
  lifecycleState: string;
  nextAction: string;
  interview: { sessionId: string; state: string } | null;
  provisioning: { planId: string; planStatus: string; reviewState: string | null; jobState: string | null; safeErrorCode: string | null } | null;
  runtimeReady: boolean;
  permissions: { role: string; dashboard: boolean; runtime: boolean; invite: boolean; requestProvisioning: boolean };
  invites?: InviteSummary[];
};

function csrfToken() {
  return document.cookie
    .split("; ")
    .find((part) => part.startsWith("kit_csrf="))
    ?.split("=")[1];
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const method = (init.method || "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const token = csrfToken();
    if (token) headers.set("X-CSRF-Token", decodeURIComponent(token));
  }
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message || payload.error || "The request could not be completed.");
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const inviteSchema = z.object({
  id: z.string(), displayName: z.string(), runtimeUsername: z.string(),
  status: z.enum(["unused", "redeemed", "expired", "revoked"]), expiresAt: z.string(),
});
const tripSchema: z.ZodType<TripSummary> = z.object({
  id: z.string(), title: z.string(), destination: z.string().nullable(), startDate: z.string().nullable(), endDate: z.string().nullable(),
  tripType: z.string(), lifecycleState: z.string(), nextAction: z.string(),
  interview: z.object({ sessionId: z.string(), state: z.string() }).nullable(),
  provisioning: z.object({ planId: z.string(), planStatus: z.string(), reviewState: z.string().nullable(), jobState: z.string().nullable(), safeErrorCode: z.string().nullable() }).nullable(),
  runtimeReady: z.boolean(),
  permissions: z.object({ role: z.string(), dashboard: z.boolean(), runtime: z.boolean(), invite: z.boolean(), requestProvisioning: z.boolean() }),
  invites: z.array(inviteSchema).optional(),
});
const meSchema: z.ZodType<Me> = z.object({ id: z.string(), displayName: z.string(), isProvisioningAdmin: z.boolean() });

export function signIn(returnTo: string) {
  window.location.assign(`/v1/auth/google/start?return_to=${encodeURIComponent(returnTo)}`);
}

export const getMe = () => api<unknown>("/v1/me").then((value) => meSchema.parse(value));
export const getTrips = () => api<unknown>("/v1/trips").then((value) => z.object({ trips: z.array(tripSchema) }).parse(value));
export const getTrip = (id: string) => api<unknown>(`/v1/trips/${encodeURIComponent(id)}`).then((value) => tripSchema.parse(value));
