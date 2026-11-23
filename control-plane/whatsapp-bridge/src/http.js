/**
 * The bridge's HTTP surface — exactly the endpoints of spec 625's table:
 *
 *   GET  /health
 *   GET  /messages?after=&epoch=&waitMs=
 *   GET  /media/:chatId/:messageId[?maxBytes=]
 *   POST /send    { chatId, text, replyTo?, mentions? }
 *   POST /edit    { chatId, messageId, text }
 *   POST /typing  { chatId, state? }
 *   GET  /chat/:id
 *   GET  /chat/:id/participant/:participantId
 *
 * Every request needs the bearer secret, checked before anything else — an
 * unauthenticated caller cannot tell a real path from a made-up one. The
 * listener binds loopback only; the host is not a parameter.
 *
 * Ids contain `@` and `-`, so they travel percent-encoded in the path.
 */
import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";

export const LOOPBACK_HOST = "127.0.0.1";
const MAX_BODY = 64 * 1024;
const MIN_SECRET = 32;

export function validateSecret(secret) {
  if (typeof secret !== "string" || secret.length < MIN_SECRET) {
    throw new Error(`bridge secret must be at least ${MIN_SECRET} characters`);
  }
  if (/\s/.test(secret)) throw new Error("bridge secret must not contain whitespace");
  return secret;
}

/** Constant-time compare of the presented bearer against the secret. */
function bearerOk(header, secret) {
  if (typeof header !== "string") return false;
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return false;
  const a = createHash("sha256").update(match[1]).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

function send(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    return parsed;
  } catch {
    throw Object.assign(new Error("bad json"), { status: 400 });
  }
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * @param {ReturnType<typeof import("./core.js").createBridge>} bridge
 * @param {{ secret: string, log: (event: string, fields?: object) => void }} options
 */
export function createBridgeServer(bridge, { secret, log }) {
  validateSecret(secret);
  const server = createServer(async (req, res) => {
    try {
      if (!bearerOk(req.headers.authorization, secret)) {
        return send(res, 401, { ok: false, error: "unauthorized" });
      }
      // The path is split as written. `new URL` would resolve `..` segments into
      // another route before any id was checked.
      const target = req.url ?? "/";
      const queryAt = target.indexOf("?");
      const rawPath = queryAt === -1 ? target : target.slice(0, queryAt);
      const url = { searchParams: new URLSearchParams(queryAt === -1 ? "" : target.slice(queryAt + 1)) };
      const parts = rawPath.split("/").filter(Boolean).map(decodeSegment);
      if (parts.includes(null)) return send(res, 400, { ok: false, error: "bad_path" });
      const method = req.method ?? "GET";

      if (method === "GET" && parts.length === 1 && parts[0] === "health") {
        const out = bridge.health();
        return send(res, out.status, out.body);
      }
      if (method === "GET" && parts.length === 1 && parts[0] === "messages") {
        const afterRaw = url.searchParams.get("after");
        const after = afterRaw === null ? undefined : Number(afterRaw);
        if (after !== undefined && (!Number.isInteger(after) || after < 0)) {
          return send(res, 400, { ok: false, error: "bad_cursor" });
        }
        const ac = new AbortController();
        res.on("close", () => ac.abort());
        const out = await bridge.poll({
          after,
          epoch: url.searchParams.get("epoch") ?? undefined,
          waitMs: url.searchParams.get("waitMs") ?? 25_000,
          signal: ac.signal,
        });
        return send(res, out.status, out.body);
      }
      if (method === "GET" && parts.length === 3 && parts[0] === "media") {
        const out = await bridge.media(parts[1], parts[2], url.searchParams.get("maxBytes"));
        if (out.bytes) {
          res.writeHead(200, {
            "Content-Type": out.mime,
            "Content-Length": out.bytes.length,
            "Cache-Control": "no-store",
          });
          return res.end(out.bytes);
        }
        return send(res, out.status, out.body);
      }
      if (method === "POST" && parts.length === 1 && ["send", "edit", "typing"].includes(parts[0])) {
        const body = await readJson(req);
        const out = await bridge[parts[0]](body);
        return send(res, out.status, out.body);
      }
      if (method === "GET" && parts.length === 2 && parts[0] === "chat") {
        const out = await bridge.chatInfo(parts[1]);
        return send(res, out.status, out.body);
      }
      if (method === "GET" && parts.length === 4 && parts[0] === "chat" && parts[2] === "participant") {
        const out = await bridge.participant(parts[1], parts[3]);
        return send(res, out.status, out.body);
      }
      return send(res, 404, { ok: false, error: "not_found" });
    } catch (err) {
      const status = err?.status === 413 ? 413 : err?.status === 400 ? 400 : 500;
      if (status === 500) log("request_failed", { code: "internal" });
      return send(res, status, { ok: false, error: status === 500 ? "internal" : status === 413 ? "too_large" : "bad_request" });
    }
  });
  // Long-polls hold a request open; the default 5-minute request timeout is fine,
  // but never let a slow client pin sockets forever.
  server.headersTimeout = 10_000;
  server.requestTimeout = 120_000;
  return {
    server,
    /** Binds loopback only. `port` 0 picks a free one. */
    listen(port) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, LOOPBACK_HOST, () => {
          server.off("error", reject);
          resolve(server.address());
        });
      });
    },
    close() {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
