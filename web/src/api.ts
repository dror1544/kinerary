import { z } from "zod";

export type Me = {
  id: string;
  displayName: string;
  /**
   * "telegram": signed in through a Telegram link, so this session sees only the trips that Telegram
   * account is linked to; the full dashboard needs a password or Google sign-in. Absent = full.
   */
  scope?: "telegram" | "full";
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
  provisioning: { planId: string; planStatus: string; jobState: string | null; releaseId: string | null; digest: string; safeErrorCode: string | null } | null;
  runtimeReady: boolean;
  permissions: { role: string; dashboard: boolean; runtime: boolean; invite: boolean; requestProvisioning: boolean };
  invites?: InviteSummary[];
  /** Organizer view only: who is on the trip, for "remove member". */
  members?: MemberSummary[];
  /** The Telegram accounts that can open THIS trip as the viewer: the card's icon and its Unlink entries. */
  telegram?: { links: TelegramLink[]; /** Unlinked accounts that can be restored without Telegram: absent for a Telegram-minted session. */ unlinked?: UnlinkedTelegramLink[] };
};

export type TelegramLinkVia = "interview_link" | "earlier_interview" | "dashboard_link" | "dashboard_restore" | "trip_password" | "invite";

export type UnlinkedTelegramLink = { id: string; via: TelegramLinkVia; linkedAt: string; unlinkedAt: string };

export type TelegramLink = {
  id: string; via: TelegramLinkVia;
  linkedAt: string; firstSignedInAt: string | null; lastSignedInAt: string | null;
};

export type MemberSummary = { id: string; displayName: string; role: string; runtimeUsername: string | null; you: boolean; removable: boolean };

function csrfToken() {
  return document.cookie
    .split("; ")
    .find((part) => part.startsWith("kit_csrf="))
    ?.split("=")[1];
}

export class ApiError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export type InterviewLinkState = {
  activeEnrollment: { id: string; expiresAt: string } | null;
  recoverable: boolean; hasInterview: boolean; telegramChatUrl: string;
};

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
    const messages: Record<string, string> = {
      INVALID_CREDENTIALS: "Email or password is incorrect.",
      SIGN_IN_RATE_LIMITED: "Too many sign-in attempts. Please try again in a minute.",
      GOOGLE_SIGN_IN_UNAVAILABLE: "Google sign-in is not available here.",
      ACTIVE_ENROLLMENT_EXISTS: "An interview link already exists. You can replace a lost link before the interview starts.",
      TRIP_NOT_DRAFT: "Your interview has already started. Continue in your existing Telegram chat.",
      INTERVIEW_ALREADY_STARTED: "Your interview has already started. Continue in your existing Telegram chat.",
      ENROLLMENT_NOT_REPLACEABLE: "This link changed or was already used. Check the trip status before continuing.",
      ENROLLMENT_BUSY: "Trip setup is changing. Please try again.",
      RATE_LIMITED: "Too many requests. Please wait a minute and try again.",
      ACCOUNT_SIGN_IN_REQUIRED: "Sign in with your password to do this.",
      ORIGIN_INVALID: "Please sign in from the Kinerary website.",
      TELEGRAM_NOT_LINKED: "This Telegram account is not linked yet.",
    };
    throw new ApiError(typeof payload.error === "string" ? payload.error : "REQUEST_FAILED", messages[payload.error] || payload.message || payload.error || "The request could not be completed.");
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const inviteSchema = z.object({
  id: z.string(), displayName: z.string(), runtimeUsername: z.string(),
  status: z.enum(["unused", "redeemed", "expired", "revoked"]), expiresAt: z.string(),
});
const memberSchema: z.ZodType<MemberSummary> = z.object({
  id: z.string(), displayName: z.string(), role: z.string(), runtimeUsername: z.string().nullable(), you: z.boolean(), removable: z.boolean(),
});
const telegramViaSchema = z.enum(["interview_link", "earlier_interview", "dashboard_link", "dashboard_restore", "trip_password", "invite"]);
const unlinkedTelegramLinkSchema: z.ZodType<UnlinkedTelegramLink> = z.object({ id: z.string(), via: telegramViaSchema, linkedAt: z.string(), unlinkedAt: z.string() });
const telegramLinkSchema: z.ZodType<TelegramLink> = z.object({
  id: z.string(), via: telegramViaSchema,
  linkedAt: z.string(), firstSignedInAt: z.string().nullable(), lastSignedInAt: z.string().nullable(),
});
const telegramSchema = z.object({ links: z.array(telegramLinkSchema), unlinked: z.array(unlinkedTelegramLinkSchema).optional() });
const tripSchema: z.ZodType<TripSummary> = z.object({
  id: z.string(), title: z.string(), destination: z.string().nullable(), startDate: z.string().nullable(), endDate: z.string().nullable(),
  tripType: z.string(), lifecycleState: z.string(), nextAction: z.string(),
  interview: z.object({ sessionId: z.string(), state: z.string() }).nullable(),
  provisioning: z.object({ planId: z.string(), planStatus: z.string(), jobState: z.string().nullable(), releaseId: z.string().nullable(), digest: z.string(), safeErrorCode: z.string().nullable() }).nullable(),
  runtimeReady: z.boolean(),
  permissions: z.object({ role: z.string(), dashboard: z.boolean(), runtime: z.boolean(), invite: z.boolean(), requestProvisioning: z.boolean() }),
  invites: z.array(inviteSchema).optional(),
  members: z.array(memberSchema).optional(),
  telegram: telegramSchema.optional(),
});
// What a member WITHOUT dashboard access gets in their list: name, place, dates, their own
// permissions and whether it opens. Filled out to a TripSummary with neutral defaults.
const memberTripSchema = z.object({
  id: z.string(), title: z.string(), destination: z.string().nullable(), startDate: z.string().nullable(), endDate: z.string().nullable(),
  permissions: z.object({ role: z.string(), dashboard: z.boolean(), runtime: z.boolean(), invite: z.boolean(), requestProvisioning: z.boolean() }),
  runtimeReady: z.boolean(),
  telegram: telegramSchema.optional(),
}).transform((trip): TripSummary => ({
  ...trip, tripType: "other", lifecycleState: "ready_private", nextAction: trip.runtimeReady ? "open_trip" : "view_status",
  interview: null, provisioning: null,
}));
const meSchema: z.ZodType<Me> = z.object({ id: z.string(), displayName: z.string(), scope: z.enum(["telegram", "full"]).optional() });

export function signIn(returnTo: string) {
  window.location.assign(`/v1/auth/google/start?return_to=${encodeURIComponent(returnTo)}`);
}

export function passwordSignIn(input: {
  tripId: string; runtimeUsername: string; password: string; returnTo: string;
  /** "Next time, open with Telegram": only ever sent with the person's explicit consent. */
  telegramLink?: { initData: string; consent: true };
  /** The page is inside a frame on another site (Telegram Web): ask for the cross-site cookie variant. */
  embedded?: true;
}) {
  return api<{ appPath: string; telegramLink?: "linked" | "skipped" }>("/v1/auth/password", { method: "POST", body: JSON.stringify(input) });
}

export type MiniAppTrip = { tripId: string; title: string; destination: string | null; startDate: string | null; endDate: string | null };
export type MiniAppSignInResult =
  | { kind: "session"; appPath: string; notice?: "TRIP_UNAVAILABLE" }
  | { kind: "choose"; trips: MiniAppTrip[]; notice?: "TRIP_UNAVAILABLE" }
  | { kind: "not_linked"; fallback: "trip_password" | "none"; tripId?: string }
  /** Telegram's signature did not verify, or the launch has been used up: reopen from Telegram. */
  | { kind: "invalid" }
  | { kind: "limited" }
  /** Feature off, wrong origin, network: nothing to retry in place. */
  | { kind: "unavailable" };

const miniAppTripSchema = z.object({ tripId: z.string(), title: z.string(), destination: z.string().nullable(), startDate: z.string().nullable(), endDate: z.string().nullable() });
const miniAppAppPath = /^\/mini-app(?:\/trips\/trip_[A-Za-z0-9]{8,64})?$/;

/**
 * Exchanges Telegram's signed launch string for a session. The string is sent
 * in the POST body only (never a URL, never a header), and the server — not
 * this client — decides who the person is.
 */
export async function telegramMiniAppSignIn(input: { initData: string; tripId?: string; embedded?: boolean }): Promise<MiniAppSignInResult> {
  let response: Response;
  try {
    response = await fetch("/v1/auth/telegram-mini-app", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: input.initData, ...(input.tripId ? { tripId: input.tripId } : {}), ...(input.embedded ? { embedded: true } : {}) }),
    });
  } catch { return { kind: "unavailable" }; }
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (response.status === 429) return { kind: "limited" };
  if (response.status === 401 && body.error === "TELEGRAM_INIT_DATA_INVALID") return { kind: "invalid" };
  if (response.status === 401 && body.error === "TELEGRAM_NOT_LINKED") {
    const tripId = typeof body.tripId === "string" && /^trip_[A-Za-z0-9]{8,64}$/.test(body.tripId) ? body.tripId : undefined;
    return body.fallback === "trip_password" && tripId ? { kind: "not_linked", fallback: "trip_password", tripId } : { kind: "not_linked", fallback: "none" };
  }
  if (!response.ok) return { kind: "unavailable" };
  const notice = body.notice === "TRIP_UNAVAILABLE" ? "TRIP_UNAVAILABLE" as const : undefined;
  if (body.kind === "session" && typeof body.appPath === "string" && miniAppAppPath.test(body.appPath)) return { kind: "session", appPath: body.appPath, ...(notice ? { notice } : {}) };
  if (body.kind === "choose") {
    const trips = z.array(miniAppTripSchema).safeParse(body.trips);
    if (trips.success) return { kind: "choose", trips: trips.data, ...(notice ? { notice } : {}) };
  }
  return { kind: "unavailable" };
}

export const unlinkTelegramLink = (id: string) => api<{ status: string }>(`/v1/account/telegram-links/${encodeURIComponent(id)}`, { method: "DELETE" });
/** Brings back an Unlinked Telegram account with no Telegram round trip (full sessions only; a Telegram-minted session gets 403). */
export const restoreTelegramLink = (id: string) => api<{ status: string }>(`/v1/account/telegram-links/${encodeURIComponent(id)}/restore`, { method: "POST" });
const issuedLinkSchema = z.object({ deepLink: z.string().regex(/^https:\/\/t\.me\/[A-Za-z0-9_]+\?start=[A-Za-z0-9_-]+$/), expiresAt: z.string() });
/** A one-time, short-lived t.me link that links whichever Telegram account opens it to THIS trip. */
export const issueTelegramLink = (tripId: string) =>
  api<unknown>(`/v1/trips/${encodeURIComponent(tripId)}/telegram-link`, { method: "POST" }).then((value) => issuedLinkSchema.parse(value));

export const getMe = () => api<unknown>("/v1/me").then((value) => meSchema.parse(value));
export const getTrips = () => api<unknown>("/v1/trips").then((value) => z.object({ trips: z.array(z.union([tripSchema, memberTripSchema])) }).parse(value));
export const getTrip = (id: string) => api<unknown>(`/v1/trips/${encodeURIComponent(id)}`).then((value) => tripSchema.parse(value));

export const getAuthCapabilities = () => api<unknown>("/v1/auth/capabilities").then(value => z.object({ google: z.boolean(), emailPassword: z.boolean(), telegramMiniApp: z.boolean().optional() }).parse(value));
export const emailPasswordSignIn = (input: { email: string; password: string; returnTo: string; embedded?: true }) => api<{ appPath: string }>("/v1/auth/email-password", { method: "POST", body: JSON.stringify(input) });
export function safeReturnTo(value: string | null): string {
  if (!value?.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/trips";
  try { const url = new URL(value, "https://portal.invalid"); return url.origin === "https://portal.invalid" ? `${url.pathname}${url.search}${url.hash}` : "/trips"; } catch { return "/trips"; }
}

export const removeTripMember = (tripId: string, membershipId: string) =>
  api<{ status: string }>(`/v1/trips/${encodeURIComponent(tripId)}/members/${encodeURIComponent(membershipId)}`, { method: "DELETE" });
