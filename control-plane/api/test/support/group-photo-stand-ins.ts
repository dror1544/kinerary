import { createServer, type IncomingMessage, type Server } from "node:http";

/**
 * Stand-ins for the three things the group photo talks to (docs/specs/sprint-9/x-trip-group-photo.md):
 *   - FakeTelegram: the Bot API's `getMe`, `getChatMember` and `setChatPhoto`, recording every call. A test sets what each
 *     chat says the bot is, and what setChatPhoto answers. The multipart upload is parsed, so a test can say what bytes
 *     arrived for which chat.
 *   - StubPhotoSite: a trip's site, answering the claim and result routes with whatever the test queued, and recording the
 *     key and body it was sent.
 *   - startPhotoGateway: the runtime gateway's two routes (runtime-gateway/server.js groupPhoto), which check the caller's
 *     control-plane key and forward to the site with THAT TRIP'S key and a body built from the path's trip id.
 */

export const BOT_ID = 7_000_000_001;
export const BOT_TOKEN = "123456:test-token-not-a-real-one";

/** A valid 1x1 PNG: the dispatcher checks the signature before it will call Telegram. */
export const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export type Member = { status: string; can_change_info?: unknown } | { error: number; description: string };

export interface FakeTelegramCall {
  method: string;
  chatId: string | null;
  userId: number | null;
  /** The uploaded file, for setChatPhoto. */
  photo: Buffer | null;
  photoName: string | null;
}

export interface FakeTelegram {
  /** http://127.0.0.1:<port>: the adapter's `apiRoot`. */
  root: string;
  calls: FakeTelegramCall[];
  /** What each chat says the bot is. A chat not listed is "chat not found" (400). */
  members: Map<string, Member>;
  /** What setChatPhoto answers instead of ok (a rate limit, a rejected photo). */
  photoError: { status: number; description: string } | null;
  count(method: string): number;
  close(): Promise<void>;
}

const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export async function startFakeTelegram(): Promise<FakeTelegram> {
  const fake: FakeTelegram = {
    root: "",
    calls: [],
    members: new Map(),
    photoError: null,
    count: (method) => fake.calls.filter((c) => c.method === method).length,
    close: async () => { await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }); },
  };
  const server: Server = createServer(async (req, res) => {
    const match = (req.url ?? "").match(/^\/bot([^/]+)\/([A-Za-z]+)$/);
    if (!match || match[1] !== BOT_TOKEN) return json(res, 401, { ok: false, error_code: 401, description: "Unauthorized" });
    const method = match[2]!;
    const raw = await readBody(req);
    const type = String(req.headers["content-type"] ?? "");
    const call: FakeTelegramCall = { method, chatId: null, userId: null, photo: null, photoName: null };
    if (type.startsWith("multipart/form-data")) {
      const form = await new Response(raw, { headers: { "content-type": type } }).formData();
      call.chatId = String(form.get("chat_id") ?? "");
      const file = form.get("photo");
      if (file && typeof file !== "string") { call.photo = Buffer.from(await file.arrayBuffer()); call.photoName = file.name; }
    } else if (raw.length) {
      const body = JSON.parse(raw.toString("utf8")) as { chat_id?: unknown; user_id?: unknown };
      call.chatId = body.chat_id === undefined ? null : String(body.chat_id);
      call.userId = typeof body.user_id === "number" ? body.user_id : null;
    }
    fake.calls.push(call);
    if (method === "getMe") return json(res, 200, { ok: true, result: { id: BOT_ID, is_bot: true, first_name: "Kinerary", username: "Kinerary_bot" } });
    if (method === "getChatMember") {
      const member = fake.members.get(call.chatId ?? "");
      if (!member) return json(res, 400, { ok: false, error_code: 400, description: "Bad Request: chat not found" });
      if ("error" in member) return json(res, member.error, { ok: false, error_code: member.error, description: member.description });
      if (call.userId !== BOT_ID) return json(res, 400, { ok: false, error_code: 400, description: "Bad Request: user not found" });
      return json(res, 200, { ok: true, result: { user: { id: BOT_ID, is_bot: true }, ...member } });
    }
    if (method === "setChatPhoto") {
      if (fake.photoError) return json(res, fake.photoError.status, { ok: false, error_code: fake.photoError.status, description: fake.photoError.description });
      return json(res, 200, { ok: true, result: true });
    }
    return json(res, 404, { ok: false, error_code: 404, description: "Not Found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  fake.root = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return fake;
}

export interface SiteRequest { url: string; apiKey: string | undefined; body: Record<string, unknown> }

export interface StubPhotoSite {
  /** http://localhost:<port> */
  origin: string;
  /** What the next claims answer, one per claim; once empty, `{ request: null }`. */
  claimAnswers: Array<Record<string, unknown>>;
  claims: SiteRequest[];
  results: SiteRequest[];
  /** The status the result route answers (200 by default). */
  resultStatus: number;
  close(): Promise<void>;
}

export async function startStubPhotoSite(): Promise<StubPhotoSite> {
  const site: StubPhotoSite = {
    origin: "", claimAnswers: [], claims: [], results: [], resultStatus: 200,
    close: async () => { await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }); },
  };
  const server: Server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const entry: SiteRequest = { url: req.url ?? "", apiKey: req.headers["x-api-key"] as string | undefined, body: raw.length ? JSON.parse(raw.toString("utf8")) : {} };
    if (entry.url === "/api/internal/control-plane/group-photo/claim") {
      site.claims.push(entry);
      return json(res, 200, site.claimAnswers.shift() ?? { request: null });
    }
    if (entry.url === "/api/internal/control-plane/group-photo/result") {
      site.results.push(entry);
      return json(res, site.resultStatus, site.resultStatus === 200 ? { ok: true } : { error: "x" });
    }
    return json(res, 404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const address = server.address();
  site.origin = `http://localhost:${typeof address === "object" && address ? address.port : 0}`;
  return site;
}

export interface PhotoGateway {
  origin: string;
  /** Every request: the path and the key it carried. */
  requests: Array<{ url: string; apiKey: string | undefined }>;
  /** Answer the result route with a 503 (the road back is down). */
  failResults: boolean;
  close(): Promise<void>;
}

export async function startPhotoGateway(callerKey: string, siteOrigin: () => string, tripKey: (tripId: string) => string): Promise<PhotoGateway> {
  const gateway: PhotoGateway = {
    origin: "", requests: [], failResults: false,
    close: async () => { await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }); },
  };
  const server: Server = createServer(async (req, res) => {
    const apiKey = req.headers["x-api-key"] as string | undefined;
    gateway.requests.push({ url: req.url ?? "", apiKey });
    const match = (req.url ?? "").match(/^\/internal\/t\/([^/]+)\/group-photo\/(claim|result)$/);
    if (apiKey !== callerKey) return json(res, 401, { error: "AUTHENTICATION_REQUIRED" });
    if (!match || req.method !== "POST") return json(res, 404, { error: "NOT_FOUND" });
    const tripId = decodeURIComponent(match[1]!);
    const action = match[2]!;
    const given = JSON.parse((await readBody(req)).toString("utf8") || "{}") as Record<string, unknown>;
    if (action === "result" && gateway.failResults) return json(res, 503, { error: "RUNTIME_UNAVAILABLE" });
    try {
      const upstream = await fetch(`${siteOrigin()}/api/internal/control-plane/group-photo/${action}`, {
        method: "POST",
        headers: { "x-api-key": tripKey(tripId), "content-type": "application/json" },
        body: JSON.stringify(action === "result" ? { tripId, request_id: given.request_id, claim_token: given.claim_token, status: given.status, detail: given.detail ?? null } : { tripId }),
        redirect: "manual",
      });
      res.writeHead(upstream.status, { "content-type": "application/json" });
      res.end(await upstream.text());
    } catch {
      json(res, 503, { error: "RUNTIME_UNAVAILABLE" });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  gateway.origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return gateway;
}
