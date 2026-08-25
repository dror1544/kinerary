import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
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

async function readJson(req, limit = 32_768) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
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
  if (!response.ok) throw new Error("CONTROL_PLANE_REJECTED");
  return response.json();
}

async function routeFor(tripId) {
  const cached = routeCache.get(tripId);
  if (cached?.expiresAt > Date.now()) return cached.route;
  const route = await controlPlane(`/internal/runtime-routes/${encodeURIComponent(tripId)}`);
  routeCache.set(tripId, { route, expiresAt: Date.now() + 30_000 });
  return route;
}

function bootstrap(tripId) {
  const origin = JSON.stringify(PORTAL_ORIGIN);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Opening Kinerary</title></head><body><p>Opening your trip…</p><script>
  const portalOrigin=${origin};
  addEventListener('message',async(event)=>{
    if(event.origin!==portalOrigin||event.source!==parent||event.data?.type!=='kinerary:launch'||typeof event.data.token!=='string')return;
    const response=await fetch(location.pathname.replace(/\\/$/,'')+'/__launch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:event.data.token})});
    if(response.ok)location.reload();else document.body.textContent='This trip could not be opened.';
  });
  parent.postMessage({type:'kinerary:runtime-ready'},portalOrigin);
  </script></body></html>`;
}

async function launch(req, res, tripId) {
  const { token } = await readJson(req);
  if (typeof token !== "string" || token.length > 256) return json(res, 400, { error: "INVALID_REQUEST" });
  const grant = await controlPlane("/internal/runtime-launch/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  if (grant.tripId !== tripId || grant.audience !== "runtime_gateway") return json(res, 401, { error: "LAUNCH_INVALID" });
  const route = await routeFor(tripId);
  const sessionResponse = await fetch(`${route.upstreamOrigin}${route.upstreamBasePath}/api/internal/control-plane/session`, {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": EXCHANGE_KEY },
    body: JSON.stringify({ userId: grant.userId, role: grant.role, runtimeUsername: grant.runtimeUsername }),
  });
  if (!sessionResponse.ok) return json(res, 503, { error: "RUNTIME_SESSION_FAILED" });
  const runtime = await sessionResponse.json();
  if (typeof runtime.token !== "string") return json(res, 503, { error: "RUNTIME_SESSION_FAILED" });
  const value = encodeSession({ tripId, token: runtime.token, exp: Date.now() + 12 * 60 * 60 * 1000 });
  const attributes = [`kit_runtime=${encodeURIComponent(value)}`, `Path=/t/${tripId}/`, "HttpOnly", "SameSite=Lax", "Max-Age=43200"];
  if (secureCookie) attributes.push("Secure");
  res.writeHead(204, { "set-cookie": attributes.join("; "), "cache-control": "no-store" });
  res.end();
}

async function provisionParticipant(req, res, tripId) {
  if (req.headers["x-api-key"] !== EXCHANGE_KEY) return json(res, 401, { error: "AUTHENTICATION_REQUIRED" });
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
    if (typeof responseHeaders.location === "string" && responseHeaders.location.startsWith("/")) responseHeaders.location = `/t/${tripId}${responseHeaders.location}`;
    res.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
    upstreamResponse.pipe(res);
  });
  upstream.on("error", () => { if (!res.headersSent) json(res, 502, { error: "RUNTIME_UNAVAILABLE" }); else res.destroy(); });
  req.pipe(upstream);
}

export function createRuntimeGateway() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, RUNTIME_ORIGIN);
      if (url.pathname === "/health") return json(res, 200, { ok: true });
      const internal = url.pathname.match(/^\/internal\/t\/([^/]+)\/participants$/);
      if (internal && req.method === "POST") return await provisionParticipant(req, res, decodeURIComponent(internal[1]));
      const match = url.pathname.match(/^\/t\/([^/]+)(\/.*)?$/);
      if (!match) return json(res, 404, { error: "NOT_FOUND" });
      const tripId = decodeURIComponent(match[1]);
      if (!/^trip_[A-Za-z0-9]{8,64}$/.test(tripId)) return json(res, 404, { error: "NOT_FOUND" });
      const suffix = match[2] || "/";
      if (suffix === "/__launch" && req.method === "POST") return await launch(req, res, tripId);
      const session = decodeSession(cookieValue(req, "kit_runtime"));
      if (!session || session.tripId !== tripId) {
        if (req.method !== "GET" || suffix !== "/") return json(res, 401, { error: "AUTHENTICATION_REQUIRED" });
        const html = Buffer.from(bootstrap(tripId));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": html.length, "cache-control": "no-store", "content-security-policy": `default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors ${PORTAL_ORIGIN}` });
        return res.end(html);
      }
      return await proxy(req, res, tripId, suffix, session);
    } catch {
      return json(res, 503, { error: "RUNTIME_UNAVAILABLE" });
    }
  });
}

if (process.env.NODE_ENV !== "test") createRuntimeGateway().listen(PORT, BIND_HOST, () => console.log(`Runtime gateway listening on ${BIND_HOST}:${PORT}`));
