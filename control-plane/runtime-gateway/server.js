import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import https from "node:https";

const PORT = Number(process.env.PORT || 4320);
const BIND_HOST = process.env.BIND_HOST || "127.0.0.1";
const CONTROL_PLANE_ORIGIN = required("CONTROL_PLANE_INTERNAL_ORIGIN").replace(/\/$/, "");
const EXCHANGE_KEY = required("RUNTIME_EXCHANGE_KEY");
const COOKIE_SECRET = required("RUNTIME_COOKIE_SECRET");
const PORTAL_ORIGIN = required("PORTAL_ORIGIN").replace(/\/$/, "");
const RUNTIME_ORIGIN = required("RUNTIME_ORIGIN").replace(/\/$/, "");
const secureCookie = RUNTIME_ORIGIN.startsWith("https://");
const routeCache = new Map();
// A hung control plane or trip must fail closed quickly, not hold every request open.
const UPSTREAM_TIMEOUT_MS = Math.max(50, Number(process.env.RUNTIME_UPSTREAM_TIMEOUT_MS ?? 5000) || 5000);
const timedFetch = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });

// The per-trip cookie is SameSite=Strict, so the portal and this origin must be
// the same SITE: from another site the browser stores the cookie after the launch
// POST but does not send it on the 303, and every launch would loop back to the
// portal. "Same site" here is the registrable domain, approximated by the last two
// hostname labels (three when the last two are a listed public suffix such as
// co.uk, named in RUNTIME_PUBLIC_SUFFIXES, comma separated); two non-DNS hosts
// (localhost, an IP address) are the same site only if the hostnames are equal.
// RUNTIME_SAME_SITE_OK=1 overrides a wrong guess, loudly.
export function registrableDomain(hostname, publicSuffixes = []) {
  const labels = hostname.toLowerCase().split(".");
  if (labels.length < 2 || /^[\d.]+$/.test(hostname) || hostname.includes(":") || hostname.startsWith("[")) return hostname.toLowerCase();
  const tail2 = labels.slice(-2).join(".");
  return publicSuffixes.includes(tail2) && labels.length >= 3 ? labels.slice(-3).join(".") : tail2;
}
export function sameSite(a, b, publicSuffixes = []) {
  return registrableDomain(new URL(a).hostname, publicSuffixes) === registrableDomain(new URL(b).hostname, publicSuffixes);
}
const publicSuffixes = String(process.env.RUNTIME_PUBLIC_SUFFIXES || "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
if (!sameSite(PORTAL_ORIGIN, RUNTIME_ORIGIN, publicSuffixes)) {
  if (process.env.RUNTIME_SAME_SITE_OK === "1") {
    console.error("runtime_gateway.cross_site_origins_allowed: PORTAL_ORIGIN and RUNTIME_ORIGIN are not the same site; RUNTIME_SAME_SITE_OK=1 is set, so launches will only work if the browser really treats them as same-site");
  } else {
    const message = "PORTAL_ORIGIN and RUNTIME_ORIGIN must be the same site (share a registrable domain): the trip cookie is SameSite=Strict and would not be sent after the launch, so every launch would loop. Set RUNTIME_PUBLIC_SUFFIXES if the shared domain sits under a public suffix such as co.uk, or RUNTIME_SAME_SITE_OK=1 to override.";
    console.error(`runtime_gateway.cross_site_origins: ${message}`);
    throw new Error(message);
  }
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": data.length, "cache-control": "no-store" });
  res.end(data);
}

async function readRaw(req, limit = 32_768) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req, limit = 32_768) {
  return JSON.parse(await readRaw(req, limit) || "{}");
}

const cookieKey = createHash("sha256").update(COOKIE_SECRET).digest();
function encodeSession(payload) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cookieKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return `${nonce.toString("base64url")}.${ciphertext.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
}
function decodeSession(raw) {
  if (!raw) return null;
  try {
    const [nonce, ciphertext, tag, extra] = raw.split(".");
    if (!nonce || !ciphertext || !tag || extra) return null;
    const decipher = createDecipheriv("aes-256-gcm", cookieKey, Buffer.from(nonce, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const payload = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final(),
    ]).toString("utf8"));
    return payload.exp > Date.now() ? payload : null;
  } catch { return null; }
}
function cookieValue(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

async function controlPlane(path, init = {}) {
  const response = await timedFetch(`${CONTROL_PLANE_ORIGIN}${path}`, { ...init, headers: { ...init.headers, "x-api-key": EXCHANGE_KEY } });
  if (!response.ok) {
    // `body` is what the control plane SAID (a callers that maps a refusal reads one named code from it; nothing else is ever
    // passed on). Unreadable or hung is null: a refusal with no reason.
    const said = await response.json().catch(() => null);
    const error = Object.assign(new Error("CONTROL_PLANE_REJECTED"), { statusCode: response.status, body: said });
    throw error;
  }
  return response.json();
}

async function routeFor(tripId) {
  const cached = routeCache.get(tripId);
  if (cached?.expiresAt > Date.now()) return cached.route;
  const route = await controlPlane(`/internal/runtime-routes/${encodeURIComponent(tripId)}`);
  routeCache.set(tripId, { route, expiresAt: Date.now() + 30_000 });
  return route;
}

// The browser lands here by a top-level form POST from the portal (no iframe,
// no postMessage), so every refusal is a small page that links back to the
// portal rather than raw JSON. Status codes stay uniform: a caller cannot tell
// "no such trip" from "bad grant" from "grant for another trip".
function launchRefused(res, status) {
  const body = Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Kinerary</title></head><body><p>This trip could not be opened.</p><p><a href="${PORTAL_ORIGIN}/trips">Return to Kinerary</a></p></body></html>`);
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "content-length": body.length, "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
  res.end(body);
}

// Only a browser navigation is sent to the portal. A script's fetch (or a
// frame, which nothing may create any more) keeps the 401 JSON.
function wantsPage(req) {
  const mode = req.headers["sec-fetch-mode"];
  if (mode) return mode === "navigate" && (req.headers["sec-fetch-dest"] || "document") === "document";
  return String(req.headers.accept || "").includes("text/html");
}

// One cookie per trip, name-scoped rather than path-scoped: a __Host- cookie
// must be Path=/ with no Domain, which also stops a sibling subdomain from
// planting (tossing) a session of its own. Plain http (local development) cannot
// carry the prefix.
function cookieName(tripId) {
  return `${secureCookie ? "__Host-" : ""}kit_rt_${tripId}`;
}

function sameKey(supplied) {
  const a = Buffer.from(String(supplied ?? "")), b = Buffer.from(EXCHANGE_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

// The sealed cookie proves the portal once vouched for this person; the portal
// is asked again (at most every 30 s per launching portal session and trip) so that signing out of
// the portal, removing someone from the trip or disabling them ends the trip
// session too. A positive answer is cached, a negative one never is. When the
// control plane cannot be asked the answer is no: failing open here would turn
// an outage into a way to keep a revoked session.
const LIVE_FOR_MS = Math.max(0, Math.min(30_000, Number(process.env.RUNTIME_SESSION_CHECK_TTL_MS ?? 30_000) || 0));
const liveCache = new Map();
async function sessionLive(session) {
  if (typeof session.userId !== "string") return false;
  const sessionId = typeof session.sessionId === "string" ? session.sessionId : null;
  const role = typeof session.role === "string" ? session.role : null;
  const key = `${session.tripId}:${session.userId}:${sessionId}:${role}`;
  if ((liveCache.get(key) ?? 0) > Date.now()) return true;
  try {
    await controlPlane("/internal/runtime-sessions/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tripId: session.tripId, userId: session.userId, sessionId, role }) });
  } catch (error) {
    liveCache.delete(key);
    if (error?.message === "CONTROL_PLANE_REJECTED") return false;
    console.error("runtime_gateway.session_check_unavailable");
    return false;
  }
  liveCache.set(key, Date.now() + LIVE_FOR_MS);
  if (liveCache.size > 5000) for (const [k, expires] of liveCache) if (expires < Date.now()) liveCache.delete(k);
  return true;
}

// An owner or organizer whose way back to the dashboard did not survive the pin
// opens a trip with no "Organizer dashboard" menu entry and nothing anywhere
// saying why (2026-10-20, staging acceptance). Say so, once per launch: the
// reason and the origins, never the grant, a token or a cookie.
function logDashboardDropped(tripId, grant) {
  let reason = "absent";
  let received = "";
  if (typeof grant.dashboardUrl === "string") {
    reason = "not_this_portals_setup_page";
    try { received = ` received_origin=${new URL(grant.dashboardUrl).origin}`; } catch { reason = "unparseable"; }
  }
  console.error(`runtime_gateway.dashboard_url_dropped: trip=${tripId} role=${grant.role} reason=${reason} expected_origin=${PORTAL_ORIGIN}${received}`);
}

async function launch(req, res, tripId) {
  // A cross-site form POST carries no cookie of ours and no custom header, so
  // Origin is the only thing that says the portal sent it. Missing, "null"
  // (a no-referrer form, a sandboxed frame) or foreign: refuse before reading
  // the body or touching the grant.
  if (req.headers.origin !== PORTAL_ORIGIN) return launchRefused(res, 403);
  let token;
  try {
    const raw = await readRaw(req, 4096);
    const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    // The portal's form is urlencoded. JSON stays only so a rollback to the
    // previous portal build still launches; every other type (text/plain is
    // what a cross-site form can send without a preflight) is refused.
    if (type === "application/x-www-form-urlencoded") token = new URLSearchParams(raw).get("token");
    else if (type === "application/json") token = JSON.parse(raw || "{}").token;
    else return launchRefused(res, 400);
  } catch { return launchRefused(res, 400); }
  if (typeof token !== "string" || !token || token.length > 256) return launchRefused(res, 400);
  const grant = await controlPlane("/internal/runtime-launch/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  if (grant.tripId !== tripId || grant.audience !== "runtime_gateway") return launchRefused(res, 401);
  const route = await routeFor(tripId);
  const identity = { tripId, userId: grant.userId, role: grant.role, runtimeUsername: grant.runtimeUsername };
  // The control plane builds the dashboard URL from its own configuration; the
  // trip validates its shape again before it will serve it to an owner or organizer.
  // Only this deployment's own portal can be the way back: the URL must be exactly
  // PORTAL_ORIGIN + the trip's setup path, whatever the control plane sent.
  if (grant.dashboardUrl === `${PORTAL_ORIGIN}/trips/${tripId}/setup`) identity.dashboardUrl = grant.dashboardUrl;
  else if (grant.role === "owner" || grant.role === "organizer") logDashboardDropped(tripId, grant);
  const sessionResponse = await timedFetch(`${route.upstreamOrigin}${route.upstreamBasePath}/api/internal/control-plane/session`, {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": EXCHANGE_KEY },
    body: JSON.stringify(identity),
  });
  if (!sessionResponse.ok) return launchRefused(res, [400, 401, 403].includes(sessionResponse.status) ? 401 : 503);
  const runtime = await sessionResponse.json();
  if (typeof runtime.token !== "string") return launchRefused(res, 503);
  const value = encodeSession({ tripId, userId: grant.userId, sessionId: typeof grant.sessionId === "string" ? grant.sessionId : null, role: typeof grant.role === "string" ? grant.role : null, token: runtime.token, exp: Date.now() + 12 * 60 * 60 * 1000 });
  // Strict: the launch POST and the 303 that follows it come from the portal,
  // which must be same-site with this origin (docs/runtime-session-exchange.md).
  const attributes = [`${cookieName(tripId)}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=43200"];
  if (secureCookie) attributes.push("Secure");
  // 303 turns the POST into a GET of the trip. The grant is in no URL.
  res.writeHead(303, { location: `/t/${tripId}/`, "set-cookie": attributes.join("; "), "cache-control": "no-store", "referrer-policy": "no-referrer" });
  res.end();
}

async function provisionParticipant(req, res, tripId) {
  if (!sameKey(req.headers["x-api-key"])) return json(res, 401, { error: "AUTHENTICATION_REQUIRED" });
  if (!/^trip_[A-Za-z0-9]{8,64}$/.test(tripId)) return json(res, 404, { error: "NOT_FOUND" });
  const route = await routeFor(tripId);
  const body = await readJson(req);
  if (body.tripId !== tripId) return json(res, 400, { error: "INVALID_REQUEST" });
  const response = await timedFetch(`${route.upstreamOrigin}${route.upstreamBasePath}/api/internal/control-plane/participants`, {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": EXCHANGE_KEY }, body: JSON.stringify(body),
  });
  const payload = await response.text();
  res.writeHead(response.status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(payload);
}

async function participantExists(req, res, tripId, runtimeUsername) {
  if (!sameKey(req.headers["x-api-key"])) return json(res, 401, { error: "AUTHENTICATION_REQUIRED" });
  if (!/^trip_[A-Za-z0-9]{8,64}$/.test(tripId)) return json(res, 404, { error: "NOT_FOUND" });
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(runtimeUsername)) return json(res, 400, { error: "INVALID_REQUEST" });
  const route = await routeFor(tripId);
  const response = await timedFetch(`${route.upstreamOrigin}${route.upstreamBasePath}/api/internal/control-plane/participants/${encodeURIComponent(runtimeUsername)}`, {
    method: "GET", headers: { "x-api-key": EXCHANGE_KEY, "x-control-plane-trip-id": tripId },
  });
  const payload = await response.text();
  res.writeHead(response.status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(payload);
}

// ADOPT and RELEASE: bind a control-plane user to an EXISTING participant of the trip site, and end that binding (group
// sign-in's claim and its release; the personal invite for an existing traveller reuses them). Same key as the rest of
// /internal/t/..., and the body is forwarded untouched with the trip id in it, as `provisionParticipant` does.
async function bindingAction(req, res, tripId, action) {
  if (!sameKey(req.headers["x-api-key"])) return json(res, 401, { error: "AUTHENTICATION_REQUIRED" });
  if (!/^trip_[A-Za-z0-9]{8,64}$/.test(tripId)) return json(res, 404, { error: "NOT_FOUND" });
  const route = await routeFor(tripId);
  const body = await readJson(req);
  if (body.tripId !== tripId) return json(res, 400, { error: "INVALID_REQUEST" });
  const response = await timedFetch(`${route.upstreamOrigin}${route.upstreamBasePath}/api/internal/control-plane/participants/${action}`, {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": EXCHANGE_KEY }, body: JSON.stringify(body),
  });
  const payload = await response.text();
  res.writeHead(response.status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(payload);
}

// The trip site's participants (username, display name, role), for the control plane's group sign-in: who a person in
// the trip's Telegram group may pick as themselves. Behind the same key as the lookup above, and the trip site checks
// that key and the trip id again (the id travels in a header on a GET, as for `participantExists`). The body is the
// trip site's own three-field list, passed through untouched.
async function listParticipants(req, res, tripId) {
  if (!sameKey(req.headers["x-api-key"])) return json(res, 401, { error: "AUTHENTICATION_REQUIRED" });
  if (!/^trip_[A-Za-z0-9]{8,64}$/.test(tripId)) return json(res, 404, { error: "NOT_FOUND" });
  const route = await routeFor(tripId);
  const response = await timedFetch(`${route.upstreamOrigin}${route.upstreamBasePath}/api/internal/control-plane/participants`, {
    method: "GET", headers: { "x-api-key": EXCHANGE_KEY, "x-control-plane-trip-id": tripId },
  });
  const payload = await response.text();
  res.writeHead(response.status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(payload);
}

// ORGANIZERS' GROUP CLAIMS: the hop between the trip site's Organizer settings and the control plane (docs/specs/sprint-9/
// x-member-sign-in.md, amendment A5). `trip-web` talks only to the trip site, and the trip site cannot call the control
// plane, so the gateway, which holds the person's sealed session, asks on their behalf:
//
//   GET    /t/:tripId/__member-claims            the live claims          -> control plane POST /internal/member-claims/list
//   DELETE /t/:tripId/__member-claims/:claimId   release one              -> control plane POST /internal/member-claims/release
//
// THE GATEWAY DECIDES NOTHING ABOUT WHO MAY. It forwards three facts it knows from its OWN sealed cookie (trip, user, the
// portal session that opened this trip) and the control plane re-decides everything from its database: a live session that is
// that user's, owner/organizer of that trip, the feature on, the session's scope. Nothing the browser sends is forwarded: no
// header (the key is the gateway's own, set last), no cookie, no query, no user id, no body. A caller without a session gets
// the gateway's ordinary 401; anyone the control plane does not accept gets its one 404, whoever they are.
// Release additionally needs what the gateway's own POSTs need (logout): a header a cross-site form cannot send, and this
// origin as the request's Origin.
const CLAIM_ID_SHAPE = /^tpc_[A-Za-z0-9]{8,64}$/;
const text = (value) => (typeof value === "string" ? value : null);
async function memberClaims(req, res, tripId, claimId) {
  const releasing = req.method === "DELETE";
  if (releasing && (req.headers["x-kinerary-member-claims"] !== "1" || req.headers.origin !== RUNTIME_ORIGIN)) {
    return json(res, 403, { error: "ORIGIN_REJECTED" });
  }
  const session = decodeSession(cookieValue(req, cookieName(tripId)));
  if (!session || session.tripId !== tripId || typeof session.userId !== "string" || !(await sessionLive(session))) {
    return json(res, 401, { error: "AUTHENTICATION_REQUIRED" });
  }
  // A grant minted before session binding names no portal session: the control plane cannot decide for it, so nothing is shown.
  if (typeof session.sessionId !== "string") return json(res, 404, { error: "NOT_FOUND" });
  if (releasing && !CLAIM_ID_SHAPE.test(claimId ?? "")) return json(res, 404, { error: "NOT_FOUND" });
  let answer;
  try {
    answer = await controlPlane(releasing ? "/internal/member-claims/release" : "/internal/member-claims/list", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tripId: session.tripId, userId: session.userId, sessionId: session.sessionId, ...(releasing ? { claimId } : {}) }),
    });
  } catch (error) {
    const status = error?.message === "CONTROL_PLANE_REJECTED" ? error.statusCode : 0;
    if (status === 404) return json(res, 404, { error: "NOT_FOUND" });
    // A Telegram-minted organizer session may look but not release: the one refusal that says why, and only to a caller the
    // control plane has already accepted as this trip's organizer.
    if (status === 403) return json(res, 403, { error: "ACCOUNT_SIGN_IN_REQUIRED" });
    return json(res, 503, { error: "RUNTIME_UNAVAILABLE" });
  }
  if (releasing) return answer?.status === "released" ? json(res, 200, { status: "released" }) : json(res, 503, { error: "RUNTIME_UNAVAILABLE" });
  if (!Array.isArray(answer?.claims)) return json(res, 503, { error: "RUNTIME_UNAVAILABLE" });
  // Only the fields the page shows, and only rows shaped like claims: whatever else the control plane says stops here.
  const claims = answer.claims.filter((c) => CLAIM_ID_SHAPE.test(c?.claimId ?? "")).map((c) => ({
    claimId: c.claimId, travellerName: text(c.travellerName) ?? "", telegramFirstName: text(c.telegramFirstName), telegramUsername: text(c.telegramUsername),
    via: text(c.via), claimedAt: text(c.claimedAt), lastSignedInAt: text(c.lastSignedInAt),
  }));
  return json(res, 200, { claims });
}

// ORGANIZERS' PERSONAL INVITES: the hop between the trip site's Organizer settings -> Signing in -> "Send a personal invite" and the
// control plane (docs/specs/sprint-9/x-member-sign-in.md, slice S2, AC-11). The same shape and the same reasons as the claims hop above:
//
//   GET  /t/:tripId/__member-invites             may this person send one?   -> control plane POST /internal/member-invites/available
//   POST /t/:tripId/__member-invites/:username   send one to this traveller  -> control plane POST /internal/member-invites/create
//
// THE GATEWAY DECIDES NOTHING ABOUT WHO MAY. It forwards what it knows from its OWN sealed cookie (trip, user, the portal session that
// opened this trip) plus the one thing only the browser can say, WHICH TRAVELLER (the username in the path, shape-checked here and
// decided on there), and the control plane re-decides everything from its database. Nothing else the browser sends is forwarded: no
// header (the key is the gateway's own), no cookie, no query, no body. This is NOT behind the group sign-in switch: a personal invite is a
// full way in for people who are not on Telegram.
//
// The POST needs what the claims Release needs, with its own header name: a header a cross-site form cannot send, and this origin as the
// request's Origin. What comes back is the link, the name and the expiry, and only a well-formed link to THIS deployment's portal: a
// control plane that said anything else (or an outage, or a hang) is one 503 that says nothing. The named answers an organizer can act on
// pass through as their code alone; any other 409 is the same 503.
const USERNAME_SHAPE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const INVITE_ANSWERS = new Set(["TRAVELLER_CLAIMED_FROM_GROUP", "INVITE_ALREADY_EXISTS", "RUNTIME_PARTICIPANT_NOT_ELIGIBLE", "RUNTIME_PARTICIPANT_NOT_FOUND", "RUNTIME_NOT_READY"]);
async function memberInvites(req, res, tripId, username) {
  const creating = req.method === "POST";
  if (creating && (req.headers["x-kinerary-member-invites"] !== "1" || req.headers.origin !== RUNTIME_ORIGIN)) {
    return json(res, 403, { error: "ORIGIN_REJECTED" });
  }
  const session = decodeSession(cookieValue(req, cookieName(tripId)));
  if (!session || session.tripId !== tripId || typeof session.userId !== "string" || !(await sessionLive(session))) {
    return json(res, 401, { error: "AUTHENTICATION_REQUIRED" });
  }
  // A grant minted before session binding names no portal session: the control plane cannot decide for it, so nothing is offered.
  if (typeof session.sessionId !== "string") return json(res, 404, { error: "NOT_FOUND" });
  if (creating && !USERNAME_SHAPE.test(username ?? "")) return json(res, 404, { error: "NOT_FOUND" });
  let answer;
  try {
    answer = await controlPlane(creating ? "/internal/member-invites/create" : "/internal/member-invites/available", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tripId: session.tripId, userId: session.userId, sessionId: session.sessionId, ...(creating ? { runtimeUsername: username } : {}) }),
    });
  } catch (error) {
    const status = error?.message === "CONTROL_PLANE_REJECTED" ? error.statusCode : 0;
    if (status === 404) return json(res, 404, { error: "NOT_FOUND" });
    // A Telegram-minted organizer session may not make an invite: the one refusal that says why, and only to a caller the control
    // plane has already accepted as this trip's organizer.
    if (status === 403) return json(res, 403, { error: "ACCOUNT_SIGN_IN_REQUIRED" });
    if (status === 409 && creating && INVITE_ANSWERS.has(error.body?.error)) return json(res, 409, { error: error.body.error });
    return json(res, 503, { error: "RUNTIME_UNAVAILABLE" });
  }
  if (!creating) return answer?.available === true ? json(res, 200, { available: true }) : json(res, 503, { error: "RUNTIME_UNAVAILABLE" });
  const link = text(answer?.joinUrl);
  if (!link || link.length > 2048 || !/^[\x21-\x7e]+$/.test(link) || !link.startsWith(`${PORTAL_ORIGIN}/join#token=`)
    || text(answer?.displayName) === null || text(answer?.expiresAt) === null) {
    return json(res, 503, { error: "RUNTIME_UNAVAILABLE" });
  }
  return json(res, 201, { joinUrl: link, displayName: answer.displayName, expiresAt: answer.expiresAt });
}

// Is this path (under /t/:trip) one of the trip site's INTERNAL routes? The site's router is case-insensitive and may decode what it is
// given, so the gateway's block has to match the SAME paths. Every form the path can take is looked at: the raw path, then each round of
// percent-decoding (up to ten, so a many-times-encoded spelling is seen), each lower-cased with repeated slashes collapsed; if ANY of them
// is `/api/internal` or under it, the path is internal. A round that cannot be decoded (a malformed escape such as `%zz`, or a literal
// percent sign that an earlier round produced, as in `100%25.jpg`) does NOT make the path internal and does not stop the look: it is
// decoded leniently instead (valid `%XX` escapes only, anything else left as it is), so `/%2561pi/internal/100%25.jpg` is still seen as
// `/api/internal/...` while `/api/photos/file/100%25.jpg` never becomes anything internal. Previously `/API/internal/...` got past a
// case-sensitive prefix test and was held only because the gateway strips x-api-key; a first version of this treated any decode failure as
// internal, which blocked ordinary file names with a literal percent sign.
const isInternalForm = (value) => {
  const form = value.toLowerCase().replace(/\/{2,}/g, "/");
  return form === "/api/internal" || form.startsWith("/api/internal/");
};
const lenientDecode = (value) => value.replace(/%([0-9a-fA-F]{2})/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
export function isInternalPath(suffix) {
  let path = String(suffix);
  for (let round = 0; round < 10; round += 1) {
    if (isInternalForm(path)) return true;
    let decoded;
    try { decoded = decodeURIComponent(path); } catch { decoded = lenientDecode(path); }
    if (decoded === path) return false;
    path = decoded;
  }
  return isInternalForm(path);
}

// Ask again while a stream is open, at half the cache window so a revocation
// is seen within one window after the cached "live" runs out (30 s + 15 s with
// the defaults). A negative answer, an outage and a hung control plane all end
// the stream, as they end a request: the browser reconnects with its backoff and
// the connection itself is then refused with the rest.
function endStreamWhenSessionEnds(res, upstream, session) {
  const every = Math.max(250, Math.min(15_000, Math.floor(LIVE_FOR_MS / 2) || 1_000));
  let asking = false;
  const timer = setInterval(async () => {
    if (asking) return;
    asking = true;
    try {
      if (await sessionLive(session)) return;
    } finally { asking = false; }
    clearInterval(timer);
    upstream.destroy();
    res.destroy();
  }, every);
  timer.unref?.();
  res.on("close", () => clearInterval(timer));
}

async function proxy(req, res, tripId, suffix, session) {
  const route = await routeFor(tripId);
  const origin = new URL(route.upstreamOrigin);
  const targetPath = `${route.upstreamBasePath}${suffix || "/"}${new URL(req.url, RUNTIME_ORIGIN).search}`;
  const headers = { ...req.headers, host: origin.host, authorization: `Bearer ${session.token}`, "x-forwarded-prefix": `/t/${tripId}` };
  delete headers.cookie;
  delete headers["x-api-key"];
  const transport = origin.protocol === "https:" ? https : http;
  const upstream = transport.request({ protocol: origin.protocol, hostname: origin.hostname, port: origin.port || undefined, method: req.method, path: targetPath, headers }, (upstreamResponse) => {
    const responseHeaders = { ...upstreamResponse.headers };
    delete responseHeaders["set-cookie"];
    // The trip site is a top-level page now; nothing frames it. Keep the
    // upstream X-Frame-Options and make the CSP say the same, preserving the
    // other upstream CSP directives.
    responseHeaders["x-frame-options"] = "DENY";
    const upstreamCsp = String(responseHeaders["content-security-policy"] || "");
    const csp = upstreamCsp.split(";").map(part => part.trim()).filter(part => part && !/^frame-ancestors(?:\s|$)/i.test(part));
    responseHeaders["content-security-policy"] = [...csp, "frame-ancestors 'none'"].join("; ");

    if (typeof responseHeaders.location === "string" && responseHeaders.location.startsWith("/")) responseHeaders.location = `/t/${tripId}${responseHeaders.location}`;
    res.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
    upstreamResponse.pipe(res);
    // The check above ran once, when this request began. A live-update stream
    // can then stay open for the whole 12-hour cookie, so signing out of the
    // portal would end every request except the one carrying the trip's data.
    if (String(responseHeaders["content-type"] || "").toLowerCase().startsWith("text/event-stream")) endStreamWhenSessionEnds(res, upstream, session);
  });
  upstream.on("error", () => { if (!res.headersSent) json(res, 502, { error: "RUNTIME_UNAVAILABLE" }); else res.destroy(); });
  // A closed browser must also release its long-lived upstream SSE stream.
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

export function createRuntimeGateway() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, RUNTIME_ORIGIN);
      if (url.pathname === "/health") return json(res, 200, { ok: true });
      const internal = url.pathname.match(/^\/internal\/t\/([^/]+)\/participants$/);
      if (internal && req.method === "POST") return await provisionParticipant(req, res, decodeURIComponent(internal[1]));
      if (internal && req.method === "GET") return await listParticipants(req, res, decodeURIComponent(internal[1]));
      const binding = url.pathname.match(/^\/internal\/t\/([^/]+)\/participants\/(adopt|release)$/);
      if (binding && req.method === "POST") return await bindingAction(req, res, decodeURIComponent(binding[1]), binding[2]);
      const internalParticipant = url.pathname.match(/^\/internal\/t\/([^/]+)\/participants\/([^/]+)$/);
      if (internalParticipant && req.method === "GET") return await participantExists(req, res, decodeURIComponent(internalParticipant[1]), decodeURIComponent(internalParticipant[2]));
      const match = url.pathname.match(/^\/t\/([^/]+)(\/.*)?$/);
      if (!match) return json(res, 404, { error: "NOT_FOUND" });
      const tripId = decodeURIComponent(match[1]);
      if (!/^trip_[A-Za-z0-9]{8,64}$/.test(tripId)) return json(res, 404, { error: "NOT_FOUND" });
      const suffix = match[2] || "/";
      if (suffix === "/__launch" && req.method === "POST") {
        try { return await launch(req, res, tripId); }
        catch (error) {
          // A rejected/expired/replayed grant is an authentication failure,
          // anything else is the runtime being away. Never raw JSON: a person
          // is looking at this page.
          const rejected = error?.message === "CONTROL_PLANE_REJECTED" && error.statusCode === 401;
          return launchRefused(res, rejected ? 401 : 503);
        }
      }
      if (suffix === "/__signed_out" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": `default-src 'none'; frame-ancestors 'none'` });
        return res.end("<!doctype html><title>Signed out</title><p>You have signed out of this trip. Return to your personal space to open it again.</p>");
      }
      if (suffix === "/__logout" && req.method === "POST") {
        if (req.headers["x-kinerary-logout"] !== "1" || (req.headers.origin && req.headers.origin !== RUNTIME_ORIGIN)) {
          return json(res, 403, { error: "ORIGIN_REJECTED" });
        }
        res.setHeader("set-cookie", `${cookieName(tripId)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookie ? "; Secure" : ""}`);
        return json(res, 200, { portalUrl: PORTAL_ORIGIN });
      }
      // The organizers' claims hop. Any other method on these paths is not proxied to the trip site with a session on it.
      if (suffix === "/__member-claims" || suffix.startsWith("/__member-claims/")) {
        const target = suffix.match(/^\/__member-claims(?:\/([^/]+))?$/);
        let claimId = null;
        try { claimId = target?.[1] ? decodeURIComponent(target[1]) : null; } catch { return json(res, 404, { error: "NOT_FOUND" }); }
        if (target && ((req.method === "GET" && !target[1]) || (req.method === "DELETE" && target[1]))) return await memberClaims(req, res, tripId, claimId);
        return json(res, 404, { error: "NOT_FOUND" });
      }
      // The organizers' personal-invite hop; same rule: other methods and shapes are never proxied to the trip site with a session on them.
      if (suffix === "/__member-invites" || suffix.startsWith("/__member-invites/")) {
        const target = suffix.match(/^\/__member-invites(?:\/([^/]+))?$/);
        let username = null;
        try { username = target?.[1] ? decodeURIComponent(target[1]) : null; } catch { return json(res, 404, { error: "NOT_FOUND" }); }
        if (target && ((req.method === "GET" && !target[1]) || (req.method === "POST" && target[1]))) return await memberInvites(req, res, tripId, username);
        return json(res, 404, { error: "NOT_FOUND" });
      }
      // Internal identity endpoints are exclusively server-to-server.
      if (isInternalPath(suffix)) return json(res, 404, { error: "NOT_FOUND" });

      let session = decodeSession(cookieValue(req, cookieName(tripId)));
      if (session && session.tripId !== tripId) session = null;
      // A sealed cookie is not enough: the portal must still consider this
      // person signed in and entitled to the trip (logout, removal, disabling).
      if (session && !(await sessionLive(session))) session = null;
      if (!session) {
        // A page navigation without a session goes to the portal, which signs
        // the person in if needed and posts a fresh grant back. The target is
        // fixed: no route lookup first, no query or return path reflected, so
        // existing and nonexistent trips answer identically.
        if (req.method === "GET" && wantsPage(req)) {
          res.writeHead(303, { location: `${PORTAL_ORIGIN}/trips/${tripId}/app`, "cache-control": "no-store", "referrer-policy": "no-referrer" });
          return res.end();
        }
        return json(res, 401, { error: "AUTHENTICATION_REQUIRED" });
      }
      return await proxy(req, res, tripId, suffix, session);
    } catch (error) {
      // A rejected/expired launch grant is an authentication failure. It is
      // not evidence that the runtime is unavailable.
      const controlPlaneError = error && typeof error === "object" ? error : {};
      if (controlPlaneError.message === "CONTROL_PLANE_REJECTED" && controlPlaneError.statusCode === 401) {
        return json(res, 401, { error: "LAUNCH_INVALID" });
      }
      return json(res, 503, { error: "RUNTIME_UNAVAILABLE" });
    }
  });
}

if (process.env.NODE_ENV !== "test") createRuntimeGateway().listen(PORT, BIND_HOST, () => console.log(`Runtime gateway listening on ${BIND_HOST}:${PORT}`));
