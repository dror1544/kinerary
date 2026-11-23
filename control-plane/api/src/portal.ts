import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { OAuth2Client } from "google-auth-library";
import { issueEnrollment, pausedInterviewSessionId, pausedInterviewSessionSql, replaceEnrollment } from "./enrollment.js";
import { ensureUnknownPasswordCredential, hashPassword, resolveOrCreateEmailAccount, verifyPasswordLogin } from "./password-identity.js";
import type { Mailer } from "./mailer.js";
import {
  PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, cleanDisplayName, consumePasswordReset, consumeSignUpToken, normalizeEmail, portalMailIdle,
  recordGivenName, runInBackground, startPasswordReset, startSignUp, type EmailAuthContext,
} from "./portal-email-auth.js";
import { pickLanguage } from "./portal-email-templates.js";
import { generatePlan, retryProvision } from "./planner.js";
import { RETIRED_SLUG_PREFIX } from "./trip-retirement.js";
import { issueApproval } from "./plan-approval.js";
import { removeMember } from "./member-removal.js";
import { structuredLog } from "./redaction.js";
import {
  CLAIM_ID_SHAPE, GROUP_VERIFIED_VIA, TRIP_ID_PATTERN, openGroupChat, spokenFor, claimSessionSlot, claimTravellerInTx, endGroupClaimInTx, enqueueSignInNotice, linkMemberOrSkip,
  recordLinkSignIn, resolveMiniAppLaunch, telegramLinksByTrip, unlinkTelegramLink, unlinkedTelegramLinksByTrip,
  type GroupSignInDeps, type LabelVisibility, type ReleasedClaim, type SiteParticipant, type TelegramMiniAppConfig,
} from "./telegram-mini-app.js";
import { featureEnabled } from "./feature-switches.js";
import type { GroupMembershipCheck } from "./telegram-group-membership.js";
import { issueTelegramLinkToken, restoreTelegramLink } from "./telegram-link-token.js";
import { issueSecondaryOrganizerToken, listSecondaryOrganizers, removeSecondaryOrganizer } from "./secondary-organizers.js";
import {
  ACCOUNT_SIGN_IN_REQUIRED, assertEveryRouteIsClassified, loadSessionScope, scopeDecision, scopedSessionDigest, sessionDigests,
  type SessionScope,
} from "./portal-scope.js";
import { verifyMiniAppInitData, type VerifiedInitData } from "./telegram-webapp-auth.js";
import { runtimeUpstreamFor, UPSTREAM_SHARED_SQL, upstreamHostAllowed } from "./runtime-upstream.js";
import { applyLinkPassword, attachSession, claimGateVerdict, consumeSignInLink, endClaimLeftGroup, peekClaimLink, purgeSignInLinkLeftovers, signInLinkAvailable, startSignInLink, warnOncePerMinute, type SignInLinkRequest } from "./sign-in-link.js";
import { SiteReleaseError, attemptSiteRelease, compensateSiteBinding, type SiteReleaseOptions } from "./site-release-outbox.js";

export { upstreamHostAllowed };

// The gateway's key, compared in constant time (a plain !== leaks how many
// leading bytes were right).
function exchangeKeyMatches(supplied: unknown, expected: string): boolean {
  if (typeof supplied !== "string" || !expected) return false;
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}


function opaque(prefix: string, bytes = 16): string {
  return `${prefix}_${randomBytes(bytes).toString("hex")}`;
}

export function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function base64url(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

const scrypt = promisify(scryptCallback);

const GOOGLE_NONCE_COOKIE = "kit_gnonce";
const GOOGLE_NONCE_PATH = "/v1/auth/google";
/** What the page hands Google Identity Services as `nonce`: the hash of the secret only the cookie holds. */
const googleNonceFor = (secret: string): string => createHash("sha256").update(secret).digest("hex");
/** How long a nonce secret may be used after the server issued it (the cookie's Max-Age is the same, but only the server's word counts). */
const GOOGLE_NONCE_MAX_AGE_SECONDS = 300;
/** The issue time is the server's own (written at GET); this only absorbs a second instance's clock being a little ahead. */
const GOOGLE_NONCE_CLOCK_SKEW_SECONDS = 30;
/** The cookie's secret is `<issued-at, epoch seconds>.<random>`; the issue time is inside what the token's nonce hashes. */
const GOOGLE_NONCE_SECRET = /^([0-9]{9,12})\.[A-Za-z0-9_-]{20,64}$/;

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function hashPortalPassword(password: string): Promise<string> {
  const salt = base64url(16);
  const derived = await scrypt(password, salt, 32) as Buffer;
  return `scrypt:${salt}:${derived.toString("base64url")}`;
}

async function verifyPortalPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, digest, extra] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !digest || extra) return false;
  const derived = await scrypt(password, salt, 32) as Buffer;
  const expected = Buffer.from(digest, "base64url");
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

function parseCookies(header: unknown): Record<string, string> {
  if (typeof header !== "string") return {};
  return Object.fromEntries(header.split(";").flatMap((part) => {
    const index = part.indexOf("=");
    if (index < 1) return [];
    try {
      return [[part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())]];
    } catch {
      // A malformed cookie is untrusted input, not an application error.
      return [];
    }
  }));
}

/**
 * `crossSite` is the COOKIE VARIANT FOR A MINI APP RUNNING INSIDE A FRAME ON
 * ANOTHER SITE — Telegram Web (web.telegram.org) embeds the portal in a
 * cross-site iframe, where a `SameSite=Lax` cookie is never sent and a
 * Mini App that cannot hold a session cannot sign anyone in.
 *
 *   SameSite=None   so the browser sends it from inside that frame;
 *   Secure          which `None` requires, so an http origin (local dev) keeps
 *                   the Lax cookie rather than emit one browsers would drop;
 *   Partitioned     CHIPS: the browser keys the cookie to the TOP-LEVEL site
 *                   that was framing us when it was set (web.telegram.org), so
 *                   it is sent only back inside that same embedding — not to
 *                   a page on any other site that frames or requests us.
 *
 * Only the Mini App's own sign-in asks for it (`embedded` in the request, set
 * by the page when it finds itself in a frame). The ordinary portal keeps Lax.
 */
function cookie(name: string, value: string, options: { maxAge?: number; httpOnly?: boolean; secure?: boolean; crossSite?: boolean; path?: string } = {}): string {
  const crossSite = options.crossSite === true && options.secure !== false;
  const pieces = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? "/"}`, crossSite ? "SameSite=None" : "SameSite=Lax"];
  if (options.secure !== false) pieces.push("Secure");
  if (crossSite) pieces.push("Partitioned");
  if (options.httpOnly !== false) pieces.push("HttpOnly");
  if (options.maxAge !== undefined) pieces.push(`Max-Age=${options.maxAge}`);
  return pieces.join("; ");
}

export function validatedReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/trips";
  try {
    const parsed = new URL(value, "https://portal.invalid");
    if (parsed.origin !== "https://portal.invalid") return "/trips";
    const normalized = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    // Normalisation can CREATE what the checks above refused: "/.//evil.example" and "/trips/../..//evil.example" both
    // resolve to "//evil.example", which a browser reads as another site. So the OUTPUT is held to the same rule as the
    // input; that makes this function idempotent (validatedReturnTo(validatedReturnTo(x)) === validatedReturnTo(x)).
    return normalized.startsWith("/") && !normalized.startsWith("//") && !normalized.includes("\\") ? normalized : "/trips";
  } catch {
    return "/trips";
  }
}

export interface GoogleIdentity {
  subject: string;
  displayName: string;
  /**
   * The name Google itself put in the signed token -- its `given_name` claim, else its `name` -- and ONLY that.
   * `displayName` above falls back to the local part of the email address when Google sent no name, which is a
   * label and not a name; this is absent in that case. It is what the interview greets the organizer by (#438).
   */
  givenName?: string;
  email?: string;
  /**
   * Google's own `email_verified` claim, and only ever true when it said so.
   * `verify` refuses anything else (the claim can also be absent, and "absent"
   * must not read as "verified" where this decides that two accounts are the
   * same person); the route checks it again.
   */
  emailVerified: boolean;
  /** The token's `hd` claim: the Google Workspace domain the account belongs to. Absent for a consumer Google account. */
  hd?: string;
  /** The token's `nonce` claim: what the page gave Google Identity Services. The route holds it to the sign-in cookie. */
  nonce?: string;
}

/**
 * Why a Google credential was refused. A CODE, never the library's message: that message can quote the token
 * (`Invalid token signature: <jwt>`, `Wrong number of segments in token: <jwt>`), and the log must hold neither
 * the token nor the address in it.
 */
export type GoogleRefusal =
  | "CREDENTIAL_MISSING" | "SIGNATURE_INVALID" | "AUDIENCE_MISMATCH" | "ISSUER_MISMATCH" | "TOKEN_EXPIRED"
  | "TOKEN_MALFORMED" | "SUBJECT_MISSING" | "EMAIL_MISSING" | "EMAIL_UNVERIFIED" | "AZP_MISMATCH"
  | "NONCE_MISSING" | "NONCE_MISMATCH" | "NONCE_EXPIRED" | "NONCE_REPLAYED" | "EMAIL_MALFORMED"
  | "EMAIL_NOT_GOOGLE_AUTHORITATIVE" | "VERIFY_FAILED";

export class GoogleSignInRefused extends Error {
  constructor(readonly reason: GoogleRefusal) { super(reason); this.name = "GoogleSignInRefused"; }
}

/**
 * Verifies the signed ID token Google Identity Services hands the page ("Sign in with Google", ID-token flow:
 * the page draws Google's button from the PUBLIC client ID, Google signs a token for it, and the page posts
 * the token to POST /v1/auth/google). There is no client secret and no redirect. Throws GoogleSignInRefused.
 */
export interface GoogleIdTokenVerifier {
  /** The OAuth client ID: the token's required audience, and what capabilities hands the page. */
  readonly clientId: string;
  verify(credential: string): Promise<GoogleIdentity>;
}

export class GoogleIdTokenClient implements GoogleIdTokenVerifier {
  /** `client` is injectable so a test can serve its own signing certificates instead of fetching Google's. */
  constructor(readonly clientId: string, private readonly client: OAuth2Client = new OAuth2Client(clientId)) {}

  async verify(credential: string): Promise<GoogleIdentity> {
    if (!credential) throw new GoogleSignInRefused("CREDENTIAL_MISSING");
    let payload;
    try {
      // The library checks the signature against Google's published certificates, the expiry (exp, and iat
      // not in the future), the audience, and the issuer: accounts.google.com or https://accounts.google.com.
      const ticket = await this.client.verifyIdToken({ idToken: credential, audience: this.clientId });
      payload = ticket.getPayload();
    } catch (error) {
      throw new GoogleSignInRefused(refusalFor(error instanceof Error ? error.message : ""));
    }
    if (!payload?.sub) throw new GoogleSignInRefused("SUBJECT_MISSING");
    // `azp` is the client the token was issued to. When Google says one, it must be ours (aud alone is checked by the library).
    if (payload.azp !== undefined && payload.azp !== this.clientId) throw new GoogleSignInRefused("AZP_MISMATCH");
    if (!payload.email) throw new GoogleSignInRefused("EMAIL_MISSING");
    // `=== true`, not `!== false`: an absent claim must not read as verified, because this is what decides
    // that Google's address and an existing account's address are the same person.
    if (payload.email_verified !== true) throw new GoogleSignInRefused("EMAIL_UNVERIFIED");
    const claimedName = [payload.given_name, payload.name].find((value): value is string => typeof value === "string" && value.trim() !== "");
    return {
      subject: payload.sub,
      displayName: payload.name?.trim().slice(0, 120) || payload.email.split("@")[0]?.slice(0, 120) || "Kinerary organizer",
      ...(claimedName ? { givenName: claimedName.trim().slice(0, 120) } : {}),
      email: payload.email,
      emailVerified: true,
      ...(typeof payload.nonce === "string" ? { nonce: payload.nonce } : {}),
      ...(typeof payload.hd === "string" ? { hd: payload.hd } : {}),
    };
  }
}

/**
 * Whether Google is AUTHORITATIVE for this address, i.e. whether Google's say-so that "this person controls
 * <address>" is as good as this system proving it itself by an emailed link. It is for @gmail.com and
 * @googlemail.com (Google runs that mailbox), and for a Workspace account whose `hd` claim equals the address's
 * domain (Google runs that domain's mail). For anyone else `email_verified` only says Google once sent a code to
 * an address it does not run (an outlook.com or company address attached to a Google account), which is not proof
 * that its owner is the person holding the token. Those addresses use the emailed-link sign-up instead, whether or
 * not an account exists: the answer must not tell the two apart. Exact domain equality, never a suffix match
 * ("gmail.com.evil.test", "notgmail.com" and a subdomain of `hd` are all refused).
 */
export function googleIsAuthoritativeFor(email: string, hostedDomain?: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 1) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain) return false;
  if (domain === "gmail.com" || domain === "googlemail.com") return true;
  return typeof hostedDomain === "string" && hostedDomain.trim() !== "" && domain === hostedDomain.trim().toLowerCase();
}

/**
 * Whether a claim is a plain addr-spec, the only shape an email claim may have: ASCII printable only (no
 * whitespace, no control characters, nothing beyond U+007E), exactly one "@" with something either side, and none of
 * `<>",`. A claim like `a@evil.test@gmail.com`, ` x@gmail.com`, or `"x@evil.test"@gmail.com` is refused outright
 * rather than interpreted, because the authority check and the account lookup would otherwise each have to guess
 * which "@" counts. Google does not send such a claim; this is defence in depth against the day one reaches here.
 */
export function isPlainAddrSpec(email: string): boolean {
  if (email.length > 254 || !/^[\x21-\x7e]+$/.test(email) || /[<>",]/.test(email)) return false;
  const parts = email.split("@");
  return parts.length === 2 && parts[0]!.length > 0 && parts[1]!.length > 0;
}

/**
 * The one account an address names. Google runs @googlemail.com and @gmail.com as the same mailbox, so both
 * resolve to gmail.com before the account lookup: otherwise the same person holds two accounts by which spelling
 * Google happened to put in the token.
 */
export function canonicalGoogleEmail(email: string): string {
  const lowered = email.trim().toLowerCase();
  return lowered.endsWith("@googlemail.com") ? `${lowered.slice(0, -"googlemail.com".length)}gmail.com` : lowered;
}

function refusalFor(message: string): GoogleRefusal {
  if (/Invalid token signature|No pem found/i.test(message)) return "SIGNATURE_INVALID";
  if (/Wrong recipient|audience/i.test(message)) return "AUDIENCE_MISMATCH";
  if (/Invalid issuer/i.test(message)) return "ISSUER_MISMATCH";
  if (/Token used too late|expired/i.test(message)) return "TOKEN_EXPIRED";
  if (/segments|Can't parse/i.test(message)) return "TOKEN_MALFORMED";
  return "VERIFY_FAILED";
}

export interface RuntimeAccountAdapter {
  participantExists(input: {
    tripId: string;
    runtimeUsername: string;
  }): Promise<boolean>;
  provisionParticipant(input: {
    tripId: string;
    inviteId: string;
    userId: string;
    runtimeUsername: string;
    displayName: string;
    /** Invite ids the control plane has checked are dead for this name (see `deadInviteIds`); omitted when there are none. */
    deadInviteIds?: string[];
  }): Promise<void>;
  /**
   * The trip site's participants: username, display name and ROLE as the site says it. Group sign-in
   * (telegram-mini-app.ts) offers only the ones the site calls `member`. Throws when the site cannot be asked; a caller
   * treats that as "no list", never as "an empty list".
   */
  listParticipants(tripId: string): Promise<SiteParticipant[]>;
  /**
   * Binds a control-plane user to a participant that ALREADY EXISTS on the trip site, so the session exchange for that
   * user finds an identity (the invite path gets one from `provisionParticipant`; a claim has no invite). It never
   * creates a participant and never changes one: the site refuses an organizer, a name that is not a participant, and a
   * name an invite holds. "ok" = bound; "refused" = not a plain member there (or not there at all); "conflict" = an
   * invite-bound or owner binding holds the name. THROWS when the site cannot be asked: nothing is known, and a caller
   * must not read that as either answer. The personal invite for an existing traveller (spec AC-10) reuses this.
   */
  adoptParticipant(input: { tripId: string; userId: string; runtimeUsername: string; deadInviteIds?: string[] }): Promise<"ok" | "refused" | "conflict">;
  /** Ends that binding (only that user's, only a claim's, never an invited member's or an organizer's). Idempotent. Throws when the site cannot be asked. */
  releaseParticipant(input: { tripId: string; userId: string; runtimeUsername: string; inviteId?: string }): Promise<void>;
}

/** How long the control plane waits on the trip site for one of these calls. They run inside a person's launch. */
const RUNTIME_CALL_TIMEOUT_MS = 5000;

/**
 * The JSON `error` code of a failed answer when the body is an object carrying a string one (the trip site's and the runtime gateway's
 * own errors all are), else null: HTML, empty, not an object, an over-long string. That is the line between "the site said so" and
 * "something in between answered" (a proxy, a WAF, Express's default page for a route this payload does not have).
 */
async function siteJsonErrorCode(response: Response): Promise<string | null> {
  const body = (await response.text().catch(() => "")).slice(0, 4096);
  try {
    const parsed = JSON.parse(body) as unknown;
    const said = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { error?: unknown }).error : undefined;
    return typeof said === "string" && said.length <= 64 ? said : null;
  } catch { return null; }
}

/**
 * `listParticipants` failed because the route is not there: a 404 that is NOT the site's or gateway's own JSON `NOT_FOUND`. That is an
 * older trip-site payload (Express's default HTML 404) during the window between a control-plane restart and the trip's redeploy.
 * Its message is the ordinary list failure, so every caller that just catches fails safe exactly as before; only `createSiteInvite`
 * looks at the class, to fall back to `participantExists` as `main` did.
 */
export class SiteRouteMissingError extends Error {
  constructor() { super("RUNTIME_PARTICIPANT_LIST_FAILED"); this.name = "SiteRouteMissingError"; }
}

/**
 * What the adapter's own fetch throws when the gateway answered with a redirect. Every call here carries the control-plane key in
 * `x-api-key`, and Node's fetch forwards that header to wherever a redirect points (it drops only `authorization` and `cookie` across
 * origins), after which the adapter would have believed the foreign answer. A redirect is therefore never followed and never an answer:
 * the same failure as a site that cannot be reached, which every caller already treats as the safe one (retry, or "not ready").
 */
export class RuntimeRedirectRefusedError extends Error {
  constructor(readonly status: number) { super("RUNTIME_GATEWAY_REDIRECT"); this.name = "RuntimeRedirectRefusedError"; }
}

export class HttpRuntimeAccountAdapter implements RuntimeAccountAdapter {
  constructor(private readonly runtimeOrigin: string, private readonly apiKey: string, private readonly timeoutMs: number = RUNTIME_CALL_TIMEOUT_MS) {}

  /**
   * The only way this class calls the gateway. `redirect: "manual"`, then any 3xx is refused here, by status range: Node 20 and 22
   * hand back the 3xx itself, a browser-style runtime would hand back an opaque redirect (type "opaqueredirect", status 0), and the
   * range check does not depend on which. Nothing past this point sees a redirect as an answer.
   */
  private async call(path: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<Response> {
    const response = await fetch(`${this.runtimeOrigin}${path}`, { ...init, redirect: "manual" });
    if ((response.status >= 300 && response.status < 400) || response.type === "opaqueredirect") {
      await response.body?.cancel().catch(() => {});
      throw new RuntimeRedirectRefusedError(response.status);
    }
    return response;
  }

  async participantExists(input: { tripId: string; runtimeUsername: string }): Promise<boolean> {
    const response = await this.call(`/internal/t/${encodeURIComponent(input.tripId)}/participants/${encodeURIComponent(input.runtimeUsername)}`, {
      method: "GET",
      headers: { "x-api-key": this.apiKey },
    });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error("RUNTIME_PARTICIPANT_LOOKUP_FAILED");
    return true;
  }

  async listParticipants(tripId: string): Promise<SiteParticipant[]> {
    const response = await this.call(`/internal/t/${encodeURIComponent(tripId)}/participants`, {
      method: "GET",
      headers: { "x-api-key": this.apiKey },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      // A JSON NOT_FOUND is a GATEWAY that lacks the route (one older than the control plane): not a missing SITE route, no fallback.
      if (response.status === 404 && (await siteJsonErrorCode(response)) !== "NOT_FOUND") throw new SiteRouteMissingError();
      throw new Error("RUNTIME_PARTICIPANT_LIST_FAILED");
    }
    const body = (await response.json()) as { participants?: unknown } | null;
    if (!body || !Array.isArray(body.participants)) throw new Error("RUNTIME_PARTICIPANT_LIST_FAILED");
    // Strings only: anything else is dropped here, so a malformed entry can neither be offered nor crash the caller.
    return body.participants.flatMap((entry: unknown) => {
      const { username, displayName, role } = (entry ?? {}) as Record<string, unknown>;
      return typeof username === "string" && typeof displayName === "string" && typeof role === "string" ? [{ username, displayName, role }] : [];
    });
  }

  private async binding(action: "adopt" | "release", input: { tripId: string; userId: string; runtimeUsername: string; deadInviteIds?: string[]; inviteId?: string }): Promise<Response> {
    return this.call(`/internal/t/${encodeURIComponent(input.tripId)}/participants/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.apiKey },
      body: JSON.stringify({ tripId: input.tripId, userId: input.userId, runtimeUsername: input.runtimeUsername, ...(action === "adopt" && input.deadInviteIds?.length ? { deadInviteIds: input.deadInviteIds } : {}), ...(action === "release" && input.inviteId ? { inviteId: input.inviteId } : {}) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  async adoptParticipant(input: { tripId: string; userId: string; runtimeUsername: string; deadInviteIds?: string[] }): Promise<"ok" | "refused" | "conflict"> {
    const response = await this.binding("adopt", input);
    if (response.ok) return "ok";
    if (response.status === 404 || response.status === 403) return "refused";
    if (response.status === 409) return "conflict";
    throw new Error("RUNTIME_PARTICIPANT_ADOPT_FAILED");
  }

  async releaseParticipant(input: { tripId: string; userId: string; runtimeUsername: string; inviteId?: string }): Promise<void> {
    let response: Response;
    // A redirect is not an answer and the key went nowhere (`call`): retryable, never `done` and never given up (the outbox gives up only
    // on the site's own 400/403 with its own code; this carries the 3xx status and no code).
    try { response = await this.binding("release", input); } catch (error) {
      if (error instanceof RuntimeRedirectRefusedError) throw new SiteReleaseError(error.status);
      throw error;
    }
    // The status travels with the failure, and so does the body's JSON `error` code when the body is an object carrying a string one
    // (SiteReleaseError): the durable retry (site-release-outbox.ts) gives up only on the site's or gateway's OWN refusal of that status
    // and keeps retrying everything else, a proxy's or WAF's 4xx included. A 200 counts only when it is the site's own answer,
    // `{ok:true, released}` ("nothing to release" is `released:false` and is success); anything else on a 200 (a proxy's page, an
    // empty body) is not an answer.
    if (!response.ok) throw new SiteReleaseError(response.status, await siteJsonErrorCode(response));
    const answer = (await response.json().catch(() => null)) as { ok?: unknown } | null;
    if (!answer || answer.ok !== true) throw new SiteReleaseError(null);
  }

  async provisionParticipant(input: Parameters<RuntimeAccountAdapter["provisionParticipant"]>[0]): Promise<void> {
    const response = await this.call(`/internal/t/${encodeURIComponent(input.tripId)}/participants`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.apiKey },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    // The site SAID NO (not a participant, an organizer, the name is held by another invite or this account is bound elsewhere):
    // a refusal the invite's holder can be told about cleanly. Anything else (an outage, a gateway error, a lost answer) is not an
    // answer at all, and is retryable.
    if (response.status === 403 || response.status === 404 || response.status === 409) throw new Error(RUNTIME_PARTICIPANT_REFUSED);
    if (!response.ok) throw new Error("RUNTIME_PARTICIPANT_PROVISION_FAILED");
  }
}

/** What `provisionParticipant` throws when the trip site refused the binding, as opposed to being unable to answer. */
export const RUNTIME_PARTICIPANT_REFUSED = "RUNTIME_PARTICIPANT_REFUSED";

export interface PortalDependencies {
  db: pg.Pool;
  /** Present only when `web.google_client_id` is set; absent turns Google sign-in off (capabilities says so). */
  google?: GoogleIdTokenVerifier;
  runtimeAccounts: RuntimeAccountAdapter;
  publicOrigin: string;
  runtimeOrigin: string;
  runtimeExchangeKey: string;
  runtimeUpstreamHostSuffixes: readonly string[];
  /** `web.runtime_upstream_allowed_hosts`: what the host-mode lookup may return. Absent allows nothing. */
  runtimeUpstreamAllowedHosts?: readonly string[];
  telegramBotUsername: string;
  sessionTtlSeconds: number;
  enrollmentTtlSeconds: number;
  approvalTtlSeconds: number;
  /** Operator's Telegram chat id for provisioning notifications. See issueApproval. */
  operatorChatId?: string;
  /**
   * Telegram Mini App sign-in (#442). Absent, or `enabled()` false, leaves
   * `POST /v1/auth/telegram-mini-app` answering 503 and `capabilities` saying
   * so: the feature is off, and says it is off.
   */
  telegramMiniApp?: TelegramMiniAppConfig & { log?: (line: string) => void };
  /**
   * Group sign-in (docs/specs/sprint-9/x-member-sign-in.md, slice S1): how to ask Telegram whether a person is live in a
   * trip's group, with the bot that is IN the group. Absent means the path does not exist: every launch and every claim
   * behaves as if the feature had never been written, whatever the per-trip switch says. The switch itself
   * (`member_group_sign_in`) is read per trip on `db`; this is only the wiring that makes it meaningful.
   */
  memberGroupSignIn?: { isActiveMember: GroupMembershipCheck };
  /** How long a dashboard-issued Telegram link works. Defaults to 15 minutes. */
  telegramLinkTtlSeconds?: number;
  /**
   * Carries the verification and password-reset messages. ABSENT means email is
   * not configured: `POST /v1/auth/sign-up` and `/v1/auth/password/forgot` answer
   * 503 SIGN_UP_UNAVAILABLE and `capabilities.emailSignUp` is false. There is no
   * path on which a message is silently not sent.
   */
  mailer?: Mailer;
  /** Where the email routes write their (token-free) log lines. Defaults to stderr. */
  emailAuthLog?: (line: string) => void;
}

interface PortalUser {
  id: string;
  displayName: string;
  /** The name the account holder gave the product (`users.given_name`); null until somebody told us. */
  givenName: string | null;
  /** The dashboard has already put the question "what should we call you?" to them (answered or "not now"). */
  givenNameAsked: boolean;
  googleSubjectDigest: string | null;
  sessionDigest: string;
  sessionId: string;
  sessionCreatedAt: Date;
  /** The Telegram link that minted this session, if one did (group sign-in asks the group again through it). */
  telegramLinkId: string | null;
  /**
   * NULL for a full (password / Google) session. For a session a Telegram link
   * minted, the trips that Telegram account is linked to - possibly none. See
   * portal-scope.ts: `requireUser` enforces it, so a handler sees only a user
   * the route is allowed for.
   */
  scope: SessionScope | null;
}

/**
 * A scoped session's scope, derived from its link rows now. The ONE place that
 * turns "this session was minted by that link" into a trip set, used by
 * `portalUser` (every portal request) and by the gateway's liveness check, so
 * the two cannot disagree. A scope that cannot be read is the EMPTY scope.
 */
async function readSessionScope(deps: PortalDependencies, userId: string, telegramLinkId: string | null): Promise<SessionScope> {
  return loadSessionScope(deps.db, { userId, telegramLinkId }).catch(() => ({ tripIds: new Set<string>(), telegramDigest: null }));
}

/** The route whose policy decides whether a session may OPEN a trip: the launch that produced the trip session. */
const OPEN_TRIP_ROUTE = "POST /v1/trips/:id/launch";

/**
 * Is a live portal session of this user one that may still open this trip? A full session (no
 * Telegram link) may; a scoped one only if the trip is in its scope TODAY, by the same
 * `scopeDecision` `requireUser` applies to the launch. Without `sessionId` (a grant minted before
 * session binding) any live session that qualifies is enough.
 */
async function sessionMayOpenTrip(deps: PortalDependencies, input: { userId: string; tripId: string; sessionId: string | null }): Promise<boolean> {
  const sessions = await deps.db.query<{ telegram_link_id: string | null }>(
    `SELECT telegram_link_id FROM control_plane.web_sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() AND ($2::text IS NULL OR id = $2::text)
      ORDER BY (telegram_link_id IS NULL) DESC`,
    [input.userId, input.sessionId]);
  for (const row of sessions.rows) {
    if (row.telegram_link_id === null) return true;
    const decision = await scopeDecision(deps.db, {
      routeKey: OPEN_TRIP_ROUTE, params: { id: input.tripId }, scope: await readSessionScope(deps, input.userId, row.telegram_link_id),
    });
    if (decision.allow) return true;
  }
  return false;
}

async function portalUser(request: FastifyRequest, deps: PortalDependencies): Promise<PortalUser | null> {
  const raw = parseCookies(request.headers.cookie).kit_session;
  if (!raw) return null;
  const result = await deps.db.query<{
    id: string; display_name: string; given_name: string | null; given_name_asked_at: Date | null;
    provider_subject_digest: string | null; session_digest: string; session_id: string; session_created_at: Date;
    telegram_link_id: string | null;
  }>(
    `SELECT u.id, u.display_name, u.given_name, u.given_name_asked_at, ui.provider_subject_digest, s.token_digest AS session_digest, s.id AS session_id, s.created_at AS session_created_at,
            s.telegram_link_id
     FROM control_plane.web_sessions s
     JOIN control_plane.users u ON u.id = s.user_id AND u.status = 'active'
     LEFT JOIN control_plane.user_identities ui ON ui.user_id = u.id AND ui.provider = 'google'
     WHERE s.token_digest = ANY($1::text[]) AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sessionDigests(raw)],
  );
  const row = result.rows[0];
  if (!row) return null;
  void deps.db.query("UPDATE control_plane.web_sessions SET last_seen_at = now() WHERE token_digest = $1", [row.session_digest]).catch(() => {});
  // Scoped when EITHER signal says so: a Telegram link minted it, or it is stored under the scoped digest.
  // A scoped session whose scope cannot be read has the empty scope, not a full one.
  const scoped = row.telegram_link_id !== null || row.session_digest === scopedSessionDigest(raw);
  const scope = scoped ? await readSessionScope(deps, row.id, row.telegram_link_id) : null;
  return {
    id: row.id,
    displayName: row.display_name,
    givenName: row.given_name,
    givenNameAsked: row.given_name_asked_at !== null,
    googleSubjectDigest: row.provider_subject_digest,
    sessionDigest: row.session_digest,
    sessionId: row.session_id,
    sessionCreatedAt: row.session_created_at,
    telegramLinkId: row.telegram_link_id,
    scope,
  };
}

async function createWebSession(client: pg.PoolClient, userId: string, ttlSeconds: number, telegramLinkId: string | null = null) {
  const sessionToken = base64url(32);
  const csrf = base64url(24);
  // `telegramLinkId` is set only for a session a Telegram link minted, so that
  // unlinking (or the link ending any other way) can end that session too. Such
  // a session is SCOPED (portal-scope.ts) and is stored under the scoped digest,
  // which no older release can match: a rollback cannot widen it.
  const sessionId = opaque("wsess");
  await client.query(
    `INSERT INTO control_plane.web_sessions(id, user_id, token_digest, csrf_digest, expires_at, telegram_link_id)
     VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 second'), $6)`,
    [sessionId, userId, telegramLinkId ? scopedSessionDigest(sessionToken) : sha256(sessionToken), sha256(csrf), ttlSeconds, telegramLinkId],
  );
  // `sessionId` is read only by the sign-in link, which remembers which session its redemption minted (sign-in-link.ts).
  return { sessionToken, csrf, sessionId };
}

function setWebSessionCookies(
  reply: FastifyReply, deps: PortalDependencies, session: { sessionToken: string; csrf: string },
  options: { embedded?: boolean } = {},
): void {
  const secure = deps.publicOrigin.startsWith("https://");
  const crossSite = options.embedded === true;
  reply.header("set-cookie", [
    cookie("kit_session", session.sessionToken, { maxAge: deps.sessionTtlSeconds, secure, crossSite }),
    cookie("kit_csrf", session.csrf, { maxAge: deps.sessionTtlSeconds, httpOnly: false, secure, crossSite }),
  ]);
}

/**
 * Expires BOTH variants. A cookie is identified by name, domain, path AND (for
 * the partitioned one) its partition, so a Lax expiry does not touch the
 * partitioned cookie a Mini App session set, and the other way round.
 */
function expiredSessionCookies(deps: PortalDependencies): string[] {
  const secure = deps.publicOrigin.startsWith("https://");
  const out = [cookie("kit_session", "", { maxAge: 0, secure }), cookie("kit_csrf", "", { maxAge: 0, httpOnly: false, secure })];
  if (secure) out.push(cookie("kit_session", "", { maxAge: 0, secure, crossSite: true }), cookie("kit_csrf", "", { maxAge: 0, httpOnly: false, secure, crossSite: true }));
  return out;
}

function clearWebSessionCookies(reply: FastifyReply, deps: PortalDependencies): void {
  reply.header("set-cookie", expiredSessionCookies(deps));
}

/** The page found itself in a frame on another site and says so; it can only ever weaken its own cookie. */
function embeddedRequest(body: Record<string, unknown>): boolean {
  return body.embedded === true;
}

/** An Origin that is present, is not the literal "null" of a sandboxed/opaque origin, and is ours. */
function originIsOurs(request: FastifyRequest, deps: PortalDependencies): boolean {
  const origin = request.headers.origin;
  return typeof origin === "string" && origin !== "null" && origin === deps.publicOrigin;
}

/**
 * The "Next time, open with Telegram" request: verified-initData material AND an
 * explicit consent flag, both in the SAME request as a credential. Anything
 * short of `consent === true` is not a request to link.
 */
function telegramLinkRequest(body: Record<string, unknown>): { initData: string } | null {
  const link = body.telegramLink;
  if (!link || typeof link !== "object") return null;
  const { initData, consent } = link as { initData?: unknown; consent?: unknown };
  return consent === true && typeof initData === "string" ? { initData } : null;
}

async function recordFunnelEvent(
  db: pg.Pool | pg.PoolClient,
  eventName: string,
  input: { outcome?: "success" | "failure"; userId?: string; tripId?: string } = {},
): Promise<void> {
  await db.query(
    `INSERT INTO control_plane.funnel_events(id, event_name, outcome, user_id, trip_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [opaque("event"), eventName, input.outcome ?? null, input.userId ?? null, input.tripId ?? null],
  );
}

async function authenticate(request: FastifyRequest, reply: FastifyReply, deps: PortalDependencies): Promise<PortalUser | null> {
  const user = await portalUser(request, deps);
  if (!user) { reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" }); return null; }
  return user;
}

/**
 * THE one place a Telegram-minted session is held to its scope (portal-scope.ts).
 * For a mutation it runs AFTER the Origin and CSRF checks, so a request that
 * would be refused for those reasons gets the same status whatever id it names:
 * a foreign link id and an unknown one cannot be told apart by the status.
 */
async function enforceScope(request: FastifyRequest, reply: FastifyReply, deps: PortalDependencies, user: PortalUser): Promise<boolean> {
  if (!user.scope) return true;
  const decision = await scopeDecision(deps.db, {
    routeKey: `${request.method} ${request.routeOptions.url ?? ""}`,
    params: (request.params && typeof request.params === "object" ? request.params : {}) as Record<string, unknown>,
    scope: user.scope,
  });
  if (!decision.allow) { reply.code(decision.status).send(decision.body); return false; }
  return true;
}

async function requireUser(request: FastifyRequest, reply: FastifyReply, deps: PortalDependencies): Promise<PortalUser | null> {
  const user = await authenticate(request, reply, deps);
  if (!user) return null;
  return (await enforceScope(request, reply, deps, user)) ? user : null;
}

/**
 * A state-changing request carries the session cookie, a CSRF header that matches it
 * AND - when the browser says where it came from - our own origin. A present Origin
 * that is not `web.public_origin` (including the literal "null") is refused: with the
 * Telegram Web cookie variant (SameSite=None) the cookie is no longer held back by
 * SameSite, so this is a second wall behind the CSRF token. A MISSING Origin keeps
 * today's behaviour (CSRF token only): non-browser clients and older browsers do not send it.
 */
function originRefused(request: FastifyRequest, deps: PortalDependencies): boolean {
  const origin = request.headers.origin;
  return origin !== undefined && origin !== deps.publicOrigin;
}

async function requireMutation(request: FastifyRequest, reply: FastifyReply, deps: PortalDependencies): Promise<PortalUser | null> {
  const user = await authenticate(request, reply, deps);
  if (!user) return null;
  if (originRefused(request, deps)) {
    reply.code(403).send({ error: "ORIGIN_INVALID" });
    return null;
  }
  const cookies = parseCookies(request.headers.cookie);
  const csrfHeader = request.headers["x-csrf-token"];
  if (typeof csrfHeader !== "string" || !cookies.kit_csrf || !safeEqual(csrfHeader, cookies.kit_csrf)) {
    reply.code(403).send({ error: "CSRF_INVALID" });
    return null;
  }
  const session = await deps.db.query<{ csrf_digest: string }>(
    "SELECT csrf_digest FROM control_plane.web_sessions WHERE token_digest = ANY($1::text[]) AND revoked_at IS NULL AND expires_at > now()",
    [sessionDigests(cookies.kit_session ?? "")],
  );
  if (!session.rows[0] || !safeEqual(session.rows[0].csrf_digest, sha256(csrfHeader))) {
    reply.code(403).send({ error: "CSRF_INVALID" });
    return null;
  }
  return (await enforceScope(request, reply, deps, user)) ? user : null;
}

async function membership(deps: PortalDependencies, tripId: string, userId: string) {
  const result = await deps.db.query<{ role: string; dashboard_access: boolean; runtime_access: boolean }>(
    `SELECT role, dashboard_access, runtime_access FROM control_plane.trip_memberships
     WHERE trip_id = $1 AND user_id = $2 AND status = 'active'`,
    [tripId, userId],
  );
  return result.rows[0] ?? null;
}

/**
 * The invite ids that are DEAD for one traveller of one trip: revoked or expired (by state, or by the clock while still `unused`) AND
 * never redeemed. Sent to the trip site with an invite provision or a claim's adopt so that it can replace an invite-bound binding that
 * a redemption which never completed here (a lost answer; the organizer then "sent it again") left behind: the site replaces an
 * invite-bound binding only when its invite id is on this list. A REDEEMED invite is a person on the trip and is never on it, nor is
 * a pending invite. Read inside the caller's trip-row lock (a redemption and a claim both hold it), so the list cannot go stale
 * between the question and the call. Bounded (50): the site refuses a longer list as no list.
 */
export async function deadInviteIdsFor(db: { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }, tripId: string, runtimeUsername: string): Promise<string[]> {
  const result = await db.query(
    `SELECT id FROM control_plane.site_invites
      WHERE trip_id = $1 AND runtime_username = $2
        AND ((redeemed_by IS NULL AND redeemed_at IS NULL AND (state IN ('revoked', 'expired') OR (state = 'unused' AND expires_at <= now())))
          -- a REMOVED member's invite (member removal marks the redeemed invite 'revoked' and keeps redeemed_by): dead only while its
          -- redeemer has NO active membership of this trip, in any role. Whoever is a member again (revived by any path, re-invited, an
          -- owner or organizer) is not listed, so a live member's binding is never named; a binding of someone with no active
          -- membership opens nothing (a launch needs one). 'expired' or 'unused' with a redeemer is never listed.
          OR (state = 'revoked' AND redeemed_by IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM control_plane.trip_memberships m
                               WHERE m.trip_id = site_invites.trip_id AND m.user_id = site_invites.redeemed_by AND m.status = 'active')))
      ORDER BY created_at DESC LIMIT 50`,
    [tripId, runtimeUsername]);
  return result.rows.map((row) => String(row.id));
}

export type SiteInviteResult =
  | { ok: true; id: string; joinUrl: string; displayName: string; expiresAt: string }
  | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * THE ONE WAY a personal invite for an existing traveller is made (docs/specs/sprint-9/x-member-sign-in.md, slice S2, AC-10): the
 * portal route `POST /v1/trips/:id/site-invites`, the runtime gateway's hop for an organizer's trip-site session
 * (`/internal/member-invites/create`) and, next, the companion's organizer-scoped tool all call THIS, so the rules exist once. The
 * caller authenticates its own person and says who they are (`actorUserId`); this function decides again, from the database, that
 * the person is an owner or organizer of THIS trip with dashboard access, and answers anyone else with the one 404.
 *
 * What it will not make an invite for, and why:
 *   - a name that is not a participant of the trip site (`RUNTIME_PARTICIPANT_NOT_FOUND`): an invite BINDS an existing participant,
 *     it never creates one. A new traveller is added on the site first, then invited, exactly as before (D2).
 *   - an organizer, owner or secondary organizer (`RUNTIME_PARTICIPANT_NOT_ELIGIBLE`): the site says so (its role is not `member`),
 *     or an owner/organizer account here already holds the name. The site refuses the binding anyway; saying so here gives the
 *     organizer a clean answer instead of a link that cannot work.
 *   - a traveller who is CLAIMED from the group right now (`TRAVELLER_CLAIMED_FROM_GROUP`): the organizer releases that sign-in
 *     first. Only an organizer ever sees this answer, because the 404 above comes first.
 *   - a traveller who already has a pending invite (`INVITE_ALREADY_EXISTS`) unless `replacePending` (the organizer's "send it
 *     again": the old pending link is revoked and a new one issued in the same transaction), or a redeemed one (never replaced).
 *
 * The trip row is locked (`FOR UPDATE`) for the check and the insert, the lock every group claim also takes, so a claim and an invite
 * for the same traveller meet here one after the other and cannot both win.
 */
export async function createSiteInvite(
  deps: Pick<PortalDependencies, "db" | "runtimeAccounts" | "publicOrigin"> & { log?: (line: string) => void },
  input: { tripId: string; actorUserId: string; runtimeUsername: string; displayName?: string; replacePending?: boolean },
): Promise<SiteInviteResult> {
  const { tripId } = input;
  const actor = await membership(deps as PortalDependencies, tripId, input.actorUserId);
  if (!actor || !["owner", "organizer"].includes(actor.role) || !actor.dashboard_access) return { ok: false, status: 404, error: "NOT_FOUND" };
  const runtimeUsername = typeof input.runtimeUsername === "string" ? input.runtimeUsername.toLowerCase().trim() : "";
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(runtimeUsername)) return { ok: false, status: 400, error: "INVALID_REQUEST" };
  const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120).trim();
  const given = typeof input.displayName === "string" ? clean(input.displayName) : "";
  let displayName: string;
  try {
    const people = await deps.runtimeAccounts.listParticipants(tripId);
    const person = people.find((candidate) => candidate.username === runtimeUsername);
    if (!person) return { ok: false, status: 409, error: "RUNTIME_PARTICIPANT_NOT_FOUND" };
    if (person.role !== "member") return { ok: false, status: 409, error: "RUNTIME_PARTICIPANT_NOT_ELIGIBLE" };
    displayName = given || clean(person.displayName);
  } catch (error) {
    // The list is a route an OLDER trip-site payload does not have (mixed versions: the control plane restarts before each trip is
    // redeployed). Only that falls back, to what `main` asked: does the participant exist. A real outage stays RUNTIME_NOT_READY.
    // What the fallback cannot read is the SITE's role for the name; the old site itself still refuses to bind an organizer at
    // redeem (its provision route answers 403 ORGANIZER_BINDING_FORBIDDEN), and the checks below that come from the control plane's
    // own tables (a group claim, an organizer-side account) are unchanged. The caller must name the traveller, as on `main`.
    if (!(error instanceof SiteRouteMissingError)) return { ok: false, status: 409, error: "RUNTIME_NOT_READY" };
    let exists: boolean;
    try { exists = await deps.runtimeAccounts.participantExists({ tripId, runtimeUsername }); } catch { return { ok: false, status: 409, error: "RUNTIME_NOT_READY" }; }
    if (!exists) return { ok: false, status: 409, error: "RUNTIME_PARTICIPANT_NOT_FOUND" };
    (deps.log ?? ((line: string) => process.stderr.write(`${line}\n`)))(
      structuredLog("info", "site_invite.old_site_fallback", { effect: "the trip site has no participant list: existence checked per participant, as before; its role for the name was not read" }));
    displayName = given;
  }
  if (!displayName) return { ok: false, status: 400, error: "INVALID_REQUEST" };
  const token = base64url(32);
  const inviteId = opaque("invite");
  const client = await deps.db.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query("SELECT 1 FROM control_plane.trips WHERE id = $1 FOR UPDATE", [tripId]);
    if (!locked.rowCount) { await client.query("ROLLBACK"); return { ok: false, status: 404, error: "NOT_FOUND" }; }
    const claimed = await client.query("SELECT 1 FROM control_plane.trip_participant_claims WHERE trip_id = $1 AND runtime_username = $2 AND released_at IS NULL", [tripId, runtimeUsername]);
    if (claimed.rowCount) { await client.query("ROLLBACK"); return { ok: false, status: 409, error: "TRAVELLER_CLAIMED_FROM_GROUP" }; }
    if ((await spokenFor(client, tripId)).organizerSide.has(runtimeUsername)) { await client.query("ROLLBACK"); return { ok: false, status: 409, error: "RUNTIME_PARTICIPANT_NOT_ELIGIBLE" }; }
    // A pending invite past its expiry is not pending: close it, so the unique index (which counts every 'unused' row) lets a fresh one in.
    await client.query("UPDATE control_plane.site_invites SET state = 'expired', updated_at = now() WHERE trip_id = $1 AND runtime_username = $2 AND state = 'unused' AND expires_at <= now()", [tripId, runtimeUsername]);
    if (input.replacePending) {
      await client.query("UPDATE control_plane.site_invites SET state = 'revoked', updated_at = now() WHERE trip_id = $1 AND runtime_username = $2 AND state = 'unused'", [tripId, runtimeUsername]);
    }
    let inserted;
    try {
      inserted = await client.query<{ expires_at: Date }>(
        `INSERT INTO control_plane.site_invites(id, trip_id, created_by, intended_display_name, runtime_username, token_digest, state, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'unused', now() + interval '7 days') RETURNING expires_at`,
        [inviteId, tripId, input.actorUserId, displayName, runtimeUsername, sha256(token)],
      );
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") return { ok: false, status: 409, error: "INVITE_ALREADY_EXISTS" };
      throw error;
    }
    await client.query("COMMIT");
    return { ok: true, id: inviteId, joinUrl: `${deps.publicOrigin}/join#token=${token}`, displayName, expiresAt: inserted.rows[0]!.expires_at.toISOString() };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

// Trip states a terminally failed build can be retried from: `retryProvision`'s own RETRYABLE_STATES, minus
// `intake_confirmed` (a trip there has no live build to retry: it is asked to request provisioning instead).
const RETRY_FROM_STATES = new Set(["planned", "provisioning_approved", "provisioning", "ready_private"]);

function nextAction(state: string, planStatus?: string | null, jobState?: string | null, runtimeReady = false, canRetry = true): string {
  if (state === "draft" || state === "intake_in_progress") return "continue_interview";
  if (state === "intake_confirmed") return "request_provisioning";
  // The organizer's own next move, not a wait on someone else.
  if (planStatus === "pending_approval") return "review_plan";
  // The build gave up after its attempts (worker `_fail`): the organizer can ask for it again (POST .../provisioning-retry).
  // Never for a retired (torn-down) or suspended trip: a rebuild must not be offered where the route refuses it.
  if (jobState === "failed" && canRetry && RETRY_FROM_STATES.has(state)) return "retry_provisioning";
  if (["queued", "leased", "running"].includes(jobState ?? "")) return "track_provisioning";
  if (state === "ready_private" || state === "active") return runtimeReady ? "open_trip" : "view_status";
  if (state === "completed" || state === "sealed") return "view_trip";
  return "view_status";
}

/**
 * What a session may be told about the Telegram links on a card: a FULL session gets the Unlinked accounts
 * (Restore) and every label; a Telegram-minted one gets neither, except the label of its own account.
 */
function linkView(user: PortalUser): { restorable: boolean; labels: LabelVisibility } {
  return user.scope ? { restorable: false, labels: { ownDigest: user.scope.telegramDigest } } : { restorable: true, labels: "all" };
}

async function tripDetail(deps: PortalDependencies, tripId: string, userId: string, opts: { restorable?: boolean; labels?: LabelVisibility } = {}) {
  const tripResult = await deps.db.query<{
    id: string; title: string | null; destination_label: string | null; start_date: string | null; end_date: string | null;
    trip_type: string | null; lifecycle_state: string; slug: string; suspended: boolean; role: string; dashboard_access: boolean; runtime_access: boolean;
  }>(
    `SELECT t.id, t.title, t.destination_label, t.start_date::text, t.end_date::text, t.trip_type,
            t.lifecycle_state, t.slug, (t.suspended_at IS NOT NULL) AS suspended, m.role, m.dashboard_access, m.runtime_access
     FROM control_plane.trips t JOIN control_plane.trip_memberships m ON m.trip_id = t.id
     WHERE t.id = $1 AND m.user_id = $2 AND m.status = 'active'`,
    [tripId, userId],
  );
  const trip = tripResult.rows[0];
  if (!trip) return null;
  const [planResult, sessionResult, routeResult, invitesResult, pausedSessionId] = await Promise.all([
    deps.db.query<{ id: string; status: string; digest: string; release_id: string | null; job_state: string | null; safe_error_code: string | null }>(
      `SELECT p.id, p.status, p.digest, p.release_id, j.state AS job_state, j.safe_error_code
       FROM control_plane.plans p
       LEFT JOIN control_plane.jobs j ON j.plan_id = p.id
       WHERE p.trip_id = $1 ORDER BY p.created_at DESC LIMIT 1`, [tripId]),
    deps.db.query<{ id: string; state: string }>("SELECT id, state FROM control_plane.intake_sessions WHERE trip_id = $1 ORDER BY created_at DESC LIMIT 1", [tripId]),
    deps.db.query<{ state: string }>("SELECT state FROM control_plane.runtime_routes WHERE trip_id = $1", [tripId]),
    deps.db.query<{ id: string; intended_display_name: string; runtime_username: string; state: string; expires_at: Date; created_at: Date }>(
      "SELECT id, intended_display_name, runtime_username, state, expires_at, created_at FROM control_plane.site_invites WHERE trip_id = $1 ORDER BY created_at DESC", [tripId]),
    // Only a trip still being interviewed can be paused; a built one never is, whatever sessions it holds.
    trip.lifecycle_state === "draft" || trip.lifecycle_state === "intake_in_progress" ? pausedInterviewSessionId(deps.db, tripId) : Promise.resolve(null),
  ]);
  const plan = planResult.rows[0];
  const runtimeReady = routeResult.rows[0]?.state === "ready";
  // Who is on the trip, for the organizer's "remove member". The handle is the
  // membership id, never a user id. `removable` is the server's own answer so
  // the page does not re-derive the rules (not yourself; owners only by an
  // owner; never the last owner/organizer).
  const memberRows = trip.dashboard_access ? await deps.db.query<{
    id: string; user_id: string; display_name: string; role: string; runtime_username: string | null;
  }>(
    `SELECT m.id, m.user_id, u.display_name, m.role,
            (SELECT i.runtime_username FROM control_plane.site_invites i
              WHERE i.trip_id = m.trip_id AND i.redeemed_by = m.user_id AND i.state = 'redeemed'
              ORDER BY i.redeemed_at DESC LIMIT 1) AS runtime_username
       FROM control_plane.trip_memberships m JOIN control_plane.users u ON u.id = m.user_id
      WHERE m.trip_id = $1 AND m.status = 'active'
        -- a secondary organizer (#523) is listed, and removed, as one: not as a member the dashboard counts as an organizer
        AND NOT EXISTS (SELECT 1 FROM control_plane.trip_secondary_organizers so WHERE so.trip_id = m.trip_id AND so.user_id = m.user_id)
      ORDER BY m.created_at, m.id`, [tripId]) : { rows: [] };
  const isOrganizerSide = (role: string) => role === "owner" || role === "organizer";
  const members = memberRows.rows.map((row) => {
    const others = memberRows.rows.filter((other) => other.user_id !== row.user_id);
    const removable = trip.dashboard_access && isOrganizerSide(trip.role) && row.user_id !== userId
      && !(row.role === "owner" && (trip.role !== "owner" || !others.some((other) => other.role === "owner")))
      && !(isOrganizerSide(row.role) && !others.some((other) => isOrganizerSide(other.role)));
    return { id: row.id, displayName: row.display_name, role: row.role, runtimeUsername: row.runtime_username, you: row.user_id === userId, removable };
  });
  return {
    id: trip.id,
    title: trip.title ?? trip.destination_label ?? "Untitled trip",
    destination: trip.destination_label,
    startDate: trip.start_date,
    endDate: trip.end_date,
    tripType: trip.trip_type ?? "other",
    lifecycleState: trip.lifecycle_state,
    nextAction: nextAction(trip.lifecycle_state, plan?.status, plan?.job_state, runtimeReady, !trip.suspended && !trip.slug.startsWith(RETIRED_SLUG_PREFIX)),
    permissions: {
      role: trip.role,
      dashboard: trip.dashboard_access,
      runtime: trip.runtime_access,
      invite: trip.role === "owner" || trip.role === "organizer",
      requestProvisioning: trip.role === "owner",
    },
    // `paused` (#513): the session closed for idleness and nothing else holds the trip, so the page offers a NEW
    // link rather than "Continue in Telegram" to a chat that has stopped listening. Read from the one definition
    // `issueEnrollment` and `replaceEnrollment` share, so what the page offers is what the routes will accept.
    interview: sessionResult.rows[0]
      ? { sessionId: sessionResult.rows[0].id, state: sessionResult.rows[0].state, paused: pausedSessionId !== null }
      : null,
    provisioning: plan ? {
      planId: plan.id, planStatus: plan.status, jobState: plan.job_state,
      releaseId: plan.release_id, digest: plan.digest, safeErrorCode: plan.safe_error_code,
    } : null,
    runtimeReady,
    members,
    // Which Telegram accounts can open THIS trip as the viewer: the card's
    // linked / not-linked icon and its ⋮ menu's Unlink entries.
    telegram: {
      links: (await telegramLinksByTrip(deps.db, userId, [tripId], opts.labels)).get(tripId) ?? [],
      // Unlinked accounts the owner may Restore. A FULL session only (the caller decides): a Telegram-minted
      // session is never told which accounts were Unlinked, because it cannot restore one (portal-scope.ts).
      ...(opts.restorable ? { unlinked: (await unlinkedTelegramLinksByTrip(deps.db, userId, [tripId])).get(tripId) ?? [] } : {}),
    },
    // Secondary organizers (#523), named for the MAIN organizer's page only: an owner on a full session. A Telegram-minted session
    // is never handed this list (it cannot remove anyone, and the names are display data of other people).
    ...(opts.restorable && trip.dashboard_access && trip.role === "owner"
      ? { secondaryOrganizers: await listSecondaryOrganizers(deps.db, tripId) }
      : {}),
    invites: invitesResult.rows.map((invite) => ({
      id: invite.id, displayName: invite.intended_display_name, runtimeUsername: invite.runtime_username,
      status: invite.state === "unused" && invite.expires_at.getTime() < Date.now() ? "expired" : invite.state,
      expiresAt: invite.expires_at.toISOString(), createdAt: invite.created_at.toISOString(),
    })),
  };
}

/**
 * What a member WITHOUT dashboard access may see of a trip in their list: the
 * trip's name, place, dates, their own permissions and whether it can be
 * opened. Nothing of the organizer's workbench — invitees' names and usernames,
 * invite ids, plan id/digest/status, the interview session, the lifecycle —
 * which `tripDetail` carries for the people who run the trip.
 */
async function memberTripSummary(deps: PortalDependencies, tripId: string, userId: string, labels?: LabelVisibility) {
  const result = await deps.db.query<{
    id: string; title: string | null; destination_label: string | null; start_date: string | null; end_date: string | null;
    role: string; dashboard_access: boolean; runtime_access: boolean; runtime_ready: boolean;
  }>(
    `SELECT t.id, t.title, t.destination_label, t.start_date::text, t.end_date::text, m.role, m.dashboard_access, m.runtime_access,
            EXISTS (SELECT 1 FROM control_plane.runtime_routes r WHERE r.trip_id = t.id AND r.state = 'ready') AS runtime_ready
       FROM control_plane.trips t JOIN control_plane.trip_memberships m ON m.trip_id = t.id
      WHERE t.id = $1 AND m.user_id = $2 AND m.status = 'active'`,
    [tripId, userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    title: row.title ?? row.destination_label ?? "Untitled trip",
    destination: row.destination_label,
    startDate: row.start_date,
    endDate: row.end_date,
    permissions: { role: row.role, dashboard: false, runtime: row.runtime_access, invite: false, requestProvisioning: false },
    runtimeReady: row.runtime_ready,
    telegram: { links: (await telegramLinksByTrip(deps.db, userId, [tripId], labels)).get(tripId) ?? [] },
  };
}

export function registerPortalRoutes(app: FastifyInstance, deps: PortalDependencies): void {
  // Every route registered below must have a scope policy (portal-scope.ts), or
  // the app does not boot: a route that forgot would fail only for a Telegram
  // session, which is exactly the session nobody tests by hand.
  const registered: string[] = [];
  let collecting = true;
  app.addHook("onRoute", (route) => {
    if (!collecting) return;
    for (const method of ([] as string[]).concat(route.method)) {
      if (method !== "HEAD" && method !== "OPTIONS") registered.push(`${method} ${route.url}`);
    }
  });
  registerPortalRouteHandlers(app, deps);
  collecting = false;
  // Sign-up and reset work happens after the response; closing the app waits for it.
  app.addHook("onClose", async () => { await portalMailIdle(); });
  assertEveryRouteIsClassified(registered);
}

function registerPortalRouteHandlers(app: FastifyInstance, deps: PortalDependencies): void {
  app.post("/v1/events", async (request, reply) => {
    const event = (request.body as Record<string, unknown>)?.event;
    if (event !== "landing_cta") return reply.code(400).send({ error: "INVALID_REQUEST" });
    await recordFunnelEvent(deps.db, "landing_cta");
    return reply.code(202).send({ accepted: true });
  });

  app.get("/v1/auth/capabilities", async () => ({
    google: Boolean(deps.google),
    // The PUBLIC OAuth client ID the page needs to draw Google's button; present exactly when `google` is true.
    ...(deps.google ? { googleClientId: deps.google.clientId } : {}),
    emailPassword: true,
    // Whether the portal can send the verification / reset message at all. False renders "Sign-up isn't open yet".
    emailSignUp: Boolean(deps.mailer),
    telegramMiniApp: Boolean(deps.telegramMiniApp?.enabled()),
    // "Send me a sign-in link" (slice S3) is on at the EVERY-TRIP level. One boolean, the same for every caller: it says nothing
    // about any single trip, so an anonymous page cannot use it to learn where the feature is on.
    signInLink: await signInLinkAvailable(deps.db, (line) => (deps.emailAuthLog ?? ((l: string) => process.stderr.write(`${l}\n`)))(line)),
  }));

  // Bound both expensive credential checks and limiter memory. Use the socket
  // peer from Fastify (trustProxy is off), never caller-supplied forwarding.
  type Attempts = Map<string, { count: number; expiresAt: number }>;
  const loginAttempts: Attempts = new Map();
  const accountAttempts: Attempts = new Map();
  // Mini App launches and the trip-password route get limiters of their own, so
  // a flood against one cannot spend another's allowance. The per-person and
  // per-account maps are only ever keyed AFTER the thing being keyed has been
  // verified to exist (a signed initData, a credential row): keyed earlier, any
  // caller could fill the 1024 slots with junk and lock everyone else out.
  const miniAppIpAttempts: Attempts = new Map();
  const miniAppUserAttempts: Attempts = new Map();
  const passwordIpAttempts: Attempts = new Map();
  const passwordAccountAttempts: Attempts = new Map();
  function admitLogin(attempts: Attempts, key: string, limit: number): boolean {
    const now = Date.now();
    for (const [storedKey, entry] of attempts) if (entry.expiresAt <= now) attempts.delete(storedKey);
    const previous = attempts.get(key);
    if ((previous && previous.count >= limit) || (!previous && attempts.size >= 1024)) return false;
    attempts.set(key, { count: (previous?.count ?? 0) + 1, expiresAt: previous?.expiresAt ?? now + 60_000 });
    return true;
  }
  app.post("/v1/auth/email-password", async (request, reply) => {
    if (!admitLogin(loginAttempts, request.ip, 100)) {
      return reply.header("retry-after", "60").code(429).send({ error: "SIGN_IN_RATE_LIMITED" });
    }
    // A login creates only a session, never an account or a credential.
    const body = request.body as Record<string, unknown> | null;
    if (!body || typeof body.email !== "string" || body.email.length > 254 ||
        typeof body.password !== "string" || body.password.length > 1024) {
      return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
    }
    // Same-origin forms do not require a pre-existing session's CSRF token,
    // but must not let another origin force the browser into a chosen account.
    if (request.headers.origin && request.headers.origin !== deps.publicOrigin) {
      return reply.code(403).send({ error: "ORIGIN_INVALID" });
    }
    if (!admitLogin(accountAttempts, sha256(body.email.trim().toLowerCase()), 10)) {
      return reply.header("retry-after", "60").code(429).send({ error: "SIGN_IN_RATE_LIMITED" });
    }
    const result = await verifyPasswordLogin(deps.db, body);
    if (!result.ok) return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
    const client = await deps.db.connect();
    try {
      await client.query("BEGIN");
      const user = await client.query("SELECT id FROM control_plane.users WHERE id = $1 AND status = 'active' FOR SHARE", [result.identity.providerSubjectId]);
      if (!user.rows[0]) { await client.query("ROLLBACK"); return reply.code(401).send({ error: "INVALID_CREDENTIALS" }); }
      const session = await createWebSession(client, user.rows[0].id, deps.sessionTtlSeconds);
      await client.query("COMMIT");
      setWebSessionCookies(reply, deps, session, { embedded: embeddedRequest(body) });
      return { appPath: validatedReturnTo(body.returnTo) };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  });

  // ── Email sign-up, verification and password reset (portal-email-auth.ts) ──
  //
  //   POST /v1/auth/sign-up          { email, returnTo?, language? }  202 { status: "check_your_email" }  (no password, no name: both are chosen at verification)
  //   POST /v1/auth/verify-email     { token, password, displayName }  200 { appPath } + session cookies | 400 TOKEN_INVALID | 400 PASSWORD_TOO_SHORT | 400 INVALID_NAME | 409 ACCOUNT_EXISTS
  //   POST /v1/auth/password/forgot  { email, language? }      202 { status: "check_your_email" }
  //   POST /v1/auth/password/reset   { token, password }       200 { appPath } + session cookies | 400 TOKEN_INVALID
  //
  // All four are `open` (portal-scope.ts): none reads the session cookie, so a
  // Telegram-scoped session gets no more and no less from them than a stranger;
  // the emailed token is the whole authority. Sign-up and forgot answer 503
  // SIGN_UP_UNAVAILABLE without a mailer, and answer 202 identically for an
  // address that has an account and one that has not (the work follows the
  // response; see portal-email-auth.ts). Every one is `no-store` and needs our
  // own Origin, like /v1/auth/password: verify and reset SIGN SOMEBODY IN, so a
  // page on another site must not be able to post a token it holds.
  const signUpIpAttempts: Attempts = new Map();
  const forgotIpAttempts: Attempts = new Map();
  const emailTokenIpAttempts: Attempts = new Map();
  /**
   * The per-IP counter for these routes. Unlike `admitLogin` it never refuses a caller because the map is
   * full: a fixed-size map that fails closed is filled with junk keys by whoever has enough addresses and
   * then locks out everyone (boundary review M2). At capacity it forgets the oldest entry instead, so memory
   * stays bounded and a flood can only rotate through its own addresses. What a flood can send is bounded by
   * the persistent budgets in portal-email-auth.ts, not by this map.
   */
  const admitEmailIp = (attempts: Attempts, key: string, limit: number): boolean => {
    const now = Date.now();
    for (const [storedKey, entry] of attempts) if (entry.expiresAt <= now) attempts.delete(storedKey);
    const previous = attempts.get(key);
    if (previous && previous.count >= limit) return false;
    if (!previous && attempts.size >= 1024) attempts.delete(attempts.keys().next().value as string);
    attempts.set(key, { count: (previous?.count ?? 0) + 1, expiresAt: previous?.expiresAt ?? now + 60_000 });
    return true;
  };
  const emailAuthLog = (line: string) => (deps.emailAuthLog ?? ((l: string) => process.stderr.write(`${l}\n`)))(line);
  const emailAuthContext = (mailer: Mailer): EmailAuthContext => ({ db: deps.db, mailer, publicOrigin: deps.publicOrigin, log: emailAuthLog });
  const jsonBody = (request: FastifyRequest): Record<string, unknown> =>
    request.body && typeof request.body === "object" && !Array.isArray(request.body) ? request.body as Record<string, unknown> : {};
  /** The page's own `returnTo`, kept only if it is a path the migration's CHECK also accepts. */
  const storableReturnTo = (value: unknown): string => {
    const path = validatedReturnTo(value);
    return /^\/[A-Za-z0-9/_?=&.#%-]*$/.test(path) ? path : "/trips";
  };

  app.post("/v1/auth/sign-up", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    if (!deps.mailer) return reply.code(503).send({ error: "SIGN_UP_UNAVAILABLE" });
    if (!admitEmailIp(signUpIpAttempts, request.ip, 20)) return reply.header("retry-after", "60").code(429).send({ error: "SIGN_UP_RATE_LIMITED" });
    if (!originIsOurs(request, deps)) return reply.code(403).send({ error: "ORIGIN_INVALID" });
    const body = jsonBody(request);
    // There is deliberately no password and no name here: a `password` or `displayName` in the body is ignored,
    // never stored, never mailed. The person chooses both on the page the emailed link opens (portal-email-auth.ts).
    // One spelling of the address (strict ASCII, lower-cased) for the digest, the budget and the mail's `to`.
    // The per-address budget is persistent and lives in the database (portal-email-auth.ts), not in a map here.
    const email = normalizeEmail(body.email);
    if (email === null) return reply.code(400).send({ error: "INVALID_EMAIL" });
    const input = {
      email,
      returnTo: storableReturnTo(body.returnTo ?? body.return_to), language: pickLanguage(body.language, request.headers["accept-language"]),
    };
    const ctx = emailAuthContext(deps.mailer);
    runInBackground(() => startSignUp(ctx, input), (error) =>
      emailAuthLog(structuredLog("error", "email_auth.sign_up_failed", { safe_error_code: error instanceof Error ? error.name : "UNKNOWN" })));
    return reply.code(202).send({ status: "check_your_email" });
  });

  app.post("/v1/auth/verify-email", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    if (!admitEmailIp(emailTokenIpAttempts, request.ip, 30)) return reply.header("retry-after", "60").code(429).send({ error: "SIGN_IN_RATE_LIMITED" });
    if (!originIsOurs(request, deps)) return reply.code(403).send({ error: "ORIGIN_INVALID" });
    const body = jsonBody(request);
    if (typeof body.password !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });
    // Before the token is touched: a typo in the password or the name must not burn the link.
    if (body.password.length < PASSWORD_MIN_LENGTH) return reply.code(400).send({ error: "PASSWORD_TOO_SHORT" });
    if (body.password.length > PASSWORD_MAX_LENGTH) return reply.code(400).send({ error: "INVALID_REQUEST" });
    const displayName = cleanDisplayName(body.displayName);
    if (displayName === null) return reply.code(400).send({ error: "INVALID_NAME" });
    // Hashed before the transaction, so a bad token costs the same scrypt and no row lock is held meanwhile.
    const passwordHash = await hashPassword(body.password);
    const client = await deps.db.connect();
    try {
      await client.query("BEGIN");
      const result = await consumeSignUpToken(client, body.token, passwordHash, displayName);
      if (!result.ok) {
        // Commit: a spent token stays spent, even when the address turned out to have an account already.
        await client.query("COMMIT");
        return reply.code(result.error === "ACCOUNT_EXISTS" ? 409 : 400).send({ error: result.error });
      }
      const session = await createWebSession(client, result.userId, deps.sessionTtlSeconds);
      await client.query("COMMIT");
      setWebSessionCookies(reply, deps, session);
      return { appPath: validatedReturnTo(result.returnTo) };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      throw error;
    } finally { client.release(); }
  });

  app.post("/v1/auth/password/forgot", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    if (!deps.mailer) return reply.code(503).send({ error: "SIGN_UP_UNAVAILABLE" });
    if (!admitEmailIp(forgotIpAttempts, request.ip, 20)) return reply.header("retry-after", "60").code(429).send({ error: "SIGN_UP_RATE_LIMITED" });
    if (!originIsOurs(request, deps)) return reply.code(403).send({ error: "ORIGIN_INVALID" });
    const body = jsonBody(request);
    const email = normalizeEmail(body.email);
    if (email === null) return reply.code(400).send({ error: "INVALID_EMAIL" });
    const input = { email, language: pickLanguage(body.language, request.headers["accept-language"]) };
    const ctx = emailAuthContext(deps.mailer);
    runInBackground(() => startPasswordReset(ctx, input), (error) =>
      emailAuthLog(structuredLog("error", "email_auth.password_reset_failed", { safe_error_code: error instanceof Error ? error.name : "UNKNOWN" })));
    return reply.code(202).send({ status: "check_your_email" });
  });

  app.post("/v1/auth/password/reset", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    if (!admitEmailIp(emailTokenIpAttempts, request.ip, 30)) return reply.header("retry-after", "60").code(429).send({ error: "SIGN_IN_RATE_LIMITED" });
    if (!originIsOurs(request, deps)) return reply.code(403).send({ error: "ORIGIN_INVALID" });
    const body = jsonBody(request);
    if (typeof body.token !== "string" || typeof body.password !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });
    // Before the token is touched: a typo in the new password must not burn the link.
    if (body.password.length < PASSWORD_MIN_LENGTH) return reply.code(400).send({ error: "PASSWORD_TOO_SHORT" });
    if (body.password.length > PASSWORD_MAX_LENGTH) return reply.code(400).send({ error: "INVALID_REQUEST" });
    const passwordHash = await hashPassword(body.password);
    const client = await deps.db.connect();
    try {
      await client.query("BEGIN");
      const result = await consumePasswordReset(client, body.token, passwordHash);
      if (!result.ok) { await client.query("ROLLBACK"); return reply.code(400).send({ error: result.error }); }
      const session = await createWebSession(client, result.userId, deps.sessionTtlSeconds);
      await client.query("COMMIT");
      setWebSessionCookies(reply, deps, session);
      return { appPath: "/trips" };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      throw error;
    } finally { client.release(); }
  });

  // ── "Send me a sign-in link" (sign-in-link.ts; docs/specs/sprint-9/x-member-sign-in.md, slice S3, AC-14 to AC-16) ──
  //
  //   POST /v1/auth/sign-in-link           { email, language? } | { tripId, travellerName }   202 { status: "request_received" }
  //   POST /v1/auth/sign-in-link/redeem    { token }                                          200 { appPath, canSetPassword } + session cookies | 400 TOKEN_INVALID
  //   POST /v1/auth/sign-in-link/password  { password }   (the session the redemption minted)  200 { ok: true } | 400 | 403 | 409
  //
  // THE ANSWER IS THE SAME FOR EVERY CASE the work behind it can end in: account found or not, channel or none, trip real or not,
  // name ambiguous, a ceiling hit, a delivery that failed. It is sent BEFORE any of that work starts (runInBackground), so nothing
  // about how long it takes depends on the case either. Only a request that is not one of the two shapes (400) or that comes from
  // another origin (403) is answered differently, and neither depends on any account. Redemption is a POST, from the landing page
  // the link opens (`/sign-in-link#token=`): a GET never carries the token to the server, so a link previewer cannot spend it.
  const signInLinkIpAttempts: Attempts = new Map();
  const signInLinkRedeemIpAttempts: Attempts = new Map();
  /** One generic answer. A different word for any case would be a way to ask "is there an account?". */
  const SIGN_IN_LINK_ANSWER = { status: "request_received" } as const;
  app.post("/v1/auth/sign-in-link", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    if (!originIsOurs(request, deps)) return reply.code(403).send({ error: "ORIGIN_INVALID" });
    const body = jsonBody(request);
    const hasEmail = "email" in body, hasTraveller = "tripId" in body || "travellerName" in body;
    const emailDoor = hasEmail && !hasTraveller && typeof body.email === "string";
    const travellerDoor = !hasEmail && typeof body.tripId === "string" && typeof body.travellerName === "string";
    if (!emailDoor && !travellerDoor) return reply.code(400).send({ error: "INVALID_REQUEST" });
    // EVERY well-formed request counts against the caller's allowance, an account that does not exist included: a limiter that
    // only counted real accounts would tell a guess from a hit. Over it, the same 202 and nothing else happens.
    const admitted = admitEmailIp(signInLinkIpAttempts, request.ip, 10);
    if (!admitted) {
      // Said once a minute and without the address; and the housekeeping that every admitted request does still runs, so a limiter
      // that keeps refusing cannot leave a stale one-time token sitting in the outbox.
      warnOncePerMinute(emailAuthLog, "sign_in_link.ip_limit_reached", "ip", { effect: "requests from a client address are answered and nothing is sent; a shared address (a family on one connection) shuts the feature for them" });
      runInBackground(() => purgeSignInLinkLeftovers(deps.db), (error) =>
        emailAuthLog(structuredLog("error", "sign_in_link.request_failed", { safe_error_code: error instanceof Error ? error.name : "UNKNOWN" })));
    }
    let input: SignInLinkRequest | null = null;
    if (emailDoor) {
      const email = normalizeEmail(body.email);
      if (email !== null) input = { door: "email", email, language: pickLanguage(body.language, request.headers["accept-language"]) };
    } else {
      const travellerName = String(body.travellerName);
      if (travellerName.length <= 200) input = { door: "traveller", tripId: String(body.tripId), travellerName };
    }
    if (admitted && input) {
      const wanted = input;
      runInBackground(
        () => startSignInLink({
          db: deps.db, mailer: deps.mailer, publicOrigin: deps.publicOrigin,
          listParticipants: (tripId) => deps.runtimeAccounts.listParticipants(tripId), groupSignIn: deps.memberGroupSignIn, log: emailAuthLog,
        }, wanted),
        (error) => emailAuthLog(structuredLog("error", "sign_in_link.request_failed", { safe_error_code: error instanceof Error ? error.name : "UNKNOWN" })));
    }
    return reply.code(202).send(SIGN_IN_LINK_ANSWER);
  });

  app.post("/v1/auth/sign-in-link/redeem", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    if (!admitEmailIp(signInLinkRedeemIpAttempts, request.ip, 30)) return reply.header("retry-after", "60").code(429).send({ error: "SIGN_IN_RATE_LIMITED" });
    if (!originIsOurs(request, deps)) return reply.code(403).send({ error: "ORIGIN_INVALID" });
    const token = jsonBody(request).token;
    // A GROUP CLAIMANT's link is held to the Mini App's gate BEFORE anything is spent or minted (sign-in-link.ts, `peekClaimLink`):
    // the group is asked while no session and no spent link exist, so a hang, a crash or a client that goes away leaves nothing
    // behind. "out": the person left, the claim ends exactly as at a launch and the answer is the one refusal. "unknown": Telegram
    // did not say, so nothing is spent and nothing revoked, and the answer is the retryable one the launch gives. "dormant": the
    // group switch is off or unreadable, the one refusal, nothing spent, nothing revoked (it works again when the switch does).
    const peeked = await peekClaimLink(deps.db, token);
    if (peeked) {
      const verdict = await claimGateVerdict({ db: deps.db, groupSignIn: deps.memberGroupSignIn, log: emailAuthLog }, peeked.claim);
      if (verdict === "out") {
        await releaseSiteBindings(await endClaimLeftGroup(deps.db, peeked.userId, peeked.claim.tripId));
        return reply.code(400).send({ error: "TOKEN_INVALID" });
      }
      if (verdict === "unknown") return reply.header("retry-after", "5").code(503).send({ error: "MEMBERSHIP_CHECK_UNAVAILABLE", retryable: true });
      if (verdict === "dormant") return reply.code(400).send({ error: "TOKEN_INVALID" });
      // Telegram can be slow, and the caller may have gone while it thought. Spending the link and minting a scoped session for a
      // connection that is closed would burn the link and leave a live session nobody holds, so nothing is spent: the same link
      // works for a caller who is there. Same retryable answer as "Telegram did not say" (nobody will read it).
      if (reply.raw.destroyed || request.raw.socket?.destroyed === true) {
        emailAuthLog(structuredLog("info", "sign_in_link.client_gone", { effect: "link not spent, no session minted" }));
        return reply.header("retry-after", "5").code(503).send({ error: "MEMBERSHIP_CHECK_UNAVAILABLE", retryable: true });
      }
    }
    // THE INVARIANT: a link is spent by exactly one transaction, the one that mints its session. Nothing un-spends a link.
    const client = await deps.db.connect();
    try {
      await client.query("BEGIN");
      const result = await consumeSignInLink(client, token);
      if (!result.ok) {
        // Commit: a link spent by a refusal (its account stopped being a member account, its claim ended) stays spent.
        await client.query("COMMIT");
        return reply.code(400).send({ error: "TOKEN_INVALID" });
      }
      // A group claimant's link mints the claim's SCOPED session (portal-scope.ts), exactly as a Mini App launch does.
      const session = await createWebSession(client, result.userId, deps.sessionTtlSeconds, result.telegramLinkId);
      await attachSession(client, result.linkId, session.sessionId);
      await client.query("COMMIT");
      setWebSessionCookies(reply, deps, session);
      return { appPath: "/trips", canSetPassword: result.canSetPassword };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      throw error;
    } finally { client.release(); }
  });

  app.post("/v1/auth/sign-in-link/password", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    const password = jsonBody(request).password;
    if (typeof password !== "string" || password.length > PASSWORD_MAX_LENGTH) return reply.code(400).send({ error: "INVALID_REQUEST" });
    if (password.length < PASSWORD_MIN_LENGTH) return reply.code(400).send({ error: "PASSWORD_TOO_SHORT" });
    // Before the transaction, so scrypt never runs under a row lock. Each store keeps its own hashing helper.
    const [hashForEmailCredential, hashForTripCredential] = await Promise.all([hashPassword(password), hashPortalPassword(password)]);
    const client = await deps.db.connect();
    try {
      await client.query("BEGIN");
      const result = await applyLinkPassword(client, { userId: user.id, sessionId: user.sessionId, hashForEmailCredential, hashForTripCredential });
      if (result !== "ok") {
        await client.query("ROLLBACK");
        if (result === "not_offered") return reply.code(403).send({ error: "PASSWORD_STEP_UNAVAILABLE" });
        return reply.code(409).send({ error: result === "already_set" ? "PASSWORD_ALREADY_SET" : "NO_PASSWORD_TO_REPLACE" });
      }
      await client.query("COMMIT");
      return { ok: true };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      throw error;
    } finally { client.release(); }
  });

  // ── Telegram Mini App sign-in (#442) ──────────────────────────────────────
  //
  // POST /v1/auth/telegram-mini-app  { initData, tripId? }
  //
  //   200 { kind: "session", appPath, notice? }  + the ordinary session cookies
  //   200 { kind: "choose", trips, notice? }     no cookie, no user ids
  //   401 { error: "TELEGRAM_NOT_LINKED", fallback: "trip_password" | "none", tripId? }
  //   401 { error: "TELEGRAM_INIT_DATA_INVALID" }   ONE code for every verification failure
  //   400 INVALID_REQUEST (a tripId that is not shaped like one) · 403 ORIGIN_INVALID
  //   415 · 429 · 503 (feature off)
  //
  // Everything is `private, no-store`. The order below is the security design:
  // cheap structural gates first (feature, per-IP budget, Origin, content type —
  // all in onRequest, before the body is even parsed), then ONE HMAC, and only
  // then anything keyed on the person.
  const miniAppLog = (line: string) => (deps.telegramMiniApp?.log ?? ((l: string) => process.stderr.write(`${l}\n`)))(line);
  // The structural gates both Mini App POSTs share (this one and POST /v1/mini-app/claim below).
  const miniAppGates = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("cache-control", "private, no-store");
    if (!deps.telegramMiniApp?.enabled()) return reply.code(503).send({ error: "TELEGRAM_MINI_APP_UNAVAILABLE" });
    if (!admitLogin(miniAppIpAttempts, request.ip, 100)) {
      return reply.header("retry-after", "60").code(429).send({ error: "SIGN_IN_RATE_LIMITED" });
    }
    // A login-CSRF vector: another site could otherwise post a victim's own
    // initData (or an attacker's) from the victim's browser. Missing and the
    // literal "null" (sandboxed iframes, file:, redirects) are refused too.
    if (!originIsOurs(request, deps)) return reply.code(403).send({ error: "ORIGIN_INVALID" });
    if (!/^application\/json(?:\s*;.*)?$/i.test(String(request.headers["content-type"] ?? ""))) {
      return reply.code(415).send({ error: "UNSUPPORTED_MEDIA_TYPE" });
    }
  };
  // Group sign-in (slice S1 of docs/specs/sprint-9/x-member-sign-in.md). Not wired, or no exchange key to derive the
  // claim ids from, and the path does not exist. The per-trip switch is read on the launch's own connection, inside a
  // savepoint (telegram-mini-app.ts, switchIsOn), so a read that fails costs one answer, off, and not the transaction.
  const groupSignIn: GroupSignInDeps | undefined = deps.memberGroupSignIn && deps.runtimeExchangeKey
    ? {
      switchOn: (db, tripId) => featureEnabled(db, tripId, "member_group_sign_in", miniAppLog),
      isActiveMember: deps.memberGroupSignIn.isActiveMember,
      listParticipants: (tripId) => deps.runtimeAccounts.listParticipants(tripId),
      claimIdKey: createHmac("sha256", deps.runtimeExchangeKey).update("kinerary:member-claim-id:v1").digest(),
    }
    : undefined;
  /**
   * Ends the trip site's binding of travellers whose claims just ended, AFTER the control-plane transaction that ended
   * them has committed (a rolled-back release must unbind nobody). The control plane's own rows are the authority and are
   * already final (membership revoked, link revoked, sessions ended, launch grants spent), so the old account can get no new
   * grant and the gateway's liveness check refuses what it holds. What the site still holds until it hears is the binding,
   * and with it the removed person's assistant (MCP) grants and any site token already issued, so the release is DURABLE
   * (site-release-outbox.ts): the database recorded it in the transaction that ended the claim, this is the prompt attempt
   * (success marks it done; any failure leaves it pending and says so once, by reason only), and a background pass retries
   * until the site confirms. A request that triggered it never fails for the site's sake. No id is logged.
   */
  const siteRelease: SiteReleaseOptions = { db: deps.db, releaser: deps.runtimeAccounts, log: miniAppLog };
  const releaseSiteBindings = async (released: readonly ReleasedClaim[]): Promise<void> => {
    for (const claim of released) {
      // The audit trail (the reason only: no trip, person, traveller, invite or chat id). A removed INVITE member's binding is not a group
      // claim ending, and must not read as one: it has its own event.
      if (claim.inviteId) miniAppLog(structuredLog("info", "member_invite.binding_released", { reason: claim.reason ?? "unknown" }));
      else miniAppLog(structuredLog("info", "mini_app.group_claim", { outcome: "ended", reason: claim.reason ?? "unknown" }));
      await attemptSiteRelease(siteRelease, claim);
    }
  };
  /**
   * GROUP SESSIONS STAY AS GOOD AS THE SEAT IN THE GROUP (spec S1, owner's decisions of 2026-11-20). A session a group claim
   * minted is asked about at two moments that are not a Mini App launch: when it asks for a runtime grant
   * (`POST /v1/trips/:id/launch`, every time) and when the gateway asks whether the trip session it opened is still live
   * (`/internal/runtime-sessions/check`, at most once per 10 minutes per claim: `last_group_check_at`). Never a Telegram
   * call for any other session: the first query decides, and a session that is not wholly a group session is `not_group`.
   *   live     Telegram said "in" (now, or inside the last 10 minutes): carry on.
   *   revoked  Telegram said "not in": the link, claim, sessions and membership end HERE (as at a Mini App launch,
   *            `left_group`), the site binding is released after commit, and the caller refuses like any revoked session.
   *   unknown  Telegram did not say: no grant for a launch (retry), STILL LIVE for the liveness check, nothing revoked, and
   *            `last_group_check_at` is not advanced so the next check asks again (an outage must not log a family out).
   *   dormant  the switch is off or unreadable, the group is not exactly one, or the path is not wired: not live, nothing
   *            revoked, no Telegram call. Switching the feature back on makes the same session work again.
   */
  const GROUP_RECHECK_INTERVAL = "10 minutes";
  const GROUP_LIVENESS_TIMEOUT_MS = 2000;
  const groupSessionVerdict = async (input: { tripId: string; userId: string; sessionId: string | null; everyTime: boolean }): Promise<"not_group" | "live" | "revoked" | "unknown" | "dormant"> => {
    const sessions = await deps.db.query<{ is_group: boolean | null }>(
      `SELECT (l.verified_via = $3) AS is_group
         FROM control_plane.web_sessions s
         LEFT JOIN control_plane.telegram_member_links l ON l.id = s.telegram_link_id
        WHERE s.user_id = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND ($2::text IS NULL OR s.id = $2::text)`,
      [input.userId, input.sessionId, GROUP_VERIFIED_VIA]);
    if (sessions.rows.length === 0 || !sessions.rows.every((row) => row.is_group === true)) return "not_group";
    if (!groupSignIn || !(await featureEnabled(deps.db, input.tripId, "member_group_sign_in", miniAppLog))) return "dormant";
    const claim = await deps.db.query<{ telegram_user_id: string | null; fresh: boolean }>(
      `SELECT telegram_user_id, (last_group_check_at IS NOT NULL AND last_group_check_at > now() - interval '${GROUP_RECHECK_INTERVAL}') AS fresh
         FROM control_plane.trip_participant_claims WHERE trip_id = $1 AND user_id = $2 AND released_at IS NULL`,
      [input.tripId, input.userId]);
    const telegramUserId = claim.rows[0]?.telegram_user_id;
    if (!telegramUserId) return "dormant";
    if (!input.everyTime && claim.rows[0]!.fresh) return "live";
    const chat = await openGroupChat(deps.db, input.tripId);
    if (!chat) return "dormant";
    // The liveness path answers the gateway, which gives up after 5 s: its Telegram wait is shorter than a launch's, so a slow
    // database cannot tip a Telegram hang into a logout.
    const member = await groupSignIn.isActiveMember(chat, telegramUserId, input.everyTime ? undefined : { timeoutMs: GROUP_LIVENESS_TIMEOUT_MS });
    if (member === "unknown") return "unknown";
    if (member === true) {
      await deps.db.query("UPDATE control_plane.trip_participant_claims SET last_group_check_at = now() WHERE trip_id = $1 AND user_id = $2 AND released_at IS NULL", [input.tripId, input.userId]);
      return "live";
    }
    const client = await deps.db.connect();
    let ended: ReleasedClaim[];
    try {
      await client.query("BEGIN");
      ended = await endGroupClaimInTx(client, { tripId: input.tripId, userId: input.userId, linkReason: "left_group", claimReason: "left_group" });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    await releaseSiteBindings(ended);
    return "revoked";
  };
  app.post("/v1/auth/telegram-mini-app", {
    // initData is capped at 4096 bytes; a body that cannot hold one is not one.
    bodyLimit: 65536,
    onRequest: miniAppGates,
  }, async (request, reply) => {
    const cfg = deps.telegramMiniApp!;
    const body = request.body && typeof request.body === "object" && !Array.isArray(request.body) ? request.body as Record<string, unknown> : {};
    // Only `initData`, the signed string, is ever read. Not initDataUnsafe, not a
    // user object, not a query parameter.
    const verified = verifyMiniAppInitData(body.initData, cfg.botToken, { maxAgeSeconds: cfg.maxAgeSeconds });
    if (!verified.ok) {
      miniAppLog(structuredLog("warn", "mini_app.init_data_rejected", { reason: verified.reason }));
      return reply.code(401).send({ error: "TELEGRAM_INIT_DATA_INVALID" });
    }
    const launch: VerifiedInitData = verified.data;
    // Keyed by a hash of the id and held in memory only; reachable solely with a
    // signature Telegram made, so junk cannot fill the map.
    if (!admitLogin(miniAppUserAttempts, sha256(`miniapp:${launch.telegramUserId}`), 20)) {
      return reply.header("retry-after", "60").code(429).send({ error: "SIGN_IN_RATE_LIMITED" });
    }
    let requestedTripId: string | null = null;
    if (body.tripId !== undefined && body.tripId !== null) {
      if (typeof body.tripId !== "string" || !TRIP_ID_PATTERN.test(body.tripId)) return reply.code(400).send({ error: "INVALID_REQUEST" });
      requestedTripId = body.tripId;
    }
    const incoming = parseCookies(request.headers.cookie).kit_session;
    const revokeIncoming = async (client: pg.PoolClient) => {
      // A verified launch replaces whatever session this WebView already held:
      // on a shared device the previous person must not stay signed in behind it.
      if (incoming) await client.query("UPDATE control_plane.web_sessions SET revoked_at = now() WHERE token_digest = ANY($1::text[]) AND revoked_at IS NULL", [sessionDigests(incoming)]);
    };
    const client = await deps.db.connect();
    try {
      await client.query("BEGIN");
      const requestGroup = groupSignIn ? { ...groupSignIn, released: [] as ReleasedClaim[] } : undefined;
      const outcome = await resolveMiniAppLaunch(client, launch, requestedTripId, requestGroup);
      if (outcome.kind === "unavailable") {
        // Committed, not rolled back: a group link this launch found the person had LEFT was ended in this transaction.
        // No cookie is touched and nothing here names the trip.
        await client.query("COMMIT");
        await releaseSiteBindings(requestGroup?.released ?? []);
        miniAppLog(structuredLog("warn", "mini_app.sign_in", { outcome: "unavailable" }));
        return reply.header("retry-after", "5").code(503).send({ error: "MEMBERSHIP_CHECK_UNAVAILABLE", retryable: true });
      }
      if (outcome.kind === "session") {
        if (!(await claimSessionSlot(client, launch, cfg.maxAgeSeconds))) {
          // The launch has minted its allowance. Same answer as any other bad initData.
          await client.query("ROLLBACK");
          miniAppLog(structuredLog("warn", "mini_app.init_data_rejected", { reason: "REPLAY_CAP" }));
          return reply.code(401).send({ error: "TELEGRAM_INIT_DATA_INVALID" });
        }
        const used = await recordLinkSignIn(client, outcome.target.linkKind, outcome.target.linkId, launch.name);
        if (!used) {
          await client.query("ROLLBACK");
          return reply.code(401).send({ error: "TELEGRAM_NOT_LINKED", fallback: "none" });
        }
        const session = await createWebSession(client, outcome.target.userId, deps.sessionTtlSeconds, outcome.target.linkId);
        // First use of this link: tell the account owner's OWN chats (not the signer).
        const noticesQueued = used.first
          ? await enqueueSignInNotice(client, {
            signerTelegramId: launch.telegramUserId, userId: outcome.target.userId, accountName: outcome.target.userDisplayName,
            linkKind: outcome.target.linkKind, tripTitle: outcome.target.tripTitle,
          })
          : 0;
        await revokeIncoming(client);
        await client.query("COMMIT");
        await releaseSiteBindings(requestGroup?.released ?? []);
        setWebSessionCookies(reply, deps, session, { embedded: embeddedRequest(body) });
        miniAppLog(structuredLog("info", "mini_app.sign_in", { outcome: "session", link_kind: outcome.target.linkKind, first_use: used.first, notices_queued: noticesQueued }));
        return { kind: "session", appPath: outcome.target.appPath, ...(outcome.notice ? { notice: outcome.notice } : {}) };
      }
      await revokeIncoming(client);
      await client.query("COMMIT");
      await releaseSiteBindings(requestGroup?.released ?? []);
      if (incoming) clearWebSessionCookies(reply, deps);
      miniAppLog(structuredLog("info", "mini_app.sign_in", { outcome: outcome.kind }));
      if (outcome.kind === "choose") return { kind: "choose", trips: outcome.trips, ...(outcome.notice ? { notice: outcome.notice } : {}) };
      // An offer to pick a name. No cookie, no user id; the claim ids mean nothing without the server's key.
      if (outcome.kind === "claim") return { kind: "claim", tripId: outcome.tripId, travellers: outcome.travellers };
      return reply.code(401).send({ error: "TELEGRAM_NOT_LINKED", fallback: outcome.fallback, ...(outcome.tripId ? { tripId: outcome.tripId } : {}) });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  // ── Group sign-in: the claim (slice S1 of docs/specs/sprint-9/x-member-sign-in.md) ────────────────────────────
  //
  // POST /v1/mini-app/claim  { initData, tripId, claimId }
  //
  //   200 { kind: "session", appPath }  + the ordinary scoped session cookies (as a linked launch)
  //   409 { error: "ALREADY_CLAIMED" }  the traveller (or this Telegram account on this trip) is taken; nothing written
  //   404 { error: "NOT_FOUND" }        ONE refusal for: switch off, no single open group, not in it (or Telegram did
  //                                     not say so), a claimId that is not this trip's, a role that is not `member`
  //   401 { error: "TELEGRAM_INIT_DATA_STALE" }    valid but older than LINK_MAX_AUTH_AGE_SECONDS: open the app again
  //   401 { error: "TELEGRAM_INIT_DATA_INVALID" }  as the launch route
  //   400 INVALID_REQUEST (a tripId or claimId that is not shaped like one) · 403 · 415 · 429 · 503 as the launch route
  //
  // Same gates as the launch (miniAppGates), the same per-person budget, then ONE transaction (claimTravellerInTx) that
  // either writes everything or nothing. `open` in portal-scope.ts: the signed initData is the whole authority and the
  // route reads no session, so a scoped session gets nothing more or less from it than a stranger.
  app.post("/v1/mini-app/claim", { bodyLimit: 65536, onRequest: miniAppGates }, async (request, reply) => {
    const cfg = deps.telegramMiniApp!;
    const body = jsonBody(request);
    const verified = verifyMiniAppInitData(body.initData, cfg.botToken, { maxAgeSeconds: cfg.maxAgeSeconds });
    if (!verified.ok) {
      miniAppLog(structuredLog("warn", "mini_app.init_data_rejected", { reason: verified.reason }));
      return reply.code(401).send({ error: "TELEGRAM_INIT_DATA_INVALID" });
    }
    const launch: VerifiedInitData = verified.data;
    if (!admitLogin(miniAppUserAttempts, sha256(`miniapp:${launch.telegramUserId}`), 20)) {
      return reply.header("retry-after", "60").code(429).send({ error: "SIGN_IN_RATE_LIMITED" });
    }
    if (typeof body.tripId !== "string" || !TRIP_ID_PATTERN.test(body.tripId) || typeof body.claimId !== "string" || !CLAIM_ID_SHAPE.test(body.claimId)) {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }
    const tripId = body.tripId, claimId = body.claimId;
    if (!groupSignIn) return reply.code(404).send({ error: "NOT_FOUND" });
    const incoming = parseCookies(request.headers.cookie).kit_session;
    const client = await deps.db.connect();
    // Set once the trip site holds the binding, so anything that fails AFTER it (the commit itself) can undo it.
    let siteBound: { tripId: string; userId: string; runtimeUsername: string } | null = null;
    let committed = false;
    try {
      await client.query("BEGIN");
      const result = await claimTravellerInTx(client, { launch, maxAgeSeconds: cfg.maxAgeSeconds, tripId, claimId, group: groupSignIn, log: miniAppLog });
      if (result.kind !== "claimed") {
        await client.query("ROLLBACK");
        miniAppLog(structuredLog("info", "mini_app.group_claim", { outcome: result.kind }));
        if (result.kind === "stale") return reply.code(401).send({ error: "TELEGRAM_INIT_DATA_STALE" });
        if (result.kind === "already_claimed") return reply.code(409).send({ error: "ALREADY_CLAIMED" });
        // The site could not say who is on the trip: nothing is known, so say "try again", not "no".
        if (result.kind === "unavailable") return reply.header("retry-after", "5").code(503).send({ error: "MEMBERSHIP_CHECK_UNAVAILABLE", retryable: true });
        return reply.code(404).send({ error: "NOT_FOUND" });
      }
      if (!(await claimSessionSlot(client, launch, cfg.maxAgeSeconds))) {
        await client.query("ROLLBACK");
        miniAppLog(structuredLog("warn", "mini_app.init_data_rejected", { reason: "REPLAY_CAP" }));
        return reply.code(401).send({ error: "TELEGRAM_INIT_DATA_INVALID" });
      }
      const session = await createWebSession(client, result.target.userId, deps.sessionTtlSeconds, result.target.linkId);
      // A verified claim replaces whatever session this WebView held, exactly as a verified launch does.
      if (incoming) await client.query("UPDATE control_plane.web_sessions SET revoked_at = now() WHERE token_digest = ANY($1::text[]) AND revoked_at IS NULL", [sessionDigests(incoming)]);
      // THE SITE BINDING, LAST BEFORE THE COMMIT. A claim opens the trip only if the trip site knows the new account, so
      // the claim is not final until the site says so: every control-plane write above is still inside this open
      // transaction, and nothing has been sent to the person. The three ways this can end:
      //   the site binds          -> COMMIT; the person has a session and the site can be opened. (If the COMMIT itself
      //                              then fails, the catch below unbinds; if even that fails, nothing is stuck: the leftover
      //                              names an account that was never committed, and the next adopt of the traveller replaces it.)
      //   the site says no        -> ROLLBACK; no claim, no account, no session. "refused" is the 404 every refusal gets;
      //                              "conflict" is 409 ALREADY_CLAIMED (an invite holds the name).
      //   the site cannot be asked -> ROLLBACK; the retryable 503 that names nothing, and the person tries again.
      // Never "session minted but the site cannot be opened", and never "site bound but the claim rolled back and stuck".
      const wanted = { tripId, userId: result.target.userId, runtimeUsername: result.runtimeUsername };
      // An invite for this name that was revoked or expired without ever being redeemed may have left an invite-bound binding on the site
      // (a lost answer): the site replaces it only when told, here, under this transaction's trip lock, that its invite is dead.
      const deadInviteIds = await deadInviteIdsFor(client, tripId, result.runtimeUsername);
      let bound: "ok" | "refused" | "conflict" | "unavailable";
      try { bound = await deps.runtimeAccounts.adoptParticipant({ ...wanted, ...(deadInviteIds.length ? { deadInviteIds } : {}) }); } catch { bound = "unavailable"; }
      if (bound !== "ok") {
        await client.query("ROLLBACK");
        miniAppLog(structuredLog("info", "mini_app.group_claim", { outcome: `site_${bound}` }));
        if (bound === "unavailable") return reply.header("retry-after", "5").code(503).send({ error: "MEMBERSHIP_CHECK_UNAVAILABLE", retryable: true });
        if (bound === "conflict") return reply.code(409).send({ error: "ALREADY_CLAIMED" });
        return reply.code(404).send({ error: "NOT_FOUND" });
      }
      siteBound = wanted;
      await client.query("COMMIT");
      committed = true;
      // Logged AFTER the commit: a claim that failed to commit must never have said it was made.
      miniAppLog(structuredLog("info", "mini_app.group_claim", { outcome: "claimed" }));
      setWebSessionCookies(reply, deps, session, { embedded: embeddedRequest(body) });
      return { kind: "session", appPath: result.target.appPath };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (siteBound && !committed) await compensateSiteBinding(siteRelease, siteBound);
      // The one error a concurrent claim may legitimately raise past the locks: the unique index said "taken".
      if ((error as { code?: string } | null)?.code === "23505") return reply.code(409).send({ error: "ALREADY_CLAIMED" });
      // Anything else (a failed COMMIT included) is answered with a body that says nothing: the database's own message
      // can quote a constraint, a column or a value. The kind is logged; nothing is echoed.
      miniAppLog(structuredLog("error", "mini_app.group_claim", { outcome: "error", safe_error_code: (error as { code?: string } | null)?.code ?? "UNKNOWN" }));
      return reply.code(500).send({ error: "INTERNAL_ERROR" });
    } finally {
      client.release();
    }
  });

  // The organizers' side of a group claim. Both routes answer a member, a stranger and a trip that does not exist with
  // the same 404, and say nothing else. `GET` is `trip` scope (an organizer's own Mini App session may look); `DELETE`
  // is `account` scope like every route that takes access away from another person (portal-scope.ts).
  const organizerOf = async (tripId: string, userId: string): Promise<boolean> => {
    const member = await membership(deps, tripId, userId);
    return Boolean(member && ["owner", "organizer"].includes(member.role) && member.dashboard_access);
  };

  // The list and the release are ONE implementation with two doors: the portal routes below (an organizer's own portal session) and
  // the internal routes after them (the runtime gateway, for an organizer's TRIP-SITE session). Neither door decides who may ask
  // the way the other does; both call these once they have decided, so the SQL and its effects exist once.
  const listMemberClaims = async (tripId: string) => {
    const result = await deps.db.query<{
      id: string; via: string; created_at: Date; display_name: string;
      telegram_first_name: string | null; telegram_username: string | null; last_signed_in_at: Date | null;
    }>(
      `SELECT c.id, c.via, c.created_at, u.display_name, l.telegram_first_name, l.telegram_username, l.last_signed_in_at
         FROM control_plane.trip_participant_claims c
         JOIN control_plane.users u ON u.id = c.user_id
         LEFT JOIN control_plane.telegram_member_links l
                ON l.trip_id = c.trip_id AND l.user_id = c.user_id AND l.verified_via = $2 AND l.revoked_at IS NULL
        WHERE c.trip_id = $1 AND c.released_at IS NULL
        ORDER BY c.created_at, c.id`,
      [tripId, GROUP_VERIFIED_VIA],
    );
    return {
      claims: result.rows.map((row) => ({
        claimId: row.id, travellerName: row.display_name,
        telegramFirstName: row.telegram_first_name, telegramUsername: row.telegram_username,
        via: row.via, claimedAt: row.created_at.toISOString(), lastSignedInAt: row.last_signed_in_at ? row.last_signed_in_at.toISOString() : null,
      })),
    };
  };

  /** Ends the claim, revokes its link, ends the sessions it minted and frees the traveller (endGroupClaimInTx). False: no such live claim on this trip. */
  const releaseMemberClaim = async (tripId: string, claimId: string): Promise<boolean> => {
    if (!/^tpc_[A-Za-z0-9]{8,64}$/.test(claimId)) return false;
    const client = await deps.db.connect();
    try {
      await client.query("BEGIN");
      const claim = await client.query<{ user_id: string }>(
        "SELECT user_id FROM control_plane.trip_participant_claims WHERE id = $1 AND trip_id = $2 AND released_at IS NULL FOR UPDATE",
        [claimId, tripId]);
      if (!claim.rows[0]) { await client.query("ROLLBACK"); return false; }
      const ended = await endGroupClaimInTx(client, { tripId, userId: claim.rows[0].user_id, linkReason: "claim_released", claimReason: "organizer_released" });
      await client.query("COMMIT");
      await releaseSiteBindings(ended);
      miniAppLog(structuredLog("info", "mini_app.group_claim", { outcome: "released" }));
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  // GET /v1/trips/:id/member-claims  ->  200 { claims: [{ claimId, travellerName, telegramFirstName, telegramUsername,
  //                                                       via, claimedAt, lastSignedInAt }] } | 404 NOT_FOUND
  app.get("/v1/trips/:id/member-claims", async (request, reply) => {
    const user = await requireUser(request, reply, deps);
    if (!user) return;
    reply.header("cache-control", "private, no-store");
    const tripId = (request.params as { id?: string }).id ?? "";
    if (!(await organizerOf(tripId, user.id))) return reply.code(404).send({ error: "NOT_FOUND" });
    return listMemberClaims(tripId);
  });

  // DELETE /v1/trips/:id/member-claims/:claimId  ->  200 { status: "released" } | 404 NOT_FOUND
  app.delete("/v1/trips/:id/member-claims/:claimId", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    reply.header("cache-control", "private, no-store");
    const params = request.params as { id?: string; claimId?: string };
    const tripId = params.id ?? "";
    if (!(await organizerOf(tripId, user.id)) || !(await releaseMemberClaim(tripId, params.claimId ?? ""))) return reply.code(404).send({ error: "NOT_FOUND" });
    return { status: "released" };
  });

  // ── The same two operations for an organizer's TRIP-SITE session (the runtime gateway's hop) ─────────────────
  //
  //   POST /internal/member-claims/list     { tripId, userId, sessionId }            -> 200 { claims: [...] }
  //   POST /internal/member-claims/release  { tripId, userId, sessionId, claimId }   -> 200 { status: "released" }
  //
  // `trip-web` talks only to the trip site, and the trip site cannot call this service, so the runtime gateway (which holds the
  // person's sealed session: user, trip, portal session id) asks on the person's behalf, with the exchange key. The gateway is
  // trusted for WHO IT HEARD FROM (a sealed cookie it made), never for what that person may do: everything is decided again here,
  // from the database, on every call:
  //
  //   1. the key (401 AUTHENTICATION_REQUIRED, as every internal route);
  //   2. the portal session `sessionId` is that user's own, live, and the user is active;
  //   3. the user is owner or organizer of THIS trip with dashboard access (`organizerOf`, exactly the portal routes' rule);
  //   4. `member_group_sign_in` is on for the trip and the path is wired. Off or absent is the answer an unknown trip gets: the
  //      name of an unreleased feature is withheld, and no claim is shown that no longer grants anything (A4);
  //   5. the session's SCOPE, by the portal routes' own policy rows (portal-scope.ts, the one source): a session a Telegram link
  //      minted (an organizer in the Mini App) may list a trip in its scope (GET policy `trip`) but may NOT release (DELETE policy
  //      `account`, as for removing a member): answered 403 ACCOUNT_SIGN_IN_REQUIRED, and ONLY to a caller who passed 2-4, so it
  //      tells a stranger nothing. A scope that cannot be read is the empty scope.
  //
  // A member, a claimed member, a stranger, another trip's organizer, a dead or foreign session and an unknown trip are all one
  // byte-identical 404 (steps 2-4); nothing is written before step 5 passes.
  // The steps every one of the gateway's hops shares (1-3 above, and 5 when a policy row is named), in ONE place so the claims hop and
  // the personal-invite hop below cannot drift apart. `valid` is the route's own body shape; `gate` an extra condition that, when
  // false, answers as an unknown trip (the claims hop's feature switch: step 4); `routeKey` the portal route whose scope row applies
  // to a Telegram-minted session (none: the route has no scope of its own).
  const hopCaller = async (
    request: FastifyRequest, reply: FastifyReply,
    route: { valid: (body: Record<string, unknown>) => boolean; gate?: (tripId: string) => Promise<boolean>; routeKey?: string },
  ): Promise<{ tripId: string; body: Record<string, unknown> } | null> => {
    reply.header("cache-control", "no-store");
    if (!exchangeKeyMatches(request.headers["x-api-key"], deps.runtimeExchangeKey)) { await reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" }); return null; }
    const body = jsonBody(request);
    const { tripId, userId, sessionId } = body;
    if (typeof tripId !== "string" || !TRIP_ID_PATTERN.test(tripId) || typeof userId !== "string" || typeof sessionId !== "string" || !route.valid(body)) {
      await reply.code(400).send({ error: "INVALID_REQUEST" });
      return null;
    }
    const refused = async () => { await reply.code(404).send({ error: "NOT_FOUND" }); return null; };
    const session = await deps.db.query<{ telegram_link_id: string | null }>(
      `SELECT s.telegram_link_id FROM control_plane.web_sessions s
         JOIN control_plane.users u ON u.id = s.user_id AND u.status = 'active'
        WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [sessionId, userId]);
    if (!session.rows[0]) return refused();
    if (!(await organizerOf(tripId, userId))) return refused();
    if (route.gate && !(await route.gate(tripId))) return refused();
    const telegramLinkId = session.rows[0].telegram_link_id;
    if (telegramLinkId !== null && route.routeKey) {
      const decision = await scopeDecision(deps.db, { routeKey: route.routeKey, params: { id: tripId }, scope: await readSessionScope(deps, userId, telegramLinkId) });
      if (!decision.allow) {
        await reply.code(decision.status).send(decision.body);
        return null;
      }
    }
    return { tripId, body };
  };

  const claimsActor = async (request: FastifyRequest, reply: FastifyReply, kind: "list" | "release"): Promise<{ tripId: string; claimId: string } | null> => {
    const actor = await hopCaller(request, reply, {
      valid: (body) => kind !== "release" || typeof body.claimId === "string",
      gate: async (tripId) => Boolean(groupSignIn) && (await featureEnabled(deps.db, tripId, "member_group_sign_in", miniAppLog)),
      routeKey: kind === "list" ? "GET /v1/trips/:id/member-claims" : "DELETE /v1/trips/:id/member-claims/:claimId",
    });
    if (!actor) return null;
    return { tripId: actor.tripId, claimId: typeof actor.body.claimId === "string" ? actor.body.claimId : "" };
  };

  app.post("/internal/member-claims/list", async (request, reply) => {
    const actor = await claimsActor(request, reply, "list");
    if (!actor) return;
    return listMemberClaims(actor.tripId);
  });

  app.post("/internal/member-claims/release", async (request, reply) => {
    const actor = await claimsActor(request, reply, "release");
    if (!actor) return;
    if (!(await releaseMemberClaim(actor.tripId, actor.claimId))) return reply.code(404).send({ error: "NOT_FOUND" });
    return { status: "released" };
  });

  // ── "Send a personal invite" for an organizer's TRIP-SITE session (the runtime gateway's hop; S2, AC-11) ─────────
  //
  //   POST /internal/member-invites/available  { tripId, userId, sessionId }                   -> 200 { available: true }
  //   POST /internal/member-invites/create     { tripId, userId, sessionId, runtimeUsername }  -> 201 { id, joinUrl, displayName, expiresAt }
  //                                                                                              | 409 { error: <one of createSiteInvite's named answers> }
  //
  // The same hop as the claims one, decided by the same `hopCaller` (key, a live session that is that user's, owner/organizer of THIS
  // trip with dashboard access: one byte-identical 404 for everyone else), with two differences that are on purpose:
  //   - NO feature switch. A personal invite is a full way in for people who are not on Telegram (spec D1); it must work with
  //     `member_group_sign_in` off and with group sign-in not wired. What gates the button is the gateway being in front of the
  //     site and the caller being this trip's organizer, nothing else.
  //   - the scope row is the portal route's own, `POST /v1/trips/:id/site-invites` (`account`): a session a Telegram link minted (an
  //     organizer in the Mini App) is told 403 ACCOUNT_SIGN_IN_REQUIRED, exactly as the portal route tells it, and only after the
  //     caller has passed the organizer check. The probe (`available`) applies no scope: the button is drawn and the click says why not.
  // The create is `createSiteInvite`, the function the portal route and the companion's tool call too; only the traveller's username
  // comes from the browser (through the gateway). The name on the invite is the trip site's own for that participant, never the caller's.
  // "Send it again" replaces a pending invite (`replacePending`): the organizer cannot recover a link that is stored only as a digest.
  app.post("/internal/member-invites/available", async (request, reply) => {
    const actor = await hopCaller(request, reply, { valid: () => true });
    if (!actor) return;
    return { available: true };
  });

  app.post("/internal/member-invites/create", async (request, reply) => {
    const actor = await hopCaller(request, reply, {
      valid: (body) => typeof body.runtimeUsername === "string" && /^[a-z0-9][a-z0-9._-]{1,63}$/.test(body.runtimeUsername),
      routeKey: "POST /v1/trips/:id/site-invites",
    });
    if (!actor) return;
    const made = await createSiteInvite(deps, { tripId: actor.tripId, actorUserId: actor.body.userId as string, runtimeUsername: actor.body.runtimeUsername as string, replacePending: true });
    if (!made.ok) return reply.code(made.status).send({ error: made.error });
    miniAppLog(structuredLog("info", "member_invite.created", {}));
    return reply.code(201).send({ id: made.id, joinUrl: made.joinUrl, displayName: made.displayName, expiresAt: made.expiresAt });
  });

  // Ends one Telegram link — one TRIP's link — of the signed-in user's own, with
  // the sessions it opened. The trip card (GET /v1/trips) says which links exist;
  // this is the ⋮ menu's Unlink. Any signed-in user, member or organizer.
  app.delete("/v1/account/telegram-links/:linkId", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    reply.header("cache-control", "private, no-store");
    const linkId = (request.params as { linkId?: string }).linkId ?? "";
    const released: ReleasedClaim[] = [];
    if (!(await unlinkTelegramLink(deps.db, user.id, linkId, released))) return reply.code(404).send({ error: "NOT_FOUND" });
    await releaseSiteBindings(released);
    return { status: "unlinked" };
  });

  // The trip card's "Restore": brings back a Telegram account the signed-in owner or organizer Unlinked,
  // with no Telegram round trip (telegram-link-token.ts, restoreTelegramLink). Policy "account": a session a
  // Telegram link minted gets 403 before this handler runs, because restoring is minting a way in. Origin and
  // CSRF as for every mutation. Refused alike (404) for a link that is not theirs, does not exist, is not an
  // owner Unlink, is already back, or is on a trip they do not run.
  const restoreAttempts: Attempts = new Map();
  app.post("/v1/account/telegram-links/:linkId/restore", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    reply.header("cache-control", "private, no-store");
    if (!admitLogin(restoreAttempts, user.id, 20)) {
      return reply.header("retry-after", "60").code(429).send({ error: "RATE_LIMITED" });
    }
    const linkId = (request.params as { linkId?: string }).linkId ?? "";
    const restored = await restoreTelegramLink(deps.db, { userId: user.id, linkId });
    if (!restored.ok) return reply.code(404).send({ error: "NOT_FOUND" });
    return { status: "restored" };
  });

  // ── Sign in with Google (Google Identity Services, ID-token flow) ──
  //
  //   GET  /v1/auth/google/nonce                                   200 { nonce } + the kit_gnonce cookie (see SINGLE USE below)
  //   POST /v1/auth/google  { credential, returnTo?, embedded? }  200 { appPath } + session cookies
  //                         | 401 GOOGLE_SIGN_IN_FAILED | 401 GOOGLE_USE_EMAIL_SIGN_UP | 403 ORIGIN_INVALID | 429 SIGN_IN_RATE_LIMITED | 503 GOOGLE_SIGN_IN_UNAVAILABLE
  //
  // Sign-up and sign-in in one. Policy `open` (portal-scope.ts): it never reads the session cookie. `credential`
  // is the signed ID token the page's Google button yields. Origin must be ours (a page on another site must not be
  // able to post a token it holds and sign the visitor in: login CSRF), the IP is rate-limited BEFORE the token is
  // looked at, and the answer is `no-store`. EVERY failure to establish who Google says this is, whatever the cause
  // (garbage, bad signature, wrong audience or issuer, expired, no verified address, a suspended account), is the
  // same 401 GOOGLE_SIGN_IN_FAILED, so the route tells a caller nothing about which part was wrong. The cause goes to
  // the log as a reason CODE only: never the token, never the address.
  //
  // SINGLE USE, AND BOUND TO THE BROWSER THAT ASKED. A signed ID token is a bearer credential that stays valid for
  // about an hour, and it is readable (it is a JWT), so one that leaks (a log, a proxy, a screenshot) could be posted
  // by anyone. So the page first calls GET /v1/auth/google/nonce: the server makes a secret `<issued-at>.<random>`,
  // sets it in a short-lived HttpOnly cookie scoped to /v1/auth/google, and returns only its SHA-256 as the `nonce`
  // the page hands Google. Google puts that nonce in the token. The POST accepts the token only if
  //   1. SHA-256(cookie) equals the token's nonce (a leaked token shows the hash, not the secret, and an attacker
  //      cannot forge the cookie from the token), and
  //   2. the issue time inside the cookie is at most 5 minutes old (it is covered by that hash, so it cannot be
  //      edited without invalidating the token: no HMAC key or server-side record of issued nonces is needed), and
  //   3. the nonce is not yet in control_plane.google_signin_nonces. It is SPENT there, inside the sign-in
  //      transaction, by INSERT ... ON CONFLICT DO NOTHING; no row inserted means a replay (NONCE_REPLAYED), so a
  //      captured token+cookie pair works once, even from the browser that holds the cookie. Clearing the cookie is
  //      only a courtesy; it is not what makes the nonce single-use.
  // A refusal that proves nothing about the cookie (bad token, mismatched nonce, a foreign Origin) leaves the cookie
  // alone, so another tab's attempt in the same browser is not broken by it; only a request whose nonce matched the
  // cookie clears it. Rows are kept until 10 minutes after issue, longer than the 5 minutes they could be accepted
  // for, and the next sign-in deletes the expired ones. A failed sign-in transaction rolls the spend back.
  const googleIpAttempts: Attempts = new Map();
  const googleNonceIpAttempts: Attempts = new Map();
  const nonceCookie = (value: string, maxAge: number) =>
    cookie(GOOGLE_NONCE_COOKIE, value, { maxAge, secure: deps.publicOrigin.startsWith("https://"), path: GOOGLE_NONCE_PATH });
  app.get("/v1/auth/google/nonce", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    if (!deps.google) return reply.code(503).send({ error: "GOOGLE_SIGN_IN_UNAVAILABLE" });
    if (!admitLogin(googleNonceIpAttempts, request.ip, 60)) {
      return reply.header("retry-after", "60").code(429).send({ error: "SIGN_IN_RATE_LIMITED" });
    }
    const secret = `${Math.floor(Date.now() / 1000)}.${base64url(32)}`;
    reply.header("set-cookie", nonceCookie(secret, GOOGLE_NONCE_MAX_AGE_SECONDS));
    return { nonce: googleNonceFor(secret) };
  });
  app.post("/v1/auth/google", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    if (!deps.google) return reply.code(503).send({ error: "GOOGLE_SIGN_IN_UNAVAILABLE" });
    if (!admitLogin(googleIpAttempts, request.ip, 30)) {
      return reply.header("retry-after", "60").code(429).send({ error: "SIGN_IN_RATE_LIMITED" });
    }
    if (!originIsOurs(request, deps)) return reply.code(403).send({ error: "ORIGIN_INVALID" });
    const nonceSecret = parseCookies(request.headers.cookie)[GOOGLE_NONCE_COOKIE];
    // Cleared only once the token's nonce is proven to be this cookie's (see SINGLE USE): a refusal before that says
    // nothing about this cookie, and it may belong to another tab's attempt.
    const clearNonceCookie = () => { reply.header("set-cookie", nonceCookie("", 0)); };
    const body = jsonBody(request);
    const refuse = async (reason: GoogleRefusal | "ACCOUNT_INACTIVE") => {
      if (reason === "EMAIL_NOT_GOOGLE_AUTHORITATIVE") {
        // A valid, correctly bound token for an address Google does not run: point at the email sign-up. Nothing is
        // written (no funnel row either), and it is the same answer whether or not the address has an account.
        emailAuthLog(structuredLog("warn", "google_sign_in.refused", { reason }));
        return reply.code(401).send({ error: "GOOGLE_USE_EMAIL_SIGN_UP" });
      }
      emailAuthLog(structuredLog("warn", "google_sign_in.refused", { reason }));
      await recordFunnelEvent(deps.db, "google_auth", { outcome: "failure" }).catch(() => {});
      return reply.code(401).send({ error: "GOOGLE_SIGN_IN_FAILED" });
    };
    if (typeof body.credential !== "string" || body.credential.length === 0 || body.credential.length > 8192) return refuse("CREDENTIAL_MISSING");
    let identity: GoogleIdentity;
    try {
      identity = await deps.google.verify(body.credential);
    } catch (error) {
      return refuse(error instanceof GoogleSignInRefused ? error.reason : "VERIFY_FAILED");
    }
    if (!identity.email || !identity.emailVerified) return refuse("EMAIL_UNVERIFIED");
    if (!isPlainAddrSpec(identity.email)) return refuse("EMAIL_MALFORMED");
    if (!nonceSecret) return refuse("NONCE_MISSING");
    const issued = GOOGLE_NONCE_SECRET.exec(nonceSecret);
    if (!issued || !identity.nonce || !safeEqual(googleNonceFor(nonceSecret), identity.nonce)) return refuse("NONCE_MISMATCH");
    // From here the token is bound to this cookie, and the cookie is of no further use whatever the outcome.
    clearNonceCookie();
    const issuedAt = Number(issued[1]);
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (nowSeconds - issuedAt > GOOGLE_NONCE_MAX_AGE_SECONDS || issuedAt - nowSeconds > GOOGLE_NONCE_CLOCK_SKEW_SECONDS) return refuse("NONCE_EXPIRED");
    // Last of the token checks, so that only a token that is genuine AND bound to this browser can learn this answer;
    // and before any lookup, so it cannot depend on whether the address already has an account.
    if (!googleIsAuthoritativeFor(identity.email, identity.hd)) return refuse("EMAIL_NOT_GOOGLE_AUTHORITATIVE");
    const email = canonicalGoogleEmail(identity.email);
    const subjectDigest = sha256(`google:${identity.subject}`);
    const client = await deps.db.connect();
    try {
      await client.query("BEGIN");
      // Spend the nonce. Expired rows go first (opportunistic purge: no job), then the insert; no row back is a replay.
      await client.query("DELETE FROM control_plane.google_signin_nonces WHERE expires_at < now()");
      const spent = await client.query(
        `INSERT INTO control_plane.google_signin_nonces(nonce_digest, expires_at)
         VALUES ($1, to_timestamp($2)) ON CONFLICT (nonce_digest) DO NOTHING RETURNING 1`,
        [identity.nonce, issuedAt + 2 * GOOGLE_NONCE_MAX_AGE_SECONDS]);
      if (!spent.rows[0]) { await client.query("ROLLBACK"); return await refuse("NONCE_REPLAYED"); }
      const known = await client.query<{ user_id: string }>(
        "SELECT user_id FROM control_plane.user_identities WHERE provider = 'google' AND provider_subject_digest = $1", [subjectDigest]);
      let userId = known.rows[0]?.user_id;
      if (!userId) {
        // First sign-in with this Google account. Its address is verified, so it names the canonical account for
        // that address (one address, one user_id: password-identity.ts), creating it if there is none: a new
        // address is a new organizer account (sign-up auto-approves), an existing one (password, invitation,
        // email sign-up) is the same person arriving by another door and gets the Google identity attached.
        userId = await resolveOrCreateEmailAccount(client, email, identity.displayName);
        // A credential nobody knows, so the account cannot be claimed by typing its address into POST /v1/signup;
        // it never overwrites an existing one. Google or password recovery (portal-email-auth.ts) is the way in.
        await ensureUnknownPasswordCredential(client, userId, email);
        const attached = await client.query<{ user_id: string }>(
          `INSERT INTO control_plane.user_identities(id, user_id, provider, provider_subject_digest, verified_at)
           VALUES ($1, $2, 'google', $3, now())
           ON CONFLICT (provider, provider_subject_digest) DO NOTHING
           RETURNING user_id`,
          [opaque("idnt"), userId, subjectDigest]);
        if (!attached.rows[0]) {
          // A concurrent first sign-in with the same Google account won: its row stands, and so is ours.
          const winner = await client.query<{ user_id: string }>(
            "SELECT user_id FROM control_plane.user_identities WHERE provider = 'google' AND provider_subject_digest = $1", [subjectDigest]);
          userId = winner.rows[0]?.user_id ?? userId;
        }
      }
      const active = await client.query("SELECT 1 FROM control_plane.users WHERE id = $1 AND status = 'active' FOR SHARE", [userId]);
      if (!active.rows[0]) { await client.query("ROLLBACK"); return await refuse("ACCOUNT_INACTIVE"); }
      // The name Google vouches for, signed in the token we just verified, is the name this person gave the product
      // (#438) -- stored for the account the token resolved to, and only while that account has none of its own.
      // Whatever else the request carries is not read: the body is never the source of a name.
      if (identity.givenName) await recordGivenName(client, userId, identity.givenName);
      const session = await createWebSession(client, userId, deps.sessionTtlSeconds);
      await recordFunnelEvent(client, "google_auth", { outcome: "success", userId });
      await client.query("COMMIT");
      setWebSessionCookies(reply, deps, session, { embedded: embeddedRequest(body) });
      return { appPath: validatedReturnTo(body.returnTo) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      // A database fault is not "Google said no": it stays a 500 (and the log line has the code, not the cause's text).
      emailAuthLog(structuredLog("error", "google_sign_in.failed", { safe_error_code: error instanceof Error ? error.name : "UNKNOWN" }));
      throw error;
    } finally {
      client.release();
    }
  });

  app.post("/v1/auth/password", async (request, reply) => {
    // Per-IP before anything is read or hashed: scrypt is the expensive step.
    if (!admitLogin(passwordIpAttempts, request.ip, 100)) {
      return reply.header("retry-after", "60").code(429).send({ error: "SIGN_IN_RATE_LIMITED" });
    }
    // Same-origin form posts only. This route used to accept a request from any
    // origin (and none): a page on another site could drive the victim's browser
    // into a chosen account, which is login CSRF. Missing and "null" are refused.
    if (!originIsOurs(request, deps)) return reply.code(403).send({ error: "ORIGIN_INVALID" });
    const body = (request.body && typeof request.body === "object" ? request.body : {}) as Record<string, unknown>;
    const tripId = typeof body.tripId === "string" ? body.tripId : "";
    const runtimeUsername = typeof body.runtimeUsername === "string" ? body.runtimeUsername.toLowerCase().trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!/^trip_[A-Za-z0-9]{8,64}$/.test(tripId) || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(runtimeUsername) || password.length < 8 || password.length > 128) {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }
    const result = await deps.db.query<{ user_id: string; password_hash: string }>(
      `SELECT c.user_id, c.password_hash
       FROM control_plane.web_password_credentials c
       JOIN control_plane.users u ON u.id = c.user_id AND u.status = 'active'
       WHERE c.trip_id = $1 AND c.runtime_username = $2`,
      [tripId, runtimeUsername],
    );
    const credential = result.rows[0];
    // Per account, and only for an account that EXISTS: keyed on the request's
    // own (trip, username) before this lookup, any caller could fill the map
    // with invented pairs and 429 every real member.
    if (credential && !admitLogin(passwordAccountAttempts, sha256(`${tripId}:${runtimeUsername}`), 10)) {
      return reply.header("retry-after", "60").code(429).send({ error: "SIGN_IN_RATE_LIMITED" });
    }
    if (!credential || !(await verifyPortalPassword(password, credential.password_hash))) {
      return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
    }
    const linkRequest = telegramLinkRequest(body);
    const client = await deps.db.connect();
    try {
      await client.query("BEGIN");
      const session = await createWebSession(client, credential.user_id, deps.sessionTtlSeconds);
      // "Next time, open with Telegram": the credential just verified, fresh
      // verified initData and an explicit consent flag all arrive in THIS
      // request, or nothing is linked. A skip never fails the sign-in.
      let telegramLink: "linked" | "skipped" | undefined;
      if (linkRequest) {
        telegramLink = "skipped";
        const cfg = deps.telegramMiniApp;
        const verified = cfg?.enabled() ? verifyMiniAppInitData(linkRequest.initData, cfg.botToken, { maxAgeSeconds: cfg.maxAgeSeconds }) : null;
        if (cfg && verified?.ok && admitLogin(miniAppUserAttempts, sha256(`miniapp:${verified.data.telegramUserId}`), 20)) {
          const name = await client.query<{ display_name: string }>("SELECT display_name FROM control_plane.users WHERE id = $1", [credential.user_id]);
          telegramLink = await linkMemberOrSkip(client, {
            launch: verified.data, maxAgeSeconds: cfg.maxAgeSeconds, userId: credential.user_id, tripId,
            accountName: name.rows[0]?.display_name ?? "your account", via: "mini_app_trip_password",
          }, miniAppLog);
        }
      }
      await client.query("COMMIT");
      setWebSessionCookies(reply, deps, session, { embedded: embeddedRequest(body) });
      const appPath = typeof body.returnTo === "string" ? validatedReturnTo(body.returnTo) : `/trips/${tripId}/app`;
      return { appPath, ...(telegramLink ? { telegramLink } : {}) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  });

  app.get("/v1/me", async (request, reply) => {
    const user = await requireUser(request, reply, deps);
    if (!user) return;
    // `scope: "telegram"` tells the page this session sees only the trips its Telegram account is linked to.
    // `needsName`: the dashboard should ask, once, what to call this person -- the interview greets the organizer by
    // it (#438). Present only when true, so the answer for everyone else keeps the shape it always had. Never for a
    // Telegram-scoped session: it cannot change the account (`POST /v1/account/name` is account-level), so asking
    // would offer something that is then refused.
    const needsName = !user.scope && user.givenName === null && !user.givenNameAsked;
    return {
      id: user.id, displayName: user.displayName, scope: user.scope ? "telegram" : "full",
      ...(needsName ? { needsName: true } : {}),
    };
  });

  // The name an organizer gives the product, for the interview to greet them by (#438, AC-11).
  //   POST /v1/account/name  { displayName }   200 { ok: true }   stores it on the CALLER's own account
  //   POST /v1/account/name  { dismiss: true } 200 { ok: true }   "not now": the dashboard does not ask again
  // Exactly those two shapes: any other field is refused rather than ignored, so nothing is accepted by accident.
  // The account is the session's, never a body field; the name is cleaned like every name (cleanDisplayName). Full
  // sessions only (portal-scope.ts "account"): a Telegram-minted session cannot rename the account it borrowed.
  app.post("/v1/account/name", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    const body = jsonBody(request);
    const keys = Object.keys(body);
    const naming = keys.length === 1 && keys[0] === "displayName";
    const dismissing = keys.length === 1 && keys[0] === "dismiss" && body.dismiss === true;
    if (!naming && !dismissing) return reply.code(400).send({ error: "INVALID_REQUEST" });
    if (dismissing) {
      await deps.db.query("UPDATE control_plane.users SET given_name_asked_at = COALESCE(given_name_asked_at, now()) WHERE id = $1", [user.id]);
      return { ok: true };
    }
    const name = cleanDisplayName(body.displayName);
    if (name === null) return reply.code(400).send({ error: "INVALID_NAME" });
    await deps.db.query("UPDATE control_plane.users SET given_name = $2, given_name_asked_at = now() WHERE id = $1", [user.id, name]);
    return { ok: true };
  });

  app.post("/v1/logout", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    const raw = parseCookies(request.headers.cookie).kit_session;
    await deps.db.query("UPDATE control_plane.web_sessions SET revoked_at = now() WHERE token_digest = ANY($1::text[])", [sessionDigests(raw ?? "")]);
    clearWebSessionCookies(reply, deps);
    return { ok: true };
  });

  app.get("/v1/trips", async (request, reply) => {
    const user = await requireUser(request, reply, deps);
    if (!user) return;
    const rows = await deps.db.query<{ id: string; dashboard_access: boolean }>(
      // A member's trips are the ones they can open (runtime access), the same
      // list the Mini App shows; an organizer's also include the trips they run.
      // A Telegram-minted session sees only the trips its Telegram account is
      // linked to (portal-scope.ts): the filter is in the query, not after it.
      `SELECT trip_id AS id, dashboard_access FROM control_plane.trip_memberships
        WHERE user_id = $1 AND status = 'active' AND (dashboard_access = true OR runtime_access = true)
          AND ($2::text[] IS NULL OR trip_id = ANY($2::text[]))
        ORDER BY created_at DESC`,
      [user.id, user.scope ? [...user.scope.tripIds] : null]);
    // Full detail only where the caller runs the trip; a runtime-only member gets the summary.
    return { trips: (await Promise.all(rows.rows.map((row) => row.dashboard_access ? tripDetail(deps, row.id, user.id, linkView(user)) : memberTripSummary(deps, row.id, user.id, linkView(user).labels)))).filter(Boolean) };
  });

  app.post("/v1/trips", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    const body = request.body as Record<string, unknown>;
    const destination = typeof body.destination === "string" ? body.destination.trim() : "";
    const tripType = typeof body.tripType === "string" ? body.tripType : "family";
    const startDate = typeof body.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.startDate) ? body.startDate : null;
    const endDate = typeof body.endDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.endDate) ? body.endDate : null;
    if (!destination || destination.length > 160 || !["family", "group", "couple", "other"].includes(tripType) || (startDate && endDate && endDate < startDate)) {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }
    const tripId = opaque("trip");
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 120) : `${destination} trip`;
    const draftInputs = { destination, trip_type: tripType, ...(startDate ? { departure_date: startDate } : {}), ...(endDate ? { return_date: endDate } : {}) };
    const client = await deps.db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO control_plane.trips(id, slug, lifecycle_state, title, destination_label, start_date, end_date, trip_type, draft_inputs)
         VALUES ($1, $2, 'draft', $3, $4, $5, $6, $7, $8::jsonb)`,
        [tripId, `draft-${tripId.replace(/_/g, "-")}`, title, destination, startDate, endDate, tripType, JSON.stringify(draftInputs)],
      );
      await client.query(
        `INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status, dashboard_access, runtime_access)
         VALUES ($1, $2, $3, 'owner', 'active', true, true)`, [opaque("memb"), tripId, user.id]);
      await recordFunnelEvent(client, "draft_created", { userId: user.id, tripId });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return reply.code(201).send(await tripDetail(deps, tripId, user.id, linkView(user)));
  });

  app.get("/v1/trips/:id", async (request, reply) => {
    const user = await requireUser(request, reply, deps);
    if (!user) return;
    const tripId = (request.params as { id?: string }).id;
    if (!tripId) return reply.code(400).send({ error: "INVALID_REQUEST" });
    const detail = await tripDetail(deps, tripId, user.id, linkView(user));
    if (!detail || !detail.permissions.dashboard) return reply.code(404).send({ error: "NOT_FOUND" });
    return detail;
  });

  app.post("/v1/trips/:id/interview-link", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    const tripId = (request.params as { id?: string }).id ?? "";
    const member = await membership(deps, tripId, user.id);
    if (!member || member.role !== "owner" || !member.dashboard_access) return reply.code(404).send({ error: "NOT_FOUND" });
    const result = await issueEnrollment(deps.db, user.id, tripId, { enrollmentTtlSeconds: deps.enrollmentTtlSeconds });
    if (!result.ok) return reply.code(409).send({ error: result.reason });
    await recordFunnelEvent(deps.db, "interview_launched", { userId: user.id, tripId });
    return reply.code(201).send({
      enrollmentId: result.enrollmentId,
      deepLink: `https://t.me/${deps.telegramBotUsername}?start=${encodeURIComponent(result.token)}`,
      expiresAt: result.expiresAt.toISOString(),
    });
  });

  // The trip card's "Link Telegram": a one-time, short-lived deep link that links
  // WHICHEVER Telegram account opens it to the signed-in organizer, for this trip
  // only. The session and CSRF token prove the account; the bot's verified update
  // proves the Telegram identity (telegram-link-token.ts). This is the way back for an account the
  // organizer never linked; the one they Unlinked comes back with Restore (below), and an interview
  // link, which may have been forwarded, does not undo an Unlink.
  const linkTokenAttempts: Attempts = new Map();
  app.post("/v1/trips/:id/telegram-link", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    reply.header("cache-control", "private, no-store");
    // A person asks a handful of times, not hundreds; the cap bounds the churn
    // of revoked rows and the memory the limiter holds.
    if (!admitLogin(linkTokenAttempts, user.id, 10)) {
      return reply.header("retry-after", "60").code(429).send({ error: "RATE_LIMITED" });
    }
    const tripId = (request.params as { id?: string }).id ?? "";
    const issued = await issueTelegramLinkToken(deps.db, { userId: user.id, tripId, ttlSeconds: deps.telegramLinkTtlSeconds });
    // Not a trip they run, not a trip at all, retired: one answer.
    if (!issued.ok) return reply.code(404).send({ error: "NOT_FOUND" });
    return reply.code(201).send({
      deepLink: `https://t.me/${deps.telegramBotUsername}?start=${encodeURIComponent(issued.token)}`,
      expiresAt: issued.expiresAt.toISOString(),
    });
  });

  // A TRIP LINK for a secondary organizer (#523): the trip's MAIN organizer (its owner, with dashboard access) hands it to
  // somebody, who then organizes THIS trip from Telegram and gets its organizer view on the trip site. It MINTS a way into the
  // trip, so a Telegram-minted (scoped) session may not ask for one - policy "account", a password or Google sign-in only - and a
  // secondary organizer has no dashboard session at all. Not the owner, not a trip at all, retired: one 404.
  const secondaryLinkAttempts: Attempts = new Map();
  app.post("/v1/trips/:id/secondary-organizer-link", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    reply.header("cache-control", "private, no-store");
    if (!admitLogin(secondaryLinkAttempts, user.id, 10)) {
      return reply.header("retry-after", "60").code(429).send({ error: "RATE_LIMITED" });
    }
    const tripId = (request.params as { id?: string }).id ?? "";
    const issued = await issueSecondaryOrganizerToken(deps.db, { userId: user.id, tripId, ttlSeconds: deps.telegramLinkTtlSeconds });
    if (!issued.ok) return reply.code(404).send({ error: "NOT_FOUND" });
    return reply.code(201).send({
      deepLink: `https://t.me/${deps.telegramBotUsername}?start=${encodeURIComponent(issued.token)}`,
      expiresAt: issued.expiresAt.toISOString(),
    });
  });

  // The main organizer removes a secondary organizer. Effective at once (secondary-organizers.ts `removeSecondaryOrganizer`).
  app.delete("/v1/trips/:id/secondary-organizers/:secondaryId", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    const params = request.params as { id?: string; secondaryId?: string };
    const removed = await removeSecondaryOrganizer(deps.db, { actorUserId: user.id, tripId: params.id ?? "", secondaryId: params.secondaryId ?? "" });
    if (!removed.ok) return reply.code(404).send({ error: "NOT_FOUND" });
    return { status: "removed" };
  });

  // Safe recovery metadata only: the original plaintext enrollment is never
  // persisted, reconstructed, or returned here.
  app.get("/v1/trips/:id/interview-link", async (request, reply) => {
    const user = await requireUser(request, reply, deps); if (!user) return;
    const tripId = (request.params as { id?: string }).id ?? "";
    // A LIVE interview is one the organizer can still answer in: a confirmed one, or one that has not
    // expired. An unconfirmed session whose `expired_at` is set is closed -- the bot tells whoever writes
    // to it so -- and counting it made the page offer "Continue in Telegram" to a chat that had stopped
    // listening (#513). That is the very fact `replaceEnrollment` refuses on (a live or confirmed session
    // is INTERVIEW_ALREADY_STARTED; a closed one is a paused interview it will replace the link for), so
    // `has_interview` alone decides `recoverable`: the page must never be offered a replacement the route
    // would then refuse. `paused` lets an `intake_in_progress` trip be replaceable, as the route allows.
    const result = await deps.db.query<{ lifecycle_state: string; id: string | null; expires_at: Date | null; has_interview: boolean; paused: boolean }>(
      `SELECT t.lifecycle_state,e.id,e.expires_at,
         EXISTS(SELECT 1 FROM control_plane.intake_sessions s WHERE s.trip_id=t.id
                  AND (s.state='confirmed' OR s.expired_at IS NULL)) AS has_interview,
         (${pausedInterviewSessionSql("t.id")} IS NOT NULL) AS paused
       FROM control_plane.trips t
       JOIN control_plane.trip_memberships m ON m.trip_id=t.id
       LEFT JOIN control_plane.interview_enrollments e ON e.trip_id=t.id AND e.state='issued' AND e.expires_at>now()
       WHERE t.id=$1 AND m.user_id=$2 AND m.status='active' AND m.role='owner' AND m.dashboard_access=true`, [tripId,user.id]);
    const row = result.rows[0]; if (!row) return reply.code(404).send({ error: "NOT_FOUND" });
    return reply.header("cache-control", "private, no-store").send({
      activeEnrollment: row.id ? { id: row.id, expiresAt: row.expires_at!.toISOString() } : null,
      recoverable: Boolean(row.id) && !row.has_interview && (row.lifecycle_state === "draft" || (row.lifecycle_state === "intake_in_progress" && row.paused)),
      hasInterview: row.has_interview,
      telegramChatUrl: `https://t.me/${deps.telegramBotUsername}`,
    });
  });

  app.post("/v1/trips/:id/interview-link/replace", async (request, reply) => {
    const user = await requireMutation(request, reply, deps); if (!user) return;
    const tripId = (request.params as { id?: string }).id ?? "";
    const expectedEnrollmentId = (request.body as { expectedEnrollmentId?: unknown } | null)?.expectedEnrollmentId;
    if (typeof expectedEnrollmentId !== "string" || !/^enrl_[A-Za-z0-9]{8,64}$/.test(expectedEnrollmentId)) {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }
    const result = await replaceEnrollment(deps.db, user.id, tripId, expectedEnrollmentId, { enrollmentTtlSeconds: deps.enrollmentTtlSeconds });
    if (!result.ok) return reply.code(result.reason === "NOT_OWNER" ? 404 : 409).send({ error: result.reason === "NOT_OWNER" ? "NOT_FOUND" : result.reason });
    return reply.header("cache-control", "private, no-store").code(201).send({
      enrollmentId: result.enrollmentId,
      deepLink: `https://t.me/${deps.telegramBotUsername}?start=${encodeURIComponent(result.token)}`,
      expiresAt: result.expiresAt.toISOString(),
    });
  });

  app.post("/v1/trips/:id/provisioning-request", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    const tripId = (request.params as { id?: string }).id ?? "";
    const member = await membership(deps, tripId, user.id);
    if (!member || member.role !== "owner" || !member.dashboard_access) return reply.code(404).send({ error: "NOT_FOUND" });
    const generated = await generatePlan(deps.db, tripId, opaque("corr", 12));
    if (!generated.ok) {
      const status = generated.reason === "NO_COMPATIBLE_RELEASE" || generated.reason === "ORGANIZER_NOT_ON_ROSTER" ? 422 : 409;
      return reply.code(status).send({ error: generated.reason });
    }
    await recordFunnelEvent(deps.db, "provisioning_requested", { userId: user.id, tripId });
    return reply.code(201).send({ planId: generated.planId, digest: generated.planDigest, planStatus: "pending_approval" });
  });

  // "Try again" on a build that failed for good (the worker used up its attempts: `jobs.state = 'failed'`).
  // The main organizer only - role 'owner' with dashboard access, as for provisioning-request; a secondary organizer
  // (#523) holds a runtime-only 'organizer' membership and a member holds neither, so both are refused.
  //
  // One tap re-runs the build WITHOUT the review step. Reusing `retryProvision` (the same mechanism as
  // POST /v1/trips/:id/plan/retry and the admin dashboard's Retry) builds a plan from the same confirmed intake, and
  // the tap itself is the approval: the organizer already approved this build once and nothing about it has changed
  // except that it failed, so a second review would only be a second tap for the same decision. If the approval step
  // somehow fails the new plan is left `pending_approval`, which is the ordinary PlanReview state: recoverable.
  app.post("/v1/trips/:id/provisioning-retry", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    const tripId = (request.params as { id?: string }).id ?? "";
    const member = await membership(deps, tripId, user.id);
    if (!member) return reply.code(404).send({ error: "NOT_FOUND" });
    if (member.role !== "owner" || !member.dashboard_access) return reply.code(403).send({ error: "NOT_OWNER" });
    // Only a build that has finished failing. The same "latest plan" row `tripDetail` shows the page, so what the
    // button offers is what the route accepts. A queued, running or pending one is 409: never a second build.
    // A suspended trip's jobs are not claimed until an admin resumes it, so a retry would sit approved and unseen
    // and then run unannounced on resume: refused here, and the page does not offer it. (A retired trip is refused
    // by `retryProvision` itself under its trips lock: TRIP_RETIRED.)
    const tripState = await deps.db.query<{ suspended: boolean }>("SELECT suspended_at IS NOT NULL AS suspended FROM control_plane.trips WHERE id = $1", [tripId]);
    if (tripState.rows[0]?.suspended) return reply.code(409).send({ error: "TRIP_SUSPENDED" });
    const latest = await deps.db.query<{ job_state: string | null }>(
      `SELECT j.state AS job_state FROM control_plane.plans p
       LEFT JOIN control_plane.jobs j ON j.plan_id = p.id
       WHERE p.trip_id = $1 ORDER BY p.created_at DESC LIMIT 1`, [tripId]);
    if (latest.rows[0]?.job_state !== "failed") return reply.code(409).send({ error: "NOT_FAILED" });
    const retried = await retryProvision(deps.db, tripId, opaque("corr", 12));
    if (!retried.ok) {
      const status = retried.reason === "TRIP_NOT_FOUND" ? 404
        : retried.reason === "NO_COMPATIBLE_RELEASE" || retried.reason === "ORGANIZER_NOT_ON_ROSTER" ? 422
        : 409;
      return reply.code(status).send({ error: retried.reason });
    }
    const approval = await issueApproval(deps.db, retried.planId, `user:${user.id}`, deps.approvalTtlSeconds, {
      operatorChatId: deps.operatorChatId,
    });
    if (!approval.ok) {
      // A plan created a moment ago cannot be refused, so this is a real fault: say so rather than report a success.
      emailAuthLog(structuredLog("error", "portal.provisioning_retry_approval_failed", { trip_id: tripId, plan_id: retried.planId, reason: approval.reason }));
      return reply.code(500).send({ error: "APPROVAL_FAILED" });
    }
    return reply.code(201).send({ planId: retried.planId, planStatus: "approved", jobId: retried.jobId });
  });

  // The organizer reviews the plan they just created, then approves or rejects
  // it. Twin of app.ts's POST /v1/plans/:planId/approve — same decision, same
  // authorizer, different auth surface (this one takes the SPA's cookie+CSRF
  // session). There is no operations-review queue: the operator is notified
  // when an approval lands, and provisioning never waits on that DM.
  //
  // Both routes are trip-scoped so the owner check and the plan are read
  // together; a plan whose trip the caller does not own is 404, not 403.
  async function ownedPendingPlan(
    request: FastifyRequest, reply: FastifyReply, userId: string,
  ): Promise<{ planId: string; tripId: string } | null> {
    const params = request.params as { id?: string; planId?: string };
    const tripId = params.id ?? "";
    const planId = params.planId ?? "";
    const member = await membership(deps, tripId, userId);
    if (!member || member.role !== "owner" || !member.dashboard_access) {
      reply.code(404).send({ error: "NOT_FOUND" });
      return null;
    }
    const plan = await deps.db.query<{ id: string }>(
      "SELECT id FROM control_plane.plans WHERE id = $1 AND trip_id = $2",
      [planId, tripId],
    );
    if (!plan.rows[0]) {
      reply.code(404).send({ error: "NOT_FOUND" });
      return null;
    }
    return { planId, tripId };
  }

  app.post("/v1/trips/:id/plans/:planId/approve", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    const owned = await ownedPendingPlan(request, reply, user.id);
    if (!owned) return;
    const result = await issueApproval(deps.db, owned.planId, `user:${user.id}`, deps.approvalTtlSeconds, {
      operatorChatId: deps.operatorChatId,
    });
    if (!result.ok) return reply.code(result.reason === "ALREADY_APPROVED" ? 409 : 422).send({ error: result.reason });
    await recordFunnelEvent(deps.db, "provisioning_approved", { userId: user.id, tripId: owned.tripId });
    return { approvalId: result.approvalId, expiresAt: result.expiresAt.toISOString() };
  });

  app.post("/v1/trips/:id/plans/:planId/reject", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    const owned = await ownedPendingPlan(request, reply, user.id);
    if (!owned) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const code = typeof body.reasonCode === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(body.reasonCode) ? body.reasonCode : "ORGANIZER_REJECTED";
    const client = await deps.db.connect();
    try {
      await client.query("BEGIN");
      // Guarded on status rather than a review row: only a plan still awaiting
      // a decision can be rejected, and the UPDATE's own rowCount is the lock.
      const superseded = await client.query(
        "UPDATE control_plane.plans SET status = 'superseded', updated_at = now() WHERE id = $1 AND status = 'pending_approval'",
        [owned.planId]);
      if (!superseded.rowCount) { await client.query("ROLLBACK"); return reply.code(409).send({ error: "PLAN_NOT_PENDING" }); }
      await client.query("UPDATE control_plane.jobs SET state = 'cancelled', updated_at = now() WHERE plan_id = $1 AND state = 'waiting_for_user_action'", [owned.planId]);
      await client.query("UPDATE control_plane.trips SET lifecycle_state = 'intake_confirmed', updated_at = now() WHERE id = $1", [owned.tripId]);
      await client.query("COMMIT");
      return { state: "rejected", reasonCode: code };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally { client.release(); }
  });

  app.post("/v1/trips/:id/site-invites", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    const tripId = (request.params as { id?: string }).id ?? "";
    const member = await membership(deps, tripId, user.id);
    if (!member || !["owner", "organizer"].includes(member.role) || !member.dashboard_access) return reply.code(404).send({ error: "NOT_FOUND" });
    const body = request.body as Record<string, unknown>;
    const displayName = typeof body.displayName === "string" ? body.displayName.trim().slice(0, 120) : "";
    const runtimeUsername = typeof body.runtimeUsername === "string" ? body.runtimeUsername.toLowerCase().trim() : "";
    if (!displayName || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(runtimeUsername)) return reply.code(400).send({ error: "INVALID_REQUEST" });
    // The rules (an existing participant, never an organizer, never a claimed traveller, the lock) live in createSiteInvite, which
    // the runtime gateway's hop and the companion's tool call too.
    const made = await createSiteInvite({ ...deps, log: emailAuthLog }, { tripId, actorUserId: user.id, runtimeUsername, displayName });
    if (!made.ok) return reply.code(made.status).send({ error: made.error });
    return reply.code(201).send({ id: made.id, status: "unused", joinUrl: made.joinUrl });
  });

  app.delete("/v1/trips/:id/site-invites/:inviteId", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    const params = request.params as { id?: string; inviteId?: string };
    const member = await membership(deps, params.id ?? "", user.id);
    if (!member || !["owner", "organizer"].includes(member.role) || !member.dashboard_access) return reply.code(404).send({ error: "NOT_FOUND" });
    const result = await deps.db.query(
      "UPDATE control_plane.site_invites SET state = 'revoked', updated_at = now() WHERE id = $1 AND trip_id = $2 AND state = 'unused'",
      [params.inviteId, params.id]);
    if (result.rowCount) return { status: "revoked" };
    // A REDEEMED invite is a person on the trip: revoking it removes them, with
    // everything removing a member does (member-removal.ts).
    const redeemed = await deps.db.query<{ redeemed_by: string | null }>(
      "SELECT redeemed_by FROM control_plane.site_invites WHERE id = $1 AND trip_id = $2 AND state = 'redeemed'",
      [params.inviteId, params.id]);
    const target = redeemed.rows[0]?.redeemed_by;
    if (!target) return reply.code(404).send({ error: "NOT_FOUND" });
    const removal = await removeMember(deps.db, { tripId: params.id ?? "", actorUserId: user.id, targetUserId: target });
    if (!removal.ok) return reply.code(removal.status).send({ error: removal.error });
    await releaseSiteBindings(removal.releasedInvites.map((row) => ({ tripId: params.id ?? "", userId: target, runtimeUsername: row.runtimeUsername, inviteId: row.inviteId, reason: "invite_revoked" })));
    return { status: "revoked" };
  });

  // Remove a member from the trip. Organizer-side only; anyone else, and any
  // membership that is not on this trip, is the same 404.
  app.delete("/v1/trips/:id/members/:membershipId", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    const params = request.params as { id?: string; membershipId?: string };
    const tripId = params.id ?? "";
    const target = await deps.db.query<{ user_id: string }>(
      "SELECT user_id FROM control_plane.trip_memberships WHERE id = $1 AND trip_id = $2 AND status = 'active'",
      [params.membershipId ?? "", tripId]);
    const actor = await membership(deps, tripId, user.id);
    if (!actor || !["owner", "organizer"].includes(actor.role) || !actor.dashboard_access || !target.rows[0]) {
      return reply.code(404).send({ error: "NOT_FOUND" });
    }
    // A member who is a group claim also holds a binding on the trip site; the membership ending releases the claim in the
    // database (trigger of migration 20261119120000), and the site's binding is ended here once the removal has succeeded.
    const claimed = await deps.db.query<{ runtime_username: string }>(
      "SELECT runtime_username FROM control_plane.trip_participant_claims WHERE trip_id = $1 AND user_id = $2 AND released_at IS NULL", [tripId, target.rows[0].user_id]);
    const removal = await removeMember(deps.db, { tripId, actorUserId: user.id, targetUserId: target.rows[0].user_id });
    if (!removal.ok) return reply.code(removal.status).send({ error: removal.error });
    await releaseSiteBindings([
      ...claimed.rows.map((row) => ({ tripId, userId: target.rows[0]!.user_id, runtimeUsername: row.runtime_username, reason: "membership_ended" })),
      // the person's way in may have been a redeemed invite: its binding on the site ends too (account + name + invite id)
      ...removal.releasedInvites.map((row) => ({ tripId, userId: target.rows[0]!.user_id, runtimeUsername: row.runtimeUsername, inviteId: row.inviteId, reason: "membership_ended" })),
    ]);
    return { status: "removed" };
  });

  app.post("/v1/site-invites/inspect", async (request, reply) => {
    const token = (request.body as Record<string, unknown>)?.token;
    if (typeof token !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });
    const result = await deps.db.query(
      `SELECT i.id, i.intended_display_name, i.runtime_username, i.state, i.expires_at,
              t.title, t.destination_label FROM control_plane.site_invites i JOIN control_plane.trips t ON t.id = i.trip_id
       WHERE i.token_digest = $1`, [sha256(token)]);
    const row = result.rows[0];
    if (!row) return reply.code(404).send({ error: "NOT_FOUND" });
    const status = row.state === "unused" && new Date(row.expires_at).getTime() < Date.now() ? "expired" : row.state;
    return { id: row.id, displayName: row.intended_display_name, runtimeUsername: row.runtime_username, tripTitle: row.title ?? row.destination_label, status, expiresAt: row.expires_at };
  });

  app.post("/v1/site-invites/redeem", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const token = body.token;
    const method = body.method;
    if (typeof token !== "string" || (method !== "google" && method !== "password")) return reply.code(400).send({ error: "INVALID_REQUEST" });
    let signedIn = await portalUser(request, deps);
    // Riding a cookie session is a state change on that account: it needs our origin when the browser sends one.
    if (signedIn && originRefused(request, deps)) return reply.code(403).send({ error: "ORIGIN_INVALID" });
    // Joining a trip adds a membership to the signed-in ACCOUNT: account level,
    // so not from a session a Telegram link minted (portal-scope.ts).
    if (signedIn?.scope) return reply.code(ACCOUNT_SIGN_IN_REQUIRED.status).send(ACCOUNT_SIGN_IN_REQUIRED.body);
    const password = method === "password" && typeof body.password === "string" ? body.password : undefined;
    if (method === "password" && (!password || password.length < 8 || password.length > 128)) return reply.code(400).send({ error: "PASSWORD_INVALID" });
    if (method === "google") {
      // Google redemption acts through an existing browser session, so it is
      // a state-changing request and must prove the session's CSRF secret.
      const csrfUser = await requireMutation(request, reply, deps);
      if (!csrfUser) return;
      signedIn = csrfUser;
      if (!signedIn?.googleSubjectDigest) return reply.code(401).send({ error: "GOOGLE_SIGN_IN_REQUIRED" });
    }
    const invites = await deps.db.query<{
      id: string; trip_id: string; intended_display_name: string; runtime_username: string; state: string; expires_at: Date;
    }>("SELECT id, trip_id, intended_display_name, runtime_username, state, expires_at FROM control_plane.site_invites WHERE token_digest = $1", [sha256(token)]);
    const invite = invites.rows[0];
    if (!invite || invite.state !== "unused") return reply.code(404).send({ error: "NOT_FOUND" });
    if (invite.expires_at.getTime() < Date.now()) {
      // Only an UNUSED invite expires. This write waits on the row lock of a redemption that read the invite while it was still valid
      // and then lands on the row it just marked redeemed: unguarded, it turned a redeemed invite into `expired` with a redeemer, which
      // broke that person's launch and (migration 20261122110000 reads "a redeemed invite left redeemed" as a removal) released their binding.
      await deps.db.query("UPDATE control_plane.site_invites SET state = 'expired', updated_at = now() WHERE id = $1 AND state = 'unused'", [invite.id]);
      return reply.code(410).send({ error: "INVITE_EXPIRED" });
    }
    // Stable across a rolled-back redemption: the runtime may already have
    // recorded this invite when the control-plane transaction retries.
    const userId = signedIn?.id ?? `user_${sha256(invite.id).slice(7, 39)}`;
    const portalPasswordHash = method === "password" && password ? await hashPortalPassword(password) : null;
    let passwordSession: { sessionToken: string; csrf: string } | null = null;
    const client = await deps.db.connect();
    try {
      await client.query("BEGIN");
      // The trip row first, then the invite: the lock every group claim and every invite creation for this trip also takes, so the
      // "is anyone signed in as this traveller?" question below cannot be overtaken by a claim that commits a moment later.
      await client.query("SELECT 1 FROM control_plane.trips WHERE id = $1 FOR UPDATE", [invite.trip_id]);
      const locked = await client.query("SELECT state FROM control_plane.site_invites WHERE id = $1 FOR UPDATE", [invite.id]);
      if (locked.rows[0]?.state !== "unused") { await client.query("ROLLBACK"); return reply.code(409).send({ error: "INVITE_ALREADY_USED" }); }
      // A LIVE claim from the group holds this traveller (an invite made before the claim existed, or one that lost a race): this
      // person cannot take the name from it. A refusal that names nothing and writes nothing; the organizer sorts it out
      // (release the sign-in, send a fresh invite). A claim that has ENDED holds nothing, and the site's leftover binding of it is
      // replaced by the provision below.
      const holder = await client.query("SELECT 1 FROM control_plane.trip_participant_claims WHERE trip_id = $1 AND runtime_username = $2 AND released_at IS NULL", [invite.trip_id, invite.runtime_username]);
      if (holder.rowCount) { await client.query("ROLLBACK"); return reply.code(409).send({ error: "INVITE_UNAVAILABLE" }); }
      // An owner or organizer of THIS trip (a secondary organizer included, and one whose membership was ended: the membership row
      // would be revived below) cannot take a MEMBER invite with their own account: the site would bind their user to the traveller,
      // their own launch would then fail on the role, and the traveller would be stuck. The same refusal as any other; nothing is
      // written and the site is not asked.
      if (signedIn) {
        const organizing = await client.query("SELECT 1 FROM control_plane.trip_memberships WHERE trip_id = $1 AND user_id = $2 AND role IN ('owner', 'organizer')", [invite.trip_id, signedIn.id]);
        if (organizing.rowCount) { await client.query("ROLLBACK"); return reply.code(409).send({ error: "INVITE_UNAVAILABLE" }); }
      }
      const deadInviteIds = await deadInviteIdsFor(client, invite.trip_id, invite.runtime_username);
      if (!signedIn) await client.query("INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', $2)", [userId, invite.intended_display_name]);
      // The runtime adapter is idempotent by invite id. Holding the invite row
      // lock prevents concurrent redemption; if the database transaction later
      // aborts, the same raw invite may safely retry the runtime enrollment.
      try {
        await deps.runtimeAccounts.provisionParticipant({
          tripId: invite.trip_id, inviteId: invite.id, userId, runtimeUsername: invite.runtime_username, displayName: invite.intended_display_name,
          ...(deadInviteIds.length ? { deadInviteIds } : {}),
        });
      } catch (error) {
        // Never a raw 500 (a person is looking at the join page). The site SAID NO: one refusal for every reason, naming nothing (an
        // organizer's name, a name another invite holds, an account bound elsewhere). The site could not be asked, or its answer
        // was lost: retryable, and the same link works again. Either way nothing is written: the invite stays unused and the account
        // this transaction would have made is rolled back with it.
        await client.query("ROLLBACK");
        if ((error as Error | null)?.message === RUNTIME_PARTICIPANT_REFUSED) return reply.code(409).send({ error: "INVITE_UNAVAILABLE" });
        return reply.header("retry-after", "5").code(503).send({ error: "RUNTIME_NOT_READY", retryable: true });
      }
      if (portalPasswordHash) {
        await client.query(
          `INSERT INTO control_plane.web_password_credentials(user_id, trip_id, runtime_username, password_hash)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, trip_id) DO UPDATE
             SET runtime_username = EXCLUDED.runtime_username, password_hash = EXCLUDED.password_hash, updated_at = now()`,
          [userId, invite.trip_id, invite.runtime_username, portalPasswordHash],
        );
      }
      await client.query(
        `INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status, dashboard_access, runtime_access)
         VALUES ($1, $2, $3, 'member', 'active', false, true)
         ON CONFLICT (trip_id, user_id) DO UPDATE SET status = 'active', runtime_access = true`,
        [opaque("memb"), invite.trip_id, userId]);
      await client.query("UPDATE control_plane.site_invites SET state = 'redeemed', redeemed_by = $1, redeemed_at = now(), updated_at = now() WHERE id = $2", [userId, invite.id]);
      if (!signedIn) passwordSession = await createWebSession(client, userId, deps.sessionTtlSeconds);
      await recordFunnelEvent(client, "invitation_redeemed", { userId, tripId: invite.trip_id });
      // Phase 2 linking, invite flavour. Only for a brand-new account that has
      // just proved itself by holding the invite and choosing a password — never
      // for a redemption riding an existing cookie session (that is a session,
      // not a credential), and only from our own origin.
      let telegramLink: "linked" | "skipped" | undefined;
      const linkRequest = !signedIn && method === "password" ? telegramLinkRequest(body) : null;
      if (linkRequest) {
        telegramLink = "skipped";
        const cfg = deps.telegramMiniApp;
        const verified = cfg?.enabled() && originIsOurs(request, deps)
          ? verifyMiniAppInitData(linkRequest.initData, cfg.botToken, { maxAgeSeconds: cfg.maxAgeSeconds })
          : null;
        if (cfg && verified?.ok && admitLogin(miniAppUserAttempts, sha256(`miniapp:${verified.data.telegramUserId}`), 20)) {
          telegramLink = await linkMemberOrSkip(client, {
            launch: verified.data, maxAgeSeconds: cfg.maxAgeSeconds, userId, tripId: invite.trip_id,
            accountName: invite.intended_display_name, via: "mini_app_invite_redemption",
          }, miniAppLog);
        }
      }
      await client.query("COMMIT");
      if (passwordSession) setWebSessionCookies(reply, deps, passwordSession);
      return { status: "redeemed", tripId: invite.trip_id, appPath: `/trips/${invite.trip_id}/app`, ...(telegramLink ? { telegramLink } : {}) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  });

  app.post("/v1/trips/:id/launch", async (request, reply) => {
    const user = await requireMutation(request, reply, deps);
    if (!user) return;
    const tripId = (request.params as { id?: string }).id ?? "";
    const member = await membership(deps, tripId, user.id);
    if (!member?.runtime_access) return reply.code(404).send({ error: "NOT_FOUND" });
    // A session a group claim minted gets no runtime grant unless its person is still in the group (groupSessionVerdict).
    if (user.telegramLinkId) {
      const verdict = await groupSessionVerdict({ tripId, userId: user.id, sessionId: user.sessionId, everyTime: true });
      if (verdict === "dormant") return reply.code(404).send({ error: "NOT_FOUND" });
      if (verdict === "revoked") return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });
      if (verdict === "unknown") return reply.header("retry-after", "5").code(503).send({ error: "MEMBERSHIP_CHECK_UNAVAILABLE", retryable: true });
    }
    const token = base64url(32);
    await deps.db.query(
      `INSERT INTO control_plane.runtime_launch_grants(id, trip_id, user_id, token_digest, audience, expires_at, session_id)
       VALUES ($1, $2, $3, $4, 'runtime_gateway', now() + interval '90 seconds', $5)`,
      [opaque("launch"), tripId, user.id, sha256(token), user.sessionId],
    );
    await recordFunnelEvent(deps.db, "runtime_launched", { userId: user.id, tripId });
    return { runtimeOrigin: deps.runtimeOrigin, framePath: `/t/${tripId}/`, launchToken: token, expiresInSeconds: 90 };
  });

  app.post("/internal/runtime-launch/consume", async (request, reply) => {
    if (!exchangeKeyMatches(request.headers["x-api-key"], deps.runtimeExchangeKey)) return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });
    const token = (request.body as Record<string, unknown>)?.token;
    if (typeof token !== "string") return reply.code(400).send({ error: "INVALID_REQUEST" });
    const result = await deps.db.query<{ id: string; trip_id: string; user_id: string; role: string; dashboard_access: boolean; runtime_username: string | null; session_id: string | null }>(
      `UPDATE control_plane.runtime_launch_grants g SET consumed_at = now()
       FROM control_plane.trip_memberships m
       WHERE g.token_digest = $1 AND g.consumed_at IS NULL AND g.expires_at > now()
         AND m.trip_id = g.trip_id AND m.user_id = g.user_id AND m.status = 'active' AND m.runtime_access = true
       RETURNING g.id, g.trip_id, g.user_id, g.session_id, m.role, m.dashboard_access,
         -- Which trip-site participant this account stands for: a live group claim first (slice S1 of
         -- docs/specs/sprint-9/x-member-sign-in.md), then a redeemed site invite, as before.
         COALESCE(
           (SELECT c.runtime_username FROM control_plane.trip_participant_claims c
             WHERE c.trip_id = g.trip_id AND c.user_id = g.user_id AND c.released_at IS NULL
             ORDER BY c.created_at DESC LIMIT 1),
           (SELECT i.runtime_username FROM control_plane.site_invites i
             WHERE i.trip_id = g.trip_id AND i.redeemed_by = g.user_id AND i.state = 'redeemed'
             ORDER BY i.redeemed_at DESC LIMIT 1)) AS runtime_username`, [sha256(token)]);
    const row = result.rows[0];
    if (!row) return reply.code(401).send({ error: "LAUNCH_INVALID" });
    // The way back to the dashboard, from this deployment's own configured
    // portal origin (no hostname in code). Only an owner/organizer has a
    // dashboard; the trip still re-checks the role before it serves the URL.
    // A secondary organizer (#523) is an 'organizer' with NO dashboard access: no way back to a dashboard they cannot open.
    const dashboardUrl = row.role === "member" || !row.dashboard_access ? null : `${deps.publicOrigin}/trips/${row.trip_id}/setup`;
    return { tripId: row.trip_id, userId: row.user_id, role: row.role, runtimeUsername: row.runtime_username, dashboardUrl, sessionId: row.session_id, audience: "runtime_gateway" };
  });

  // Asked by the gateway (at most every 30 s per session) before it serves a
  // request on a sealed cookie: is the portal session that opened this trip
  // still live, and is its person still active and still entitled to the trip?
  // Signing out of the portal on one device therefore ends the trip session
  // opened from that device and no other; removal from the trip or disabling
  // ends them all. The role the session was opened with must still be the
  // membership's role: a demotion (or promotion) answers no, so the person has to
  // relaunch and is issued a session for the role they now hold. A grant minted before session binding existed carries no
  // session (null) and keeps the earlier rule: any live portal session of the
  // person. Those grants live 90 seconds, so that rule is a rollback aid only.
  // A session a Telegram link minted is SCOPED (portal-scope.ts): it also has to still have this trip in
  // its scope, re-derived from the live link rows here, so an Unlink ends an open trip page.
  app.post("/internal/runtime-sessions/check", async (request, reply) => {
    if (!exchangeKeyMatches(request.headers["x-api-key"], deps.runtimeExchangeKey)) return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });
    const { tripId, userId, sessionId, role } = (request.body ?? {}) as Record<string, unknown>;
    const optionalText = (value: unknown) => value === undefined || value === null || typeof value === "string";
    if (typeof tripId !== "string" || typeof userId !== "string" || !optionalText(sessionId) || !optionalText(role)) {
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    }
    const result = await deps.db.query(
      `SELECT 1 FROM control_plane.trip_memberships m
       JOIN control_plane.users u ON u.id = m.user_id AND u.status = 'active'
       WHERE m.trip_id = $1 AND m.user_id = $2 AND m.status = 'active' AND m.runtime_access = true
         AND ($4::text IS NULL OR m.role = $4::text)
         AND EXISTS (SELECT 1 FROM control_plane.web_sessions s
                     WHERE s.user_id = m.user_id AND s.revoked_at IS NULL AND s.expires_at > now()
                       AND ($3::text IS NULL OR s.id = $3::text))`,
      [tripId, userId, sessionId ?? null, role ?? null]);
    if (!result.rows[0]) return reply.code(401).send({ error: "SESSION_REVOKED" });
    // A Telegram-minted (scoped) session stays valid only while the trip is in its scope: an Unlink
    // ends an open trip page as it ends the next portal request. Answered exactly as a revoked session.
    if (!(await sessionMayOpenTrip(deps, { userId, tripId, sessionId: typeof sessionId === "string" ? sessionId : null }))) {
      return reply.code(401).send({ error: "SESSION_REVOKED" });
    }
    // A group-claim session is only as live as the person's seat in the group (at most one Telegram question per 10
    // minutes per claim; none for any other session). A Telegram outage answers LIVE: it must not log a family out.
    const group = await groupSessionVerdict({ tripId, userId, sessionId: typeof sessionId === "string" ? sessionId : null, everyTime: false });
    if (group === "dormant" || group === "revoked") return reply.code(401).send({ error: "SESSION_REVOKED" });
    return { live: true };
  });

  // The by-trip-ID lookup answers where the gateway SENDS a trip's calls (session exchange, participant
  // provisioning, session checks), not where a browser goes. A wildcard trip's private_url is its PUBLIC
  // hostname, which host mode answers 404 for /api/internal/* - so when the route row registered a LAN
  // upstream_url, that LAN origin is the answer, validated by the same
  // upstreamHostAllowed the by-host lookup uses. A registered upstream that is not on the list, any upstream
  // when there is no list, and one another ready route shares, are RUNTIME_ROUTE_INVALID - never a fall-back
  // to the public URL. With no upstream_url (every row written before R2, every host-routed trip's) the answer
  // is the private_url one it always was. private_url itself is untouched.
  app.get("/internal/runtime-routes/:tripId", async (request, reply) => {
    if (!exchangeKeyMatches(request.headers["x-api-key"], deps.runtimeExchangeKey)) return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });
    const tripId = (request.params as { tripId?: string }).tripId ?? "";
    // One lookup, shared with the group-line poller (runtime-upstream.ts), so both apply the same host allow-list
    // and both reach a wildcard-routed trip at its registered LAN address. tripKey is the KIND of key, never a key.
    const upstream = await runtimeUpstreamFor(deps.db, tripId, deps.runtimeUpstreamHostSuffixes, deps.runtimeUpstreamAllowedHosts);
    if (!upstream.ok) return reply.code(upstream.status).send({ error: upstream.error });
    return { routeRef: upstream.routeRef, upstreamOrigin: upstream.upstreamOrigin, upstreamBasePath: upstream.upstreamBasePath, tripKey: upstream.tripKey };
  });

  // The gateway's host mode asks "which trip is this Host?" (docs/runtime-session-exchange.md, "Host mode").
  // The static `by-host` segment and the `:tripId` parameter cannot capture each other: this path has one more
  // segment than that one, and a trip id that spelled "by-host" would still reach the other handler.
  // Every "no" is the same 404 with the same body (no such host, not ready, no upstream, not a name), so the
  // answer says nothing about which names exist. upstream_url is returned as an origin only, to the gateway,
  // and only when its host is on the operator's allow-list.
  app.get("/internal/runtime-routes/by-host/:host", async (request, reply) => {
    if (!exchangeKeyMatches(request.headers["x-api-key"], deps.runtimeExchangeKey)) return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });
    const notReady = () => reply.code(404).send({ error: "RUNTIME_NOT_READY" });
    const host = String((request.params as { host?: string }).host ?? "").toLowerCase();
    if (host.length > 253 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)) return notReady();
    const result = await deps.db.query<{ trip_id: string; route_ref: string; upstream_url: string; trip_key: string; shared: boolean }>(
      `SELECT r.trip_id, r.route_ref, r.upstream_url, r.trip_key, ${UPSTREAM_SHARED_SQL} AS shared
       FROM control_plane.runtime_routes r
       WHERE r.public_host = $1 AND r.state = 'ready' AND r.upstream_url IS NOT NULL`, [host]);
    const row = result.rows[0];
    if (!row) return notReady();
    // One LAN address, one trip: two ready routes on one address send each other's visitors (and keys) to one
    // container, so neither is answered until an operator fixes the rows (boundary review of #599, F2).
    if (row.shared) return reply.code(503).send({ error: "RUNTIME_ROUTE_INVALID" });
    let upstream: URL;
    try { upstream = new URL(row.upstream_url); } catch { return reply.code(503).send({ error: "RUNTIME_ROUTE_INVALID" }); }
    if (!["http:", "https:"].includes(upstream.protocol) || upstream.username || upstream.password || upstream.pathname !== "/"
      || upstream.search || upstream.hash || /[?#]/.test(row.upstream_url) || !upstreamHostAllowed(upstream.hostname, deps.runtimeUpstreamAllowedHosts)) {
      return reply.code(503).send({ error: "RUNTIME_ROUTE_INVALID" });
    }
    return { tripId: row.trip_id, routeRef: row.route_ref, upstreamOrigin: upstream.origin, tripKey: row.trip_key };
  });
}
