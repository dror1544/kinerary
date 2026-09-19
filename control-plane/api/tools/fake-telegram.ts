/**
 * A stand-in for the Telegram Bot API, so a whole signup-to-companion cycle can
 * run with nobody's thumbs on a phone.
 *
 *   node --import tsx tools/fake-telegram.ts --port 4399
 *
 * The relay is pointed at it with TELEGRAM_API_ROOT=http://127.0.0.1:4399 and
 * cannot tell the difference: every method it calls is answered here in
 * Telegram's own shapes. What it replaces is exactly one thing — a person
 * typing, uploading and tapping in Telegram — and everything downstream of the
 * relay (router, model calls, API, worker, provisioning, companion, MCP) is the
 * production code doing its production work.
 *
 * The other half is a control API for the automated organizer
 * (tools/auto-organizer.ts), which plays the person:
 *
 *   POST /_control/message   {chatId, text, languageCode?}    they type
 *   POST /_control/document  {chatId, filename, mime, base64}  they send a file
 *   POST /_control/tap       {chatId, messageId, data}         they tap a button
 *   POST /_control/join      {chatId, fromId, status?}         the bot is added to a group
 *   GET  /_control/sent?chatId=&after=                         what the bot said
 *
 * A negative `chatId` is a GROUP, where the trip is actually discussed and
 * where a file has to earn the assistant's attention. There the sender is a
 * person in the room rather than the chat itself, so `fromId` says who is
 * talking, and `chatTitle` names the room. `message` and `document` also take
 * `caption` and `replyToMessageId` (+ `replyToFileId` / `replyToFromId`), which
 * is how "<assistant>, add this" in reply to a PDF is played.
 *
 * Loopback only. The relay sends the real bot token in every path; it is
 * accepted and never logged or stored.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

type Update = Record<string, unknown> & { update_id: number };
interface Sent {
  seq: number;
  kind: "send" | "edit";
  chatId: string;
  messageId: number;
  text: string;
  buttons: { text: string; data: string }[];
  at: string;
}

const port = Number(process.argv[process.argv.indexOf("--port") + 1] || 4399);
const BOT = { id: 7000000001, is_bot: true, first_name: "Kinerary", username: process.env.FAKE_BOT_USERNAME || "Kinerary_bot" };

let nextUpdateId = 1;
// Message ids must not repeat ACROSS runs against the same chat. A companion's
// gateway dedupes inbound by `telegram:<chat>:<message_id>`, so a second run
// starting again at 1 had its first message — the organizer's document —
// dropped as a replay, silently, with the agent never seeing it.
let nextMessageId = Math.floor(Date.now() / 1000) % 1_000_000_000;
let seq = 0;
const updates: Update[] = [];
const sent: Sent[] = [];
const files = new Map<string, { path: string; bytes: Buffer; mime: string; name: string }>();
const waiters: (() => void)[] = [];
const unknownMethods = new Set<string>();

function push(update: Omit<Update, "update_id">): void {
  updates.push({ update_id: nextUpdateId++, ...update } as Update);
  for (const wake of waiters.splice(0)) wake();
}

function person(chatId: string, languageCode = "en") {
  return { id: Number(chatId), is_bot: false, first_name: "E2E Organizer", language_code: languageCode };
}

/** The `document` field of a message carrying a file this stand-in already holds. */
function documentOf(fileId: string): Record<string, unknown> {
  const file = files.get(fileId);
  if (!file) return {};
  return {
    document: {
      file_id: fileId, file_unique_id: fileId, file_name: file.name,
      mime_type: file.mime, file_size: file.bytes.length,
    },
  };
}

function buttonsOf(markup: unknown): { text: string; data: string }[] {
  const rows = (markup as { inline_keyboard?: { text: string; callback_data?: string }[][] } | undefined)?.inline_keyboard ?? [];
  return rows.flat().map((b) => ({ text: b.text, data: b.callback_data ?? "" }));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return Object.fromEntries(new URLSearchParams(raw));
  }
}

function reply(res: ServerResponse, status: number, payload: unknown, type = "application/json"): void {
  res.writeHead(status, { "content-type": type });
  res.end(type === "application/json" ? JSON.stringify(payload) : (payload as Buffer));
}
const ok = (res: ServerResponse, result: unknown) => reply(res, 200, { ok: true, result });
const bad = (res: ServerResponse, description: string) => reply(res, 400, { ok: false, error_code: 400, description });

// ── The Bot API, as far as the relay uses it ─────────────────────────────────

async function botMethod(method: string, params: Record<string, unknown>, url: URL, res: ServerResponse): Promise<void> {
  switch (method) {
    case "getMe":
      return ok(res, BOT);
    case "getWebhookInfo":
      return ok(res, { url: "", pending_update_count: 0 });
    case "deleteWebhook":
      return ok(res, true);
    case "getUpdates": {
      const offset = Number(url.searchParams.get("offset") ?? params.offset ?? 0);
      const timeout = Math.min(Number(url.searchParams.get("timeout") ?? params.timeout ?? 0), 30);
      // Telegram's contract: updates below `offset` are confirmed and dropped.
      while (updates.length > 0 && updates[0]!.update_id < offset) updates.shift();
      if (updates.length === 0 && timeout > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, timeout * 1000);
          waiters.push(() => { clearTimeout(timer); resolve(); });
        });
      }
      return ok(res, updates.filter((u) => u.update_id >= offset));
    }
    case "sendMessage": {
      const messageId = nextMessageId++;
      const chatId = String(params.chat_id);
      sent.push({ seq: ++seq, kind: "send", chatId, messageId, text: String(params.text ?? ""),
        buttons: buttonsOf(params.reply_markup), at: new Date().toISOString() });
      return ok(res, { message_id: messageId, date: Math.floor(Date.now() / 1000), chat: { id: Number(chatId), type: "private" },
        from: BOT, text: params.text });
    }
    case "editMessageText": {
      const chatId = String(params.chat_id);
      sent.push({ seq: ++seq, kind: "edit", chatId, messageId: Number(params.message_id), text: String(params.text ?? ""),
        buttons: buttonsOf(params.reply_markup), at: new Date().toISOString() });
      return ok(res, { message_id: Number(params.message_id), chat: { id: Number(chatId), type: "private" }, text: params.text });
    }
    case "sendChatAction":
    case "answerCallbackQuery":
    case "pinChatMessage":
    case "setMyCommands":
      return ok(res, true);
    case "exportChatInviteLink":
      return bad(res, "Bad Request: not enough rights to export chat invite link");
    case "getChat":
      return ok(res, { id: Number(params.chat_id), type: "private", first_name: "E2E Organizer" });
    case "getFile": {
      const file = files.get(String(params.file_id));
      if (!file) return bad(res, "Bad Request: invalid file_id");
      return ok(res, { file_id: params.file_id, file_unique_id: params.file_id, file_size: file.bytes.length, file_path: file.path });
    }
    default:
      // Answered, not failed: a relay feature this stand-in does not model
      // should show up in the report, not break the run. Listed on /_control/sent.
      unknownMethods.add(method);
      return ok(res, true);
  }
}

// ── The control API: the person on the other end ─────────────────────────────

async function control(path: string, req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
  if (path === "/_control/health") return ok(res, { updatesQueued: updates.length, sent: sent.length });
  if (path === "/_control/sent") {
    const chatId = url.searchParams.get("chatId");
    const after = Number(url.searchParams.get("after") ?? 0);
    return ok(res, {
      messages: sent.filter((m) => (!chatId || m.chatId === chatId) && m.seq > after),
      unknownMethods: [...unknownMethods],
    });
  }
  const p = await body(req);
  const chatId = String(p.chatId ?? "");
  // A group id is negative on Telegram, a private one is the sender's own id.
  // Both are accepted: a family group is where the trip is actually discussed,
  // and a file posted there is the case the relay's relevance gate decides on.
  const isGroup = chatId.startsWith("-");
  if (!/^-?\d{1,16}$/.test(chatId)) return bad(res, "chatId must be a private chat id, or a negative group id");
  // In a group the sender is a person in it, NOT the chat. `fromId` defaults to
  // the chat for a DM, where Telegram makes them the same.
  const fromId = String(p.fromId ?? (isGroup ? "" : chatId));
  if (isGroup && !/^\d{1,16}$/.test(fromId)) return bad(res, "a group message needs fromId — who sent it");
  const chat = isGroup
    ? { id: Number(chatId), type: "supergroup", title: String(p.chatTitle ?? "Family trip") }
    : { id: Number(chatId), type: "private" };
  const base = {
    message_id: nextMessageId++, date: Math.floor(Date.now() / 1000), chat,
    from: person(fromId, String(p.languageCode ?? "en")),
    ...(p.replyToMessageId
      ? { reply_to_message: { message_id: Number(p.replyToMessageId), date: Math.floor(Date.now() / 1000), chat,
          from: p.replyToFromId === undefined ? BOT : person(String(p.replyToFromId)),
          ...(p.replyToFileId ? documentOf(String(p.replyToFileId)) : {}) } }
      : {}),
  };
  if (path === "/_control/message") {
    push({ message: { ...base, text: String(p.text ?? "") } });
    return ok(res, { queued: true, messageId: base.message_id });
  }
  if (path === "/_control/document") {
    const bytes = Buffer.from(String(p.base64 ?? ""), "base64");
    const fileId = `F${randomBytes(12).toString("hex")}`;
    const name = String(p.filename ?? "document");
    files.set(fileId, { path: `documents/${fileId}-${name}`, bytes, mime: String(p.mime ?? "application/octet-stream"), name });
    push({ message: { ...base, ...documentOf(fileId),
      ...(p.caption ? { caption: String(p.caption) } : {}) } });
    return ok(res, { queued: true, fileId, messageId: base.message_id });
  }
  if (path === "/_control/join") {
    // The bot added to a group, as Telegram announces it: `my_chat_member`.
    // `administrator` because that is what the organizer is told to do, and it
    // is what lets the companion pin its welcome.
    if (!isGroup) return bad(res, "only a group can be joined");
    push({ my_chat_member: { chat, from: person(fromId),
      old_chat_member: { user: BOT, status: "left" },
      new_chat_member: { user: BOT, status: String(p.status ?? "administrator") } } });
    return ok(res, { queued: true });
  }
  if (path === "/_control/tap") {
    push({ callback_query: { id: `Q${randomBytes(8).toString("hex")}`, from: base.from, chat_instance: chatId,
      data: String(p.data ?? ""), message: { message_id: Number(p.messageId), date: base.date, chat: base.chat, from: BOT } } });
    return ok(res, { queued: true });
  }
  return bad(res, `unknown control path ${path}`);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith("/_control/")) return await control(url.pathname, req, url, res);
    const file = /^\/file\/bot[^/]+\/(.+)$/.exec(url.pathname);
    if (file) {
      const hit = [...files.values()].find((f) => f.path === decodeURIComponent(file[1]!));
      return hit ? reply(res, 200, hit.bytes, hit.mime) : bad(res, "Not Found");
    }
    const m = /^\/bot[^/]+\/([A-Za-z]+)$/.exec(url.pathname);
    if (!m) return bad(res, "Not Found");
    return await botMethod(m[1]!, req.method === "POST" ? await body(req) : {}, url, res);
  } catch (error) {
    return reply(res, 500, { ok: false, description: error instanceof Error ? error.message : "error" });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ event: "fake_telegram.listening", port }));
});
