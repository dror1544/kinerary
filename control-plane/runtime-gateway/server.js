import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import https from "node:https";

const PORT = Number(process.env.PORT || 4320);
const BIND_HOST = process.env.BIND_HOST || "127.0.0.1";
const CONTROL_PLANE_ORIGIN = required("CONTROL_PLANE_INTERNAL_ORIGIN").replace(/\/$/, "");
const EXCHANGE_KEY = required("RUNTIME_EXCHANGE_KEY");
// Per-trip exchange keys (docs/runtime-session-exchange.md, "Per-trip keys"). EXCHANGE_KEY is the
// control-plane key: it authenticates this gateway to the control plane and the control plane (and the
// worker's tools) to this gateway's own /internal/t/* routes, and nothing else. What a TRIP SITE is sent
// is a separate key per trip. OFF unless RUNTIME_TRIP_KEY_MASTER is set: unset, every trip is sent
// EXCHANGE_KEY, as before.
const TRIP_KEY_MASTER = process.env.RUNTIME_TRIP_KEY_MASTER || "";
const LEGACY_TRIP_KEY = process.env.RUNTIME_LEGACY_TRIP_KEY || "";
if (!TRIP_KEY_MASTER && LEGACY_TRIP_KEY) {
  // A legacy key with no master is a half-made change of keys, and nothing else would say so.
  console.error("runtime_gateway.trip_keys_off: RUNTIME_LEGACY_TRIP_KEY is set but RUNTIME_TRIP_KEY_MASTER is not; every trip is sent RUNTIME_EXCHANGE_KEY");
}
// With per-trip keys on, the three secrets must be three different values. A legacy key equal to the
// control-plane key leaves every legacy trip holding a credential the control plane and this gateway's own
// /internal/t/* routes accept, which is the exposure per-trip keys exist to end; a master equal to either
// would make every derived key a function of a key that is already shared. The rollout is therefore a
// ROTATION: the current key becomes the legacy key and a NEW exchange key goes to the API and this gateway
// (docs/runtime-session-exchange.md, "Rolling it out"). Refused at start, naming variables, never a value.
if (TRIP_KEY_MASTER) {
  const held = [["RUNTIME_EXCHANGE_KEY", EXCHANGE_KEY], ["RUNTIME_TRIP_KEY_MASTER", TRIP_KEY_MASTER], ["RUNTIME_LEGACY_TRIP_KEY", LEGACY_TRIP_KEY]].filter(([, value]) => value);
  const equal = [];
  for (let i = 0; i < held.length; i += 1) for (let j = i + 1; j < held.length; j += 1) if (held[i][1] === held[j][1]) equal.push(`${held[i][0]} and ${held[j][0]}`);
  if (equal.length) {
    const message = `${equal.join("; ")} hold the same value; with RUNTIME_TRIP_KEY_MASTER set the three must all differ (rotate RUNTIME_EXCHANGE_KEY: the current value becomes RUNTIME_LEGACY_TRIP_KEY and a new one goes to the API and the gateway)`;
    console.error(`runtime_gateway.trip_keys_not_distinct: ${message}`);
    throw new Error(message);
  }
}
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
    const error = Object.assign(new Error("CONTROL_PLANE_REJECTED"), { statusCode: response.status });
    throw error;
  }
  return response.json();
}

// derive(master, trip_id) = hex(HMAC-SHA256(master, "kinerary-trip-exchange:v1:" + trip_id)). The worker
// computes the same value into a new trip's .env (test/fixtures/trip-key-vectors.json is read by both tests).
export function deriveTripKey(master, tripId) {
  return createHmac("sha256", master).update(`kinerary-trip-exchange:v1:${tripId}`).digest("hex");
}

// The key to send to ONE trip site, chosen by what the control plane recorded for that trip's route
// (`tripKey`), never by anything the client sent and never by what the trip answered. `tripId` is the id the
// route was looked up for. A trip that holds a key other than the one chosen answers 401 and that is the
// end of it: no second key is tried, so a trip cannot be made to ask for the legacy key.
// With a master set, anything but "derived" or "shared" (a kind this gateway does not know, or an older
// control plane that does not say) is refused rather than guessed, and so is a "shared" trip when there is
// no legacy key to send. Nothing is sent in any of those cases.
function tripKeyFor(tripId, route) {
  if (!TRIP_KEY_MASTER) return EXCHANGE_KEY;
  let reason;
  if (route?.tripKey === "derived") return deriveTripKey(TRIP_KEY_MASTER, tripId);
  if (route?.tripKey === "shared") {
    if (LEGACY_TRIP_KEY) return LEGACY_TRIP_KEY;
    reason = "shared_trip_no_legacy_key";
  } else reason = "route_key_kind_unknown";
  console.error(`runtime_gateway.trip_key_unavailable: trip=${tripId} reason=${reason}`);
  throw Object.assign(new Error("TRIP_KEY_UNAVAILABLE"), { statusCode: 503 });
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
    method: "POST", headers: { "content-type": "application/json", "x-api-key": tripKeyFor(tripId, route) },
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
    method: "POST", headers: { "content-type": "application/json", "x-api-key": tripKeyFor(tripId, route) }, body: JSON.stringify(body),
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
    method: "GET", headers: { "x-api-key": tripKeyFor(tripId, route), "x-control-plane-trip-id": tripId },
  });
  const payload = await response.text();
  res.writeHead(response.status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(payload);
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

// ---------------------------------------------------------------------------
// Host mode (docs/runtime-session-exchange.md, "Host mode"; spec
// docs/specs/sprint-9/x-wildcard-host-and-shared-bridge.md, R1).
//
// One wildcard name points at this gateway and the Host header picks the trip:
// <label>.<TRIP_HOST_SUFFIX> is looked up in the control plane's registry
// (GET /internal/runtime-routes/by-host/:host) and proxied, transparently, to
// the upstream the registry holds for that exact name. Each trip is its own
// origin, so Cookie, Authorization and Set-Cookie pass straight through: the
// session cookie and launch flow above are not involved.
//
// OFF unless TRIP_HOST_SUFFIX is set. Unset, none of this code runs.
// ---------------------------------------------------------------------------
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TRIP_HOST_SUFFIX = (() => {
  const raw = String(process.env.TRIP_HOST_SUFFIX ?? "").trim().toLowerCase().replace(/^\./, "");
  if (!raw) return "";
  // A malformed suffix is a configuration error, not a reason to quietly route nothing.
  if (raw.length > 200 || !raw.split(".").every((label) => DNS_LABEL.test(label))) throw new Error("TRIP_HOST_SUFFIX must be a lowercase DNS name such as trips.example.org");
  return raw;
})();
const RUNTIME_HOSTNAME = new URL(RUNTIME_ORIGIN).hostname.toLowerCase();
const HOST_HIT_TTL_MS = 30_000;
const HOST_MISS_TTL_MS = 5_000;
const HOST_CACHE_MAX = 2000;
// Once the whole request has been sent, how long the upstream may stay silent
// before the answer is 502. Not a bound on uploads or streams: it starts at the
// end of the request body and stops at the first response byte.
const HOST_RESPONSE_TIMEOUT_MS = Math.max(50, Number(process.env.TRIP_HOST_RESPONSE_TIMEOUT_MS ?? 120_000) || 120_000);
const hostRouteCache = new Map(); // host -> { route | null, expiresAt }
const hostLookupsInFlight = new Map();
// A fresh connection per request: a stale pooled socket would turn a photo upload into a 502.
const hostHttpAgent = new http.Agent({ keepAlive: false });
const hostHttpsAgent = new https.Agent({ keepAlive: false });
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

// null: not a host-mode request (today's handling). { valid: false }: under the
// suffix but cannot be a trip (the bare suffix, a deeper name, not a DNS label).
function hostModeFor(req) {
  if (!TRIP_HOST_SUFFIX) return null;
  const header = String(req.headers.host ?? "").toLowerCase();
  if (!header || header.startsWith("[")) return null;
  const name = header.replace(/:\d*$/, "");
  if (name === RUNTIME_HOSTNAME) return null;
  if (name === TRIP_HOST_SUFFIX) return { valid: false };
  if (!name.endsWith(`.${TRIP_HOST_SUFFIX}`)) return null;
  const label = name.slice(0, -(TRIP_HOST_SUFFIX.length + 1));
  return DNS_LABEL.test(label) ? { valid: true, host: name } : { valid: false };
}

// The same small page for every name that is not a ready trip, so the gateway is
// no oracle for which trips exist. Nothing the client sent is reflected.
const HOST_NOT_FOUND_BODY = Buffer.from('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Not found</title></head><body><p>There is nothing here.</p></body></html>');
function hostNotFound(res) {
  res.writeHead(404, { "content-type": "text/html; charset=utf-8", "content-length": HOST_NOT_FOUND_BODY.length, "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" });
  res.end(HOST_NOT_FOUND_BODY);
}

// Is this request target under /api/internal/, however it is spelled? Express
// (the trip site) matches case-insensitively and decodes percent-escapes, and a
// proxy in front may collapse "//" and resolve dots, so every one of those is
// applied here before looking. Returns "unreadable" for what cannot be decoded.
function internalApiPath(target) {
  const cut = target.search(/[?#]/);
  let path = cut === -1 ? target : target.slice(0, cut);
  let settled = false;
  for (let round = 0; round < 4 && !settled; round += 1) {
    let decoded;
    // Only the first round can be unreadable. A later round failing means the
    // path held an encoded "%" (a file called 100%.jpg), which is a real path.
    try { decoded = decodeURIComponent(path); } catch { if (round === 0) return "unreadable"; settled = true; break; }
    settled = decoded === path;
    path = decoded;
  }
  if (!settled) return "unreadable";
  const segments = [];
  for (const raw of path.replace(/\\/g, "/").split("/")) {
    const segment = raw.split(";")[0].toLowerCase();
    if (segment === "" || segment === ".") continue;
    if (segment === "..") { segments.pop(); continue; }
    segments.push(segment);
  }
  return segments[0] === "api" && segments[1] === "internal";
}

function hostRouteFromBody(body) {
  const origin = body?.upstreamOrigin;
  if (typeof origin !== "string" || typeof body?.tripId !== "string") return null;
  let url;
  try { url = new URL(origin); } catch { return null; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
  return { tripId: body.tripId, upstreamOrigin: url.origin };
}

async function lookUpHost(host) {
  let response;
  try {
    response = await timedFetch(`${CONTROL_PLANE_ORIGIN}/internal/runtime-routes/by-host/${encodeURIComponent(host)}`, { headers: { "x-api-key": EXCHANGE_KEY } });
  } catch { throw Object.assign(new Error("HOST_LOOKUP_UNAVAILABLE"), { statusCode: 503 }); }
  if (response.status === 404) { await response.body?.cancel(); return null; }
  if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error("HOST_LOOKUP_UNAVAILABLE"), { statusCode: 503 }); }
  let body;
  try { body = await response.json(); } catch { throw Object.assign(new Error("HOST_LOOKUP_UNAVAILABLE"), { statusCode: 503 }); }
  const route = hostRouteFromBody(body);
  if (!route) throw Object.assign(new Error("HOST_ROUTE_INVALID"), { statusCode: 502 });
  return route;
}

// A route, or null for "no ready route for this name". Throws with a statusCode
// when the registry cannot be asked or answered nonsense; that is never cached.
async function hostRouteFor(host) {
  const cached = hostRouteCache.get(host);
  if (cached && cached.expiresAt > Date.now()) return cached.route;
  let pending = hostLookupsInFlight.get(host);
  if (!pending) {
    pending = lookUpHost(host).then((route) => {
      hostRouteCache.delete(host);
      hostRouteCache.set(host, { route, expiresAt: Date.now() + (route ? HOST_HIT_TTL_MS : HOST_MISS_TTL_MS) });
      if (hostRouteCache.size > HOST_CACHE_MAX) {
        for (const [key, entry] of hostRouteCache) if (entry.expiresAt <= Date.now()) hostRouteCache.delete(key);
        for (const key of hostRouteCache.keys()) { if (hostRouteCache.size <= HOST_CACHE_MAX) break; hostRouteCache.delete(key); }
      }
      return route;
    }).finally(() => hostLookupsInFlight.delete(host));
    hostLookupsInFlight.set(host, pending);
  }
  return pending;
}

function hostFailure(res, status) {
  if (res.headersSent) return res.destroy();
  const data = Buffer.from(JSON.stringify({ error: "RUNTIME_UNAVAILABLE" }));
  // Close the connection: the request body may be unread, and it is not worth draining.
  res.writeHead(status, { "content-type": "application/json", "content-length": data.length, "cache-control": "no-store", connection: "close" });
  res.end(data);
}

function proxyToHost(req, res, host, route) {
  const origin = new URL(route.upstreamOrigin);
  const headers = {};
  const named = String(req.headers.connection ?? "").toLowerCase().split(",").map((token) => token.trim()).filter(Boolean);
  for (const [name, value] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(name) && !named.includes(name)) headers[name] = value;
  delete headers["x-forwarded-prefix"];
  headers.host = req.headers.host; // unchanged: the trip sees the name the browser used
  headers["x-forwarded-host"] = req.headers.host;
  // The scheme of the public side. A client's own X-Forwarded-Proto is never believed.
  headers["x-forwarded-proto"] = secureCookie ? "https" : "http";
  const peer = req.socket.remoteAddress ?? "";
  headers["x-forwarded-for"] = [req.headers["x-forwarded-for"], peer].filter(Boolean).join(", ");
  const secure = origin.protocol === "https:";
  const upstream = (secure ? https : http).request({ protocol: origin.protocol, hostname: origin.hostname, port: origin.port || undefined, method: req.method, path: req.url, headers, agent: secure ? hostHttpsAgent : hostHttpAgent });
  let connectTimer = null, responseTimer = null;
  const clearTimers = () => { clearTimeout(connectTimer); clearTimeout(responseTimer); };
  upstream.on("socket", (socket) => {
    if (!socket.connecting) return;
    connectTimer = setTimeout(() => upstream.destroy(new Error("UPSTREAM_CONNECT_TIMEOUT")), UPSTREAM_TIMEOUT_MS);
    socket.once("connect", () => clearTimeout(connectTimer));
  });
  upstream.on("finish", () => { responseTimer = setTimeout(() => upstream.destroy(new Error("UPSTREAM_RESPONSE_TIMEOUT")), HOST_RESPONSE_TIMEOUT_MS); });
  upstream.on("response", (upstreamResponse) => {
    clearTimers();
    const out = {};
    const hopNamed = String(upstreamResponse.headers.connection ?? "").toLowerCase().split(",").map((token) => token.trim()).filter(Boolean);
    for (const [name, value] of Object.entries(upstreamResponse.headers)) if (!HOP_BY_HOP.has(name) && !hopNamed.includes(name)) out[name] = value;
    res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.statusMessage, out);
    upstreamResponse.pipe(res);
    upstreamResponse.on("error", () => res.destroy());
    upstreamResponse.on("close", () => { if (!upstreamResponse.complete) res.destroy(); });
  });
  upstream.on("error", () => { clearTimers(); console.error(`runtime_gateway.host_upstream_unavailable: host=${host}`); hostFailure(res, 502); });
  // A closed browser must release the upstream, whether it was uploading or holding a stream open.
  res.on("close", () => { clearTimers(); upstream.destroy(); });
  req.on("error", () => upstream.destroy());
  req.pipe(upstream);
}

async function handleHostMode(req, res, mode) {
  if (!mode.valid) return hostNotFound(res);
  if (typeof req.url !== "string" || !req.url.startsWith("/")) return json(res, 400, { error: "BAD_REQUEST" });
  // Before any lookup, so a known trip and an unknown name answer identically.
  const internal = internalApiPath(req.url);
  if (internal === "unreadable") return json(res, 400, { error: "BAD_REQUEST" });
  if (internal) return hostNotFound(res);
  let route;
  try { route = await hostRouteFor(mode.host); }
  catch (error) {
    console.error(`runtime_gateway.host_lookup_failed: host=${mode.host} status=${error?.statusCode ?? 503}`);
    return hostFailure(res, error?.statusCode === 502 ? 502 : 503);
  }
  if (!route) return hostNotFound(res);
  return proxyToHost(req, res, mode.host, route);
}

export function createRuntimeGateway() {
  return http.createServer(async (req, res) => {
    try {
      const hostMode = hostModeFor(req);
      if (hostMode) return await handleHostMode(req, res, hostMode);
      const url = new URL(req.url, RUNTIME_ORIGIN);
      if (url.pathname === "/health") return json(res, 200, { ok: true });
      const internal = url.pathname.match(/^\/internal\/t\/([^/]+)\/participants$/);
      if (internal && req.method === "POST") return await provisionParticipant(req, res, decodeURIComponent(internal[1]));
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
      // Internal identity endpoints are exclusively server-to-server.
      if (suffix.startsWith("/api/internal/")) return json(res, 404, { error: "NOT_FOUND" });

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
