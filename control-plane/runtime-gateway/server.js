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
  const response = await fetch(`${CONTROL_PLANE_ORIGIN}${path}`, { ...init, headers: { ...init.headers, "x-api-key": EXCHANGE_KEY } });
  if (!response.ok) {
    const error = Object.assign(new Error("CONTROL_PLANE_REJECTED"), { statusCode: response.status });
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
// is asked again (at most every 30 s per person and trip) so that signing out of
// the portal, removing someone from the trip or disabling them ends the trip
// session too. A positive answer is cached, a negative one never is. When the
// control plane cannot be asked the answer is no: failing open here would turn
// an outage into a way to keep a revoked session.
const LIVE_FOR_MS = Math.max(0, Math.min(30_000, Number(process.env.RUNTIME_SESSION_CHECK_TTL_MS ?? 30_000) || 0));
const liveCache = new Map();
async function sessionLive(session) {
  if (typeof session.userId !== "string") return false;
  const key = `${session.tripId}:${session.userId}`;
  if ((liveCache.get(key) ?? 0) > Date.now()) return true;
  try {
    await controlPlane("/internal/runtime-sessions/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tripId: session.tripId, userId: session.userId }) });
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
  // trip validates it again before it will serve it to an owner or organizer.
  if (typeof grant.dashboardUrl === "string" && grant.dashboardUrl.length <= 2048) identity.dashboardUrl = grant.dashboardUrl;
  const sessionResponse = await fetch(`${route.upstreamOrigin}${route.upstreamBasePath}/api/internal/control-plane/session`, {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": EXCHANGE_KEY },
    body: JSON.stringify(identity),
  });
  if (!sessionResponse.ok) return launchRefused(res, [400, 401, 403].includes(sessionResponse.status) ? 401 : 503);
  const runtime = await sessionResponse.json();
  if (typeof runtime.token !== "string") return launchRefused(res, 503);
  const value = encodeSession({ tripId, userId: grant.userId, token: runtime.token, exp: Date.now() + 12 * 60 * 60 * 1000 });
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
  const response = await fetch(`${route.upstreamOrigin}${route.upstreamBasePath}/api/internal/control-plane/participants`, {
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
  const response = await fetch(`${route.upstreamOrigin}${route.upstreamBasePath}/api/internal/control-plane/participants/${encodeURIComponent(runtimeUsername)}`, {
    method: "GET", headers: { "x-api-key": EXCHANGE_KEY, "x-control-plane-trip-id": tripId },
  });
  const payload = await response.text();
  res.writeHead(response.status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(payload);
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
