/**
 * A stand-in for the WhatsApp bridge sidecar (control-plane/whatsapp-bridge), so
 * the relay's WhatsApp path can be tested and demonstrated with no WhatsApp
 * library, no number and no network. It speaks the bridge's HTTP contract
 * (spec 625, "Bridge sidecar and WhatsAppClient") and enforces the bridge's own
 * refusals:
 *
 *   - every request needs the bearer secret (401 otherwise, before any routing);
 *   - a `replyTo` quotes only a message of the SAME chat;
 *   - an `edit` changes only a message the number sent, in that chat;
 *   - media is served only for a recent message, and is 404 once the bounded
 *     store has dropped it;
 *   - `/chat/:id` returns a group's title and size, never participant ids;
 *   - membership has three answers: yes, no, and 503 "could not check".
 *
 * It never connects out: it binds 127.0.0.1 and nothing else.
 *
 * Two ways in:
 *
 *   node --import tsx tools/fake-whatsapp.ts --port 4398 --secret <16+ chars>
 *   const fake = await startFakeWhatsApp({ secret });   // in-process, for tests
 *
 * The control API (no bearer: it is the test's hand, not the relay's) scripts
 * what the bridge would deliver and records what the relay did:
 *
 *   POST /_control/message  {chatId, senderId?, senderName?, text?, messageId?, fromMe?, senderPhone?,
 *                            quotedMessageId?, quotedParticipant?, quotedText?, mentionedIds?,
 *                            media?: {kind, mime, filename?, base64}}      a message arrives
 *   POST /_control/added    {chatId, addedBy?, title?}                     the number is added to a group
 *   POST /_control/left     {chatId, participantId}                        a participant leaves
 *   POST /_control/title    {chatId, title}                                a group is renamed
 *   POST /_control/group    {chatId, title, participants: [lid...]}        set a group's membership
 *   POST /_control/person   {lid, phone}                                   a person's two ids, so a phone-form membership question matches
 *   POST /_control/state    {state}                                        connected | logged_out | ...
 *   POST /_control/fail     {path?, status?, hang?, times?}                make a path fail (500 by default), or hang
 *   POST /_control/membership-unavailable {on}                             "could not check"
 *   POST /_control/reset                                                    forget everything
 *   GET  /_control/sent                                                     what the relay sent, edited, typed
 *   GET  /_control/requests                                                 every request seen, with whether it was authorised
 *
 * Fixtures use obviously fake ids (`1000000000000NN@lid`).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { GROUP_REAL_ID, PERSON_REAL_ID, PHONE_REAL_ID } from "../src/relay/whatsapp/client.js";

export const FAKE_OWN = { lid: "100000000000099@lid", phone: "200000000099@s.whatsapp.net" };

interface StoredMessage {
  id: string;
  chatId: string;
  fromMe: boolean;
  media?: { mime: string; bytes: Buffer };
}

export interface RecordedCall {
  seq: number;
  kind: "send" | "edit" | "typing";
  chatId: string;
  messageId?: string;
  text?: string;
  replyTo?: string;
  quoted?: boolean;
  state?: string;
}

export interface FakeWhatsAppOptions {
  port?: number;
  secret: string;
  own?: { lid: string; phone: string };
  /** The bounded store of recent message handles (media, quoting, editing). */
  storeLimit?: number;
  /** The ring of undelivered events. */
  ringLimit?: number;
}

export interface FakeWhatsApp {
  url: string;
  port: number;
  secret: string;
  close(): Promise<void>;
  /** The same operations as /_control, for in-process tests. */
  control: {
    message(input: Record<string, unknown>): string;
    added(input: { chatId: string; addedBy?: string; title?: string }): void;
    left(input: { chatId: string; participantId: string }): void;
    title(input: { chatId: string; title: string }): void;
    group(input: { chatId: string; title: string; participants: string[] }): void;
    person(input: { lid: string; phone: string }): void;
    setState(state: string): void;
    failNext(input: { path?: string; status?: number; hang?: boolean; times?: number }): void;
    membershipUnavailable(on: boolean): void;
    reset(): void;
    sent(): RecordedCall[];
    requests(): { method: string; path: string; authorised: boolean }[];
  };
}

const TOKEN_STATES = new Set(["starting", "connecting", "connected", "disconnected", "logged_out", "replaced"]);

function bearerOk(header: string | undefined, secret: string): boolean {
  const match = typeof header === "string" ? /^Bearer (.+)$/.exec(header) : null;
  if (!match) return false;
  const a = createHash("sha256").update(match[1]!).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

async function readBody(req: IncomingMessage, max = 8 * 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw Object.assign(new Error("too large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    return parsed as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error("bad json"), { status: 400 });
  }
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": payload.length, "Cache-Control": "no-store" });
  res.end(payload);
}

const isChat = (id: string) => GROUP_REAL_ID.test(id) || PERSON_REAL_ID.test(id);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export async function startFakeWhatsApp(options: FakeWhatsAppOptions): Promise<FakeWhatsApp> {
  if (typeof options.secret !== "string" || options.secret.length < 16) {
    throw new Error("the stand-in needs a secret of at least 16 characters, as the bridge does");
  }
  const secret = options.secret;
  const own = options.own ?? FAKE_OWN;
  const storeLimit = options.storeLimit ?? 512;
  const ringLimit = options.ringLimit ?? 500;
  const epoch = randomBytes(6).toString("hex");

  let state = "connected";
  let nextSeq = 1;
  let ring: (Record<string, unknown> & { seq: number })[] = [];
  const waiters = new Set<() => void>();
  const store = new Map<string, StoredMessage>();
  const groups = new Map<string, { title: string; participants: Set<string> }>();
  const lidByPhone = new Map<string, string>();
  let calls: RecordedCall[] = [];
  let callSeq = 0;
  let requestLog: { method: string; path: string; authorised: boolean }[] = [];
  let membershipDown = false;
  let failures: { path?: string; status: number; hang: boolean; times: number }[] = [];
  let sentCounter = 0;

  const keyOf = (chatId: string, id: string) => `${chatId}\n${id}`;
  function remember(msg: StoredMessage): void {
    const key = keyOf(msg.chatId, msg.id);
    store.delete(key);
    store.set(key, msg);
    while (store.size > storeLimit) store.delete(store.keys().next().value as string);
  }
  function push(event: Record<string, unknown>): void {
    ring.push({ ...event, seq: nextSeq });
    nextSeq += 1;
    while (ring.length > ringLimit) ring.shift();
    for (const wake of [...waiters]) wake();
  }

  // ---- the control surface (also exposed in-process) ----------------------
  const control: FakeWhatsApp["control"] = {
    message(input) {
      const chatId = String(input.chatId ?? "");
      if (!isChat(chatId)) throw new Error("chatId must be a group real id or a linked-identity id");
      const isGroup = GROUP_REAL_ID.test(chatId);
      const fromMe = input.fromMe === true;
      const messageId = str(input.messageId) ?? `FAKEIN${String(nextSeq).padStart(6, "0")}`;
      const senderId = "senderId" in input ? (input.senderId as string | null) : fromMe ? own.lid : isGroup ? null : chatId;
      const media = input.media as { kind?: string; mime?: string; filename?: string; base64?: string } | undefined;
      const bytes = media?.base64 ? Buffer.from(media.base64, "base64") : undefined;
      const event: Record<string, unknown> = {
        type: "message",
        chatId,
        senderId,
        senderName: str(input.senderName) ?? "",
        messageId,
        text: str(input.text) ?? "",
        timestamp: Math.floor(Date.now() / 1000),
        fromMe,
        mentionedIds: Array.isArray(input.mentionedIds) ? input.mentionedIds : [],
      };
      const phone = str(input.senderPhone);
      if (phone && PHONE_REAL_ID.test(phone)) event.senderPhone = phone;
      for (const key of ["quotedMessageId", "quotedParticipant", "quotedText"] as const) {
        const v = str(input[key]);
        if (v) event[key] = v;
      }
      if (media && bytes) {
        event.media = { kind: media.kind ?? "image", mime: media.mime ?? "application/octet-stream", size: bytes.length, filename: media.filename ?? "" };
      }
      remember({ id: messageId, chatId, fromMe, ...(bytes ? { media: { mime: media?.mime ?? "application/octet-stream", bytes } } : {}) });
      push(event);
      return messageId;
    },
    added({ chatId, addedBy, title }) {
      if (!GROUP_REAL_ID.test(chatId)) throw new Error("chatId must be a group real id");
      if (!groups.has(chatId)) groups.set(chatId, { title: title ?? "Fixture Group", participants: new Set([own.lid]) });
      push({ type: "added_to_group", chatId, ...(addedBy ? { addedBy } : {}), ...(title ? { title } : {}) });
    },
    left({ chatId, participantId }) {
      groups.get(chatId)?.participants.delete(participantId);
      push({ type: "participant_left", chatId, participantId });
    },
    title({ chatId, title }) {
      const g = groups.get(chatId);
      if (g) g.title = title;
      push({ type: "title_changed", chatId, title });
    },
    group({ chatId, title, participants }) {
      if (!GROUP_REAL_ID.test(chatId)) throw new Error("chatId must be a group real id");
      groups.set(chatId, { title, participants: new Set(participants) });
    },
    person({ lid, phone }) {
      if (!PERSON_REAL_ID.test(lid) || !PHONE_REAL_ID.test(phone)) throw new Error("a linked-identity id and a phone id are required");
      lidByPhone.set(phone, lid);
    },
    setState(next) {
      if (!TOKEN_STATES.has(next)) throw new Error(`unknown state: ${next}`);
      state = next;
    },
    failNext({ path, status, hang, times }) {
      failures.push({ ...(path ? { path } : {}), status: status ?? 500, hang: hang === true, times: times ?? 1 });
    },
    membershipUnavailable(on) {
      membershipDown = on;
    },
    reset() {
      ring = [];
      store.clear();
      groups.clear();
      lidByPhone.clear();
      calls = [];
      requestLog = [];
      failures = [];
      membershipDown = false;
      state = "connected";
    },
    sent: () => calls.map((c) => ({ ...c })),
    requests: () => requestLog.map((r) => ({ ...r })),
  };

  const record = (call: Omit<RecordedCall, "seq">) => calls.push({ seq: (callSeq += 1), ...call });
  const connected = () => state === "connected";
  const down = (res: ServerResponse) => reply(res, 503, { ok: false, error: "unavailable", state });

  function takeFailure(path: string): { status: number; hang: boolean } | null {
    const at = failures.findIndex((f) => !f.path || f.path === path);
    if (at === -1) return null;
    const f = failures[at]!;
    f.times -= 1;
    if (f.times <= 0) failures.splice(at, 1);
    return { status: f.status, hang: f.hang };
  }

  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://stand-in.invalid");
      const method = req.method ?? "GET";
      const parts = url.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));

      // The test's hand: no bearer, never part of the contract.
      if (parts[0] === "_control") {
        const body = method === "POST" ? await readBody(req) : {};
        const action = parts[1];
        try {
          if (method === "GET" && action === "sent") return reply(res, 200, { sent: control.sent() });
          if (method === "GET" && action === "requests") return reply(res, 200, { requests: control.requests() });
          if (method === "POST" && action === "message") return reply(res, 200, { ok: true, messageId: control.message(body) });
          if (method === "POST" && action === "added") control.added(body as never);
          else if (method === "POST" && action === "left") control.left(body as never);
          else if (method === "POST" && action === "title") control.title(body as never);
          else if (method === "POST" && action === "group") control.group(body as never);
          else if (method === "POST" && action === "person") control.person(body as never);
          else if (method === "POST" && action === "state") control.setState(String(body.state));
          else if (method === "POST" && action === "fail") control.failNext(body as never);
          else if (method === "POST" && action === "membership-unavailable") control.membershipUnavailable(body.on !== false);
          else if (method === "POST" && action === "reset") control.reset();
          else return reply(res, 404, { ok: false, error: "not_found" });
          return reply(res, 200, { ok: true });
        } catch (err) {
          return reply(res, 400, { ok: false, error: (err as Error).message });
        }
      }

      const authorised = bearerOk(req.headers.authorization, secret);
      requestLog.push({ method, path: url.pathname, authorised });
      if (!authorised) return reply(res, 401, { ok: false, error: "unauthorized" });

      const failure = takeFailure(`/${parts[0] ?? ""}`);
      if (failure?.hang) return; // never answered: the client's own timeout is what ends it
      if (failure) return reply(res, failure.status, { ok: false, error: "scripted_failure" });

      if (method === "GET" && parts.length === 1 && parts[0] === "health") {
        return reply(res, 200, {
          ok: true,
          version: 1,
          state,
          epoch,
          own,
          buffered: ring.length,
          lastSeq: nextSeq - 1,
        });
      }

      if (method === "GET" && parts.length === 1 && parts[0] === "messages") {
        const afterRaw = url.searchParams.get("after");
        const after = afterRaw === null ? undefined : Number(afterRaw);
        if (after !== undefined && (!Number.isInteger(after) || after < 0)) return reply(res, 400, { ok: false, error: "bad_cursor" });
        let cursor = after;
        const seen = url.searchParams.get("epoch");
        if (seen !== null && seen !== epoch) cursor = 0;
        if (cursor === undefined) return reply(res, 200, { ok: true, epoch, lastSeq: nextSeq - 1, lost: 0, more: false, events: [] });
        const wait = Math.max(0, Math.min(Number(url.searchParams.get("waitMs") ?? 25_000) || 0, 30_000));
        const ready = () => ring.length > 0 && ring[ring.length - 1]!.seq > cursor!;
        if (wait > 0 && !ready()) {
          await new Promise<void>((resolve) => {
            const wake = () => {
              if (ready()) done();
            };
            const done = () => {
              waiters.delete(wake);
              clearTimeout(timer);
              res.off("close", done);
              resolve();
            };
            const timer = setTimeout(done, wait);
            waiters.add(wake);
            res.on("close", done);
          });
        }
        const oldest = ring.length ? ring[0]!.seq : nextSeq;
        const lost = cursor + 1 < oldest ? oldest - cursor - 1 : 0;
        const pending = ring.filter((e) => e.seq > cursor!);
        const batch = pending.slice(0, 100);
        // The cursor to ask with next is the last event DELIVERED, never the tip: a cut batch must not skip the rest.
        const lastSeq = batch.length ? batch[batch.length - 1]!.seq : nextSeq - 1;
        return reply(res, 200, { ok: true, epoch, lastSeq, lost, more: pending.length > batch.length, events: batch });
      }

      if (method === "GET" && parts.length === 3 && parts[0] === "media") {
        const entry = store.get(keyOf(parts[1]!, parts[2]!));
        if (!entry) return reply(res, 404, { ok: false, error: "gone" });
        if (!entry.media) return reply(res, 404, { ok: false, error: "no_media" });
        const cap = Number(url.searchParams.get("maxBytes")) > 0 ? Number(url.searchParams.get("maxBytes")) : 20 * 1024 * 1024;
        if (entry.media.bytes.length > cap) return reply(res, 413, { ok: false, error: "too_large", size: entry.media.bytes.length });
        if (!connected()) return down(res);
        res.writeHead(200, { "Content-Type": entry.media.mime, "Content-Length": entry.media.bytes.length, "Cache-Control": "no-store" });
        return res.end(entry.media.bytes);
      }

      if (method === "POST" && parts.length === 1 && parts[0] === "send") {
        const body = await readBody(req);
        const chatId = str(body.chatId) ?? "";
        const text = body.text;
        if (!isChat(chatId)) return reply(res, 400, { ok: false, error: "bad_chat" });
        if (typeof text !== "string" || !text.trim() || text.length > 20_000) return reply(res, 400, { ok: false, error: "bad_text" });
        if (!connected()) return down(res);
        const replyTo = str(body.replyTo);
        // A reply quotes only a message of THIS chat.
        const quoted = !!replyTo && store.has(keyOf(chatId, replyTo));
        const messageId = `FAKESENT${String((sentCounter += 1)).padStart(6, "0")}`;
        remember({ id: messageId, chatId, fromMe: true });
        record({ kind: "send", chatId, messageId, text, ...(replyTo ? { replyTo } : {}), quoted });
        return reply(res, 200, { ok: true, messageId, quoted });
      }

      if (method === "POST" && parts.length === 1 && parts[0] === "edit") {
        const body = await readBody(req);
        const chatId = str(body.chatId) ?? "";
        const messageId = str(body.messageId) ?? "";
        const text = body.text;
        if (!isChat(chatId)) return reply(res, 400, { ok: false, error: "bad_chat" });
        if (typeof text !== "string" || !text.trim() || text.length > 20_000) return reply(res, 400, { ok: false, error: "bad_text" });
        if (!messageId) return reply(res, 400, { ok: false, error: "bad_message" });
        const target = store.get(keyOf(chatId, messageId));
        if (!target) return reply(res, 404, { ok: false, error: "gone" });
        if (!target.fromMe) return reply(res, 403, { ok: false, error: "not_own_message" });
        if (!connected()) return down(res);
        record({ kind: "edit", chatId, messageId, text });
        return reply(res, 200, { ok: true, messageId });
      }

      if (method === "POST" && parts.length === 1 && parts[0] === "typing") {
        const body = await readBody(req);
        const chatId = str(body.chatId) ?? "";
        if (!isChat(chatId)) return reply(res, 400, { ok: false, error: "bad_chat" });
        if (!connected()) return down(res);
        record({ kind: "typing", chatId, state: body.state === "paused" ? "paused" : "composing" });
        return reply(res, 200, { ok: true });
      }

      if (method === "GET" && parts.length === 2 && parts[0] === "chat") {
        const id = parts[1]!;
        if (PERSON_REAL_ID.test(id)) return reply(res, 200, { ok: true, chatId: id, kind: "private" });
        if (!GROUP_REAL_ID.test(id)) return reply(res, 400, { ok: false, error: "bad_chat" });
        if (!connected()) return down(res);
        const group = groups.get(id);
        if (!group) return reply(res, 503, { ok: false, error: "unavailable", state });
        // A title and a size. Never who is in it.
        return reply(res, 200, { ok: true, chatId: id, kind: "group", title: group.title, size: group.participants.size });
      }

      if (method === "GET" && parts.length === 4 && parts[0] === "chat" && parts[2] === "participant") {
        const chatId = parts[1]!;
        const who = parts[3]!;
        if (!GROUP_REAL_ID.test(chatId)) return reply(res, 400, { ok: false, error: "bad_chat" });
        if (!PERSON_REAL_ID.test(who) && !PHONE_REAL_ID.test(who)) return reply(res, 400, { ok: false, error: "bad_participant" });
        if (!connected() || membershipDown) return reply(res, 503, { ok: false, error: "unavailable", reason: "metadata", state });
        const group = groups.get(chatId);
        if (!group) return reply(res, 503, { ok: false, error: "unavailable", reason: "metadata", state });
        // Matched across id forms, as the bridge does: a phone id counts when its pair is known.
        const lid = PHONE_REAL_ID.test(who) ? lidByPhone.get(who) : who;
        return reply(res, 200, { ok: true, chatId, inGroup: !!lid && group.participants.has(lid) });
      }

      return reply(res, 404, { ok: false, error: "not_found" });
    } catch (err) {
      const status = (err as { status?: number }).status === 413 ? 413 : (err as { status?: number }).status === 400 ? 400 : 500;
      return reply(res, status, { ok: false, error: status === 500 ? "internal" : status === 413 ? "too_large" : "bad_request" });
    }
  });

  const address = await new Promise<{ port: number }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve(server.address() as { port: number }));
  });

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    secret,
    control,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// ---- command line ---------------------------------------------------------

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const arg = (name: string) => {
    const at = process.argv.indexOf(name);
    return at === -1 ? undefined : process.argv[at + 1];
  };
  const secret = process.env.FAKE_WHATSAPP_SECRET ?? arg("--secret");
  if (!secret) {
    process.stderr.write("usage: node --import tsx tools/fake-whatsapp.ts --port <port> (secret in FAKE_WHATSAPP_SECRET or --secret)\n");
    process.exit(2);
  }
  const fake = await startFakeWhatsApp({ secret, port: Number(arg("--port") ?? 4398) });
  process.stdout.write(`fake WhatsApp bridge listening on ${fake.url}\n`);
}
