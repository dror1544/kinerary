/**
 * The relay's view of the WhatsApp bridge sidecar (spec 625, "Bridge sidecar and
 * WhatsAppClient"): an interface the connector and the poller are written
 * against, and its HTTP implementation.
 *
 * Three rules shape it.
 *
 * 1. It NEVER throws. A bridge that is down, slow, logged out or answering
 *    nonsense is an `{ ok: false, reason: "unavailable" }`, because the relay
 *    serves Telegram from the same process and one WhatsApp failure must not
 *    take it down (AC-32). The caller decides what unavailable means for it.
 *
 * 2. "Could not ask" is not "no". `unavailable` (refused connection, timeout, 5xx,
 *    401, a body of the wrong shape, a bridge that is not connected) is kept
 *    apart from a definitive answer (`not_found`, `refused`, `too_large`), and
 *    `isParticipant` returns an `unavailable` rather than `false` when the bridge
 *    cannot check: AC-31 treats the two differently.
 *
 * 3. The bridge is a loopback sidecar holding a bearer secret. The base URL must
 *    be loopback (`whatsappBridgeUrl`), redirects are refused so the secret can
 *    never follow one, and nothing the bridge says is echoed into an error: a
 *    failure carries a short code (`detail`), never a body, a URL or an id.
 *
 * Ids on the wire are the bridge's canonical forms: a group's real id
 * (`<digits>[-<digits>]@g.us`), a person's linked-identity id (`<digits>@lid`).
 * The relay turns them into opaque aliases before anything leaves it (Chat ids);
 * this file only checks that what arrives has the shape of an id.
 */
import { z } from "zod";

// ---------------------------------------------------------------- ids and shapes

/** A group's real id, old (`<creator>-<time>`) or new. */
export const GROUP_REAL_ID = /^[0-9]{5,40}(-[0-9]{5,20})?@g\.us$/;
/** A person's canonical (linked-identity) id. */
export const PERSON_REAL_ID = /^[0-9]{5,40}@lid$/;
/** The phone form, which is only ever a separate optional field. */
export const PHONE_REAL_ID = /^[0-9]{5,40}@s\.whatsapp\.net$/;

export const isGroupRealId = (id: string): boolean => GROUP_REAL_ID.test(id);
export const isPersonRealId = (id: string): boolean => PERSON_REAL_ID.test(id);

const chatId = z.string().refine((v) => GROUP_REAL_ID.test(v) || PERSON_REAL_ID.test(v));
const groupId = z.string().regex(GROUP_REAL_ID);
const personId = z.string().regex(PERSON_REAL_ID);
const phoneId = z.string().regex(PHONE_REAL_ID);
const text = z.string().max(100_000);

const mediaSchema = z.object({
  kind: z.enum(["image", "video", "audio", "document"]),
  mime: z.string().max(200),
  size: z.number().int().nonnegative(),
  filename: z.string().max(500),
});

const messageEvent = z.object({
  type: z.literal("message"),
  seq: z.number().int().positive(),
  chatId,
  /** null = the bridge could not resolve the sender: unknown, never guessed. */
  senderId: personId.nullable(),
  senderPhone: phoneId.optional(),
  senderName: z.string().max(200),
  messageId: z.string().min(1).max(200),
  text,
  timestamp: z.number().nonnegative(),
  fromMe: z.boolean(),
  quotedMessageId: z.string().max(200).optional(),
  quotedParticipant: personId.optional(),
  quotedText: text.optional(),
  mentionedIds: z.array(personId).max(100),
  media: mediaSchema.optional(),
});

const addedEvent = z.object({
  type: z.literal("added_to_group"),
  seq: z.number().int().positive(),
  chatId: groupId,
  /** Present only when the notification names who did the adding. */
  addedBy: personId.optional(),
  title: z.string().max(500).optional(),
});

const leftEvent = z.object({
  type: z.literal("participant_left"),
  seq: z.number().int().positive(),
  chatId: groupId,
  participantId: personId,
});

const titleEvent = z.object({
  type: z.literal("title_changed"),
  seq: z.number().int().positive(),
  chatId: groupId,
  title: z.string().max(500),
});

const KNOWN_EVENT_TYPES = new Set(["message", "added_to_group", "participant_left", "title_changed"]);
const eventSchema = z.discriminatedUnion("type", [messageEvent, addedEvent, leftEvent, titleEvent]);

export type BridgeMessage = z.infer<typeof messageEvent>;
export type BridgeAddedToGroup = z.infer<typeof addedEvent>;
export type BridgeParticipantLeft = z.infer<typeof leftEvent>;
export type BridgeTitleChanged = z.infer<typeof titleEvent>;
export type BridgeEvent = z.infer<typeof eventSchema>;
export type BridgeMedia = z.infer<typeof mediaSchema>;

export type BridgeState = "starting" | "connecting" | "connected" | "disconnected" | "logged_out" | "replaced";

const healthSchema = z.object({
  state: z.enum(["starting", "connecting", "connected", "disconnected", "logged_out", "replaced"]),
  epoch: z.string().min(1).max(100),
  own: z.object({ lid: personId.nullable(), phone: phoneId.nullable() }),
  lastSeq: z.number().int().nonnegative(),
  buffered: z.number().int().nonnegative(),
});
export type BridgeHealth = z.infer<typeof healthSchema>;

const pollSchema = z.object({
  epoch: z.string().min(1).max(100),
  lastSeq: z.number().int().nonnegative(),
  lost: z.number().int().nonnegative(),
  /** More events are waiting beyond this batch: ask again at once with `lastSeq`. */
  more: z.boolean().default(false),
  events: z.array(z.unknown()).max(1000),
});

export interface PollBatch {
  epoch: string;
  /**
   * The cursor to ask with next: the last event delivered in this batch (the
   * bridge's tip when there is none). A batch is cut at 100 events, so this is NOT
   * always the tip: use it, and ask again at once while `more` is true.
   */
  lastSeq: number;
  /** The batch was cut: more events are waiting. */
  more: boolean;
  /** Events that fell off the bridge's ring before they were asked for. */
  lost: number;
  events: BridgeEvent[];
  /** Events the bridge sent that did not parse. Counted, never silently dropped. */
  malformed: number;
  /** Events of a type this client does not know (a newer bridge). */
  ignored: number;
}

export interface PollCursor {
  /** Omitted: "from now" — a relay that has lost its cursor does not replay history. */
  after?: number;
  /** The epoch of the previous answer; a different one means the bridge restarted. */
  epoch?: string;
}

const sendSchema = z.object({ messageId: z.string().min(1).max(200), quoted: z.boolean() });
const editSchema = z.object({ messageId: z.string().min(1).max(200) });
const chatInfoSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("group"), chatId: groupId, title: z.string().max(500), size: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("private"), chatId: personId }),
]);
const participantSchema = z.object({ inGroup: z.boolean() });

/** A group's title and size. Participant ids are never part of it. */
export type WhatsAppChatInfo =
  | { kind: "group"; chatId: string; title: string; size: number }
  | { kind: "private"; chatId: string };

// ---------------------------------------------------------------- results

/**
 * - `unavailable`: could not get an answer (down, timeout, 5xx, 401, wrong shape,
 *   not connected). Says nothing about the thing asked.
 * - `not_found`: the bridge answered, and the thing is gone (media dropped from its
 *   bounded store, an edit target it does not hold).
 * - `refused`: the bridge answered no (a message that is not the number's own, a
 *   chat that is not a chat).
 * - `too_large`: media over the cap.
 */
export type WhatsAppFailureReason = "unavailable" | "not_found" | "refused" | "too_large";

export interface WhatsAppFailure {
  ok: false;
  reason: WhatsAppFailureReason;
  /** HTTP status when there was one. */
  status?: number;
  /** A short code from a fixed set or the bridge's error token; never free text. */
  detail?: string;
  /** The bridge's connection state when it said one (`logged_out`, `disconnected`...). */
  state?: string;
}

export type WhatsAppResult<T> = { ok: true; value: T } | WhatsAppFailure;

export interface SendRequest {
  chatId: string;
  text: string;
  /** Quotes only a message of the same chat; otherwise the text is sent unquoted. */
  replyTo?: string;
  mentions?: string[];
}

export interface WhatsAppClient {
  health(): Promise<WhatsAppResult<BridgeHealth>>;
  poll(cursor: PollCursor, options?: { waitMs?: number; signal?: AbortSignal }): Promise<WhatsAppResult<PollBatch>>;
  /** Only for a message that has joined a turn (AC-26). */
  fetchMedia(chatId: string, messageId: string, options?: { maxBytes?: number }): Promise<WhatsAppResult<{ bytes: Buffer; mime: string }>>;
  send(request: SendRequest): Promise<WhatsAppResult<{ messageId: string; quoted: boolean }>>;
  /** Only a message the number itself sent, in that chat. */
  edit(request: { chatId: string; messageId: string; text: string }): Promise<WhatsAppResult<{ messageId: string }>>;
  typing(request: { chatId: string; state?: "composing" | "paused" }): Promise<WhatsAppResult<void>>;
  chatInfo(chatId: string): Promise<WhatsAppResult<WhatsAppChatInfo>>;
  /** true / false are answers; an `unavailable` result is "could not check" (AC-31). */
  isParticipant(chatId: string, participantId: string): Promise<WhatsAppResult<boolean>>;
}

// ---------------------------------------------------------------- the URL rule

/**
 * The bridge's base URL, which must point at THIS machine. It receives a bearer
 * secret, and anything else would put the secret on a network. `telegramApiRoot`
 * is not reused: it accepts https to any host. Exact parsed hostname, http only
 * (there is no certificate to check on a loopback socket), no credentials, no
 * path, query or fragment.
 */
export function whatsappBridgeUrl(configured: string | undefined): string {
  const value = (configured ?? "").trim();
  if (!value) throw new Error("relay.whatsapp.bridge_url is required");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("relay.whatsapp.bridge_url is not a URL");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "http:" || !loopback) {
    throw new Error("relay.whatsapp.bridge_url must be http to 127.0.0.1, localhost or [::1]: the bridge is a loopback sidecar");
  }
  if (url.username || url.password) throw new Error("relay.whatsapp.bridge_url must not carry credentials");
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("relay.whatsapp.bridge_url must be a bare origin");
  }
  return `${url.protocol}//${url.host}`;
}

// ---------------------------------------------------------------- the HTTP implementation

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_MEDIA_TIMEOUT_MS = 60_000;
export const DEFAULT_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_POLL_WAIT_MS = 25_000;
/** The longest a poll may be asked to wait: the bridge clamps to the same figure. */
export const MAX_POLL_WAIT_MS = 30_000;
/** Slack on top of the wait, so an idle long-poll is never read as an outage. */
const POLL_SLACK_MS = 10_000;

export interface HttpClientOptions {
  baseUrl: string;
  secret: string;
  /** Per request, except a poll (its wait plus slack) and media. */
  requestTimeoutMs?: number;
  mediaTimeoutMs?: number;
  /** For tests. */
  fetchImpl?: typeof fetch;
}

const unavailable = (detail: string, status?: number): WhatsAppFailure => ({
  ok: false,
  reason: "unavailable",
  ...(status !== undefined ? { status } : {}),
  detail,
});

const TOKEN = /^[a-z][a-z_]{0,31}$/;

/** A bridge's `error` (or `state`) as a short token, or nothing. */
function tokenOf(value: unknown): string | undefined {
  return typeof value === "string" && TOKEN.test(value) ? value : undefined;
}

export function createHttpWhatsAppClient(options: HttpClientOptions): WhatsAppClient {
  const base = whatsappBridgeUrl(options.baseUrl);
  const secret = options.secret;
  if (typeof secret !== "string" || secret.length < 16) {
    throw new Error("relay.whatsapp.bridge_secret must be at least 16 characters");
  }
  const doFetch = options.fetchImpl ?? fetch;
  const requestTimeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const mediaTimeout = options.mediaTimeoutMs ?? DEFAULT_MEDIA_TIMEOUT_MS;
  const enc = encodeURIComponent;

  /** One request; returns the raw Response or a failure. Never throws. */
  async function request(
    path: string,
    init: { method?: "GET" | "POST"; body?: unknown; timeoutMs: number; signal?: AbortSignal },
  ): Promise<{ res: Response } | { failure: WhatsAppFailure }> {
    try {
      const signals = [AbortSignal.timeout(init.timeoutMs)];
      if (init.signal) signals.push(init.signal);
      const res = await doFetch(`${base}${path}`, {
        method: init.method ?? "GET",
        // The secret never follows a redirect.
        redirect: "error",
        headers: {
          Authorization: `Bearer ${secret}`,
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.any(signals),
      });
      return { res };
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      return { failure: unavailable(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network") };
    }
  }

  /** Read a JSON body within the same deadline. */
  async function jsonOf(res: Response): Promise<unknown | undefined> {
    try {
      return await res.json();
    } catch {
      return undefined;
    }
  }

  /** Map a non-2xx answer to a typed failure. */
  function failureOf(res: Response, body: unknown): WhatsAppFailure {
    const status = res.status;
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const bridgeState = tokenOf(record.state);
    const detail = tokenOf(record.error) ?? bridgeState;
    const withDetail = (reason: WhatsAppFailureReason): WhatsAppFailure => ({
      ok: false,
      reason,
      status,
      ...(detail ? { detail } : {}),
      ...(bridgeState ? { state: bridgeState } : {}),
    });
    if (status === 404) return withDetail("not_found");
    if (status === 413) return withDetail("too_large");
    // 401 is a configuration fault (a wrong secret), which no retry of the same
    // request can fix: reported as unavailable, with the code, so it is loud.
    if (status === 400 || status === 403) return withDetail("refused");
    return withDetail("unavailable");
  }

  async function call<T>(
    path: string,
    parse: (body: unknown) => T | undefined,
    init: { method?: "GET" | "POST"; body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<WhatsAppResult<T>> {
    const sent = await request(path, { ...init, timeoutMs: init.timeoutMs ?? requestTimeout });
    if ("failure" in sent) return sent.failure;
    const body = await jsonOf(sent.res);
    if (!sent.res.ok) return failureOf(sent.res, body);
    const value = parse(body);
    if (value === undefined) return unavailable("bad_response", sent.res.status);
    return { ok: true, value };
  }

  const parseWith =
    <S extends z.ZodTypeAny>(schema: S) =>
    (body: unknown): z.infer<S> | undefined => {
      const parsed = schema.safeParse(body);
      return parsed.success ? parsed.data : undefined;
    };

  return {
    health: () => call("/health", parseWith(healthSchema)),

    async poll(cursor, opts = {}) {
      const wait = Math.max(0, Math.min(opts.waitMs ?? DEFAULT_POLL_WAIT_MS, MAX_POLL_WAIT_MS));
      const query = new URLSearchParams({ waitMs: String(Math.trunc(wait)) });
      if (cursor.after !== undefined) query.set("after", String(cursor.after));
      if (cursor.epoch !== undefined) query.set("epoch", cursor.epoch);
      return call<PollBatch>(
        `/messages?${query}`,
        (body) => {
          const head = pollSchema.safeParse(body);
          if (!head.success) return undefined;
          const events: BridgeEvent[] = [];
          let malformed = 0;
          let ignored = 0;
          for (const raw of head.data.events) {
            const type = (raw as { type?: unknown } | null)?.type;
            if (typeof type !== "string" || !KNOWN_EVENT_TYPES.has(type)) {
              ignored += 1;
              continue;
            }
            const parsed = eventSchema.safeParse(raw);
            if (parsed.success) events.push(parsed.data);
            else malformed += 1;
          }
          return { epoch: head.data.epoch, lastSeq: head.data.lastSeq, more: head.data.more, lost: head.data.lost, events, malformed, ignored };
        },
        // The wait is the bridge's, so the request outlives it: an idle poll is not an outage.
        { timeoutMs: wait + POLL_SLACK_MS, ...(opts.signal ? { signal: opts.signal } : {}) },
      );
    },

    async fetchMedia(chat, messageId, opts = {}) {
      const cap = Math.min(opts.maxBytes ?? DEFAULT_MEDIA_MAX_BYTES, DEFAULT_MEDIA_MAX_BYTES * 2);
      const query = new URLSearchParams({ maxBytes: String(cap) });
      const sent = await request(`/media/${enc(chat)}/${enc(messageId)}?${query}`, { timeoutMs: mediaTimeout });
      if ("failure" in sent) return sent.failure;
      const { res } = sent;
      if (!res.ok) return failureOf(res, await jsonOf(res));
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > cap) {
        await res.body?.cancel().catch(() => {});
        return { ok: false, reason: "too_large", status: 200 };
      }
      try {
        // Read with a ceiling of our own: the bridge's Content-Length is not trusted.
        const reader = res.body?.getReader();
        if (!reader) return unavailable("bad_response", res.status);
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > cap) {
            await reader.cancel().catch(() => {});
            return { ok: false, reason: "too_large", status: 200 };
          }
          chunks.push(value);
        }
        const mime = (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim();
        return { ok: true, value: { bytes: Buffer.concat(chunks), mime } };
      } catch {
        return unavailable("timeout");
      }
    },

    send: (req) =>
      call("/send", parseWith(sendSchema), {
        method: "POST",
        body: {
          chatId: req.chatId,
          text: req.text,
          ...(req.replyTo ? { replyTo: req.replyTo } : {}),
          ...(req.mentions?.length ? { mentions: req.mentions } : {}),
        },
      }),

    edit: (req) =>
      call("/edit", parseWith(editSchema), {
        method: "POST",
        body: { chatId: req.chatId, messageId: req.messageId, text: req.text },
      }),

    async typing(req) {
      const out = await call("/typing", (body) => (body && typeof body === "object" ? (body as object) : undefined), {
        method: "POST",
        body: { chatId: req.chatId, ...(req.state ? { state: req.state } : {}) },
      });
      return out.ok ? { ok: true, value: undefined } : out;
    },

    chatInfo: (id) => call(`/chat/${enc(id)}`, parseWith(chatInfoSchema)),

    async isParticipant(chat, participant) {
      const out = await call(`/chat/${enc(chat)}/participant/${enc(participant)}`, parseWith(participantSchema));
      return out.ok ? { ok: true, value: out.value.inGroup } : out;
    },
  };
}
