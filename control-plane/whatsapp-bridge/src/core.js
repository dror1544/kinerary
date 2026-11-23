/**
 * The bridge's heart: one WhatsApp Web socket, the events it produces, and the
 * operations the relay may ask for. Node built-ins only — the library comes in
 * as `lib`, so every test runs against a faked socket and CI never connects to
 * WhatsApp (spec 625, Test plan, S3).
 *
 * The bridge decides NOTHING about who may talk to the companion: no allow-list,
 * no pairing, no addressing rule, no reply of its own. The relay decides.
 *
 * Adapted from the MIT-licensed Hermes Agent bridge (see NOTICE.md): the send
 * queue (one sendMessage at a time on a socket), the reconnect scheduler, the
 * guarded version fetch and the bounded message store come from there. What it
 * does not carry: the allow-lists, the reply prefix, polls, locations, media
 * caches, the owner-message gate, and every `console.log` that named an id.
 */
import { createIdResolver, idKind, isGroupId, isMessageId, normalizeId } from "./ids.js";
import {
  createEventLog,
  createMessageStore,
  extractMessage,
  groupEventsFromParticipants,
  groupEventsFromUpdates,
  groupEventsFromUpsert,
  resolveParticipant,
  unwrap,
} from "./events.js";
import { createSilentLibraryLogger, errorCode } from "./safe-log.js";

export const CONTRACT_VERSION = 1;
const MAX_TEXT = 20_000;
const MAX_MEDIA_DEFAULT = 20 * 1024 * 1024;
const MAX_MEDIA_HARD = 50 * 1024 * 1024;
const SEND_TIMEOUT_MS = 60_000;
const META_TIMEOUT_MS = 15_000;
const MAX_WAIT_MS = 30_000;
const ADDED_DEDUPE_MS = 30_000;
/** How long a group's metadata is reused before WhatsApp is asked again. */
export const METADATA_TTL_MS = 60_000;
/** How old an offline-delivered (`append`) message may be and still be delivered. */
export const OFFLINE_MAX_AGE_S = 600;

/** The ONLY library events this bridge subscribes to. A test pins this list. */
export const SUBSCRIBED_EVENTS = Object.freeze([
  "connection.update",
  "creds.update",
  "messages.upsert",
  "groups.upsert",
  "groups.update",
  "group-participants.update",
]);

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(label), { code: "timeout" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const reply = (status, body) => ({ status, body });
const failure = (status, error, extra = {}) => reply(status, { ok: false, error, ...extra });

/**
 * @param {{
 *   lib: { makeWASocket: Function, useMultiFileAuthState: Function, DisconnectReason: Record<string, number>,
 *          downloadMediaMessage: Function, fetchLatestBaileysVersion?: Function },
 *   sessionDir: string,
 *   log: (event: string, fields?: object) => void,
 *   timers?: { setTimeout: Function, clearTimeout: Function },
 *   now?: () => number,
 *   epoch?: string,
 *   limits?: { events?: number, messages?: number },
 * }} options
 */
export function createBridge({ lib, sessionDir, log, timers, now = Date.now, epoch, limits = {} }) {
  const t = timers ?? { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const reasons = lib.DisconnectReason ?? { loggedOut: 401, restartRequired: 515, connectionReplaced: 440 };

  let sock = null;
  let state = "starting"; // starting | connecting | connected | disconnected | logged_out | replaced | unpaired
  let own = { lid: null, phone: null };
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let stopped = false;
  let sendQueue = Promise.resolve();
  const sentIds = new Set();
  const metadataCache = new Map(); // chatId -> { md, at }
  const addedSeen = new Map();
  const counters = { delivered: 0, skipped: {} };

  const resolver = createIdResolver({
    lookupLid: async (pn) => sock?.signalRepository?.lidMapping?.getLIDForPN?.(pn),
  });
  const store = createMessageStore(limits.messages ?? 512);
  const events = createEventLog(limits.events ?? 500);
  const bridgeEpoch = epoch ?? `${now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

  const skip = (reason) => {
    counters.skipped[reason] = (counters.skipped[reason] ?? 0) + 1;
  };

  function rememberAdded(chatId) {
    const at = now();
    const last = addedSeen.get(chatId);
    if (last !== undefined && at - last < ADDED_DEDUPE_MS) return false;
    addedSeen.set(chatId, at);
    while (addedSeen.size > 256) addedSeen.delete(addedSeen.keys().next().value);
    return true;
  }
  const forgetAdded = (chatId) => addedSeen.delete(chatId);

  function setOwnFromSocket() {
    const user = sock?.user ?? {};
    own = { lid: normalizeId(user.lid) || null, phone: normalizeId(user.id) || null };
    if (own.lid && own.phone) resolver.learn(own.lid, own.phone);
  }

  // ---- library events -----------------------------------------------------

  const guard = (name, fn) => async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      log("handler_error", { handler: name, code: errorCode(err) });
    }
  };

  async function onUpsert({ messages, type } = {}) {
    // `notify` is live. The library delivers what arrived while the bridge was
    // disconnected as `append` (offline nodes), so a binding code sent during a
    // reconnect would be lost if `append` were dropped; but it also uses `append`
    // for stubs and own-device echoes. So `append` is taken only when it carries
    // real content (extractMessage skips the rest) AND is recent. History sync
    // never comes through here: it is refused at the socket.
    if (type !== "notify" && type !== "append") {
      skip("upsert_other");
      return;
    }
    for (const msg of messages ?? []) {
      if (type === "append") {
        const ts = Number(msg?.messageTimestamp?.toString?.() ?? msg?.messageTimestamp ?? 0);
        if (!(ts > 0) || now() / 1000 - ts > OFFLINE_MAX_AGE_S) {
          skip("stale_append");
          continue;
        }
      }
      let result;
      try {
        result = await extractMessage(msg, { resolver, own });
      } catch (err) {
        log("extract_error", { code: errorCode(err) });
        skip("extract_error");
        continue;
      }
      if ("skip" in result) {
        skip(result.skip);
        continue;
      }
      const event = result.event;
      store.remember(event.chatId, msg);
      // The echo of our own /send is not news to the relay.
      if (event.fromMe && sentIds.has(event.messageId)) {
        skip("own_send_echo");
        continue;
      }
      counters.delivered += 1;
      events.push(event);
    }
  }

  async function onGroupsUpsert(groups) {
    for (const g of groups ?? []) metadataCache.delete(normalizeId(g?.id));
    for (const event of await groupEventsFromUpsert(groups, { resolver, own, remember: rememberAdded })) {
      events.push(event);
    }
  }

  async function onParticipants(update) {
    metadataCache.delete(normalizeId(update?.id));
    for (const event of await groupEventsFromParticipants(update, {
      resolver,
      own,
      remember: rememberAdded,
      forget: forgetAdded,
    })) {
      events.push(event);
    }
  }

  async function onGroupsUpdate(updates) {
    for (const u of updates ?? []) metadataCache.delete(normalizeId(u?.id));
    for (const event of groupEventsFromUpdates(updates)) events.push(event);
  }

  function scheduleReconnect(delayMs) {
    if (stopped) return;
    t.clearTimeout(reconnectTimer);
    reconnectTimer = t.setTimeout(() => {
      Promise.resolve()
        .then(() => connect())
        .catch((err) => {
          log("reconnect_failed", { code: errorCode(err), attempt: reconnectAttempt });
          reconnectAttempt += 1;
          scheduleReconnect(Math.min(60_000, 5_000 * 2 ** Math.min(reconnectAttempt, 4)));
        });
    }, delayMs);
  }

  function onConnection(update = {}) {
    const { connection, lastDisconnect } = update;
    if (update.qr) {
      // A QR in serve mode means the session is not paired. Showing one is
      // pairing's job (--pair-only); here it would be a reconnect loop.
      state = "unpaired";
      stopped = true;
      t.clearTimeout(reconnectTimer);
      log("unpaired", {});
      try {
        sock?.end?.(undefined);
      } catch {
        /* closing */
      }
      sock = null;
      return;
    }
    if (connection === "open") {
      state = "connected";
      reconnectAttempt = 0;
      setOwnFromSocket();
      log("connected", {});
      return;
    }
    if (connection === "connecting") {
      if (state !== "connected") state = "connecting";
      return;
    }
    if (connection !== "close") return;
    const code = lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.statusCode;
    sock = null;
    if (code === reasons.loggedOut) {
      // Reported on /health and never retried: a retry cannot succeed, and a
      // loop of attempts on a logged-out session is how a number gets flagged.
      state = "logged_out";
      log("logged_out", { code });
      return;
    }
    if (code === reasons.connectionReplaced) {
      state = "replaced";
      log("replaced", { code });
      return;
    }
    state = "disconnected";
    if (code === reasons.restartRequired) {
      log("restart_required", { code });
      scheduleReconnect(1_000);
      return;
    }
    const wait = Math.min(60_000, 3_000 * 2 ** Math.min(reconnectAttempt, 4));
    reconnectAttempt += 1;
    log("disconnected", { code: typeof code === "number" ? code : "unknown", attempt: reconnectAttempt });
    scheduleReconnect(wait);
  }

  async function connect() {
    if (stopped) return;
    const { state: auth, saveCreds } = await lib.useMultiFileAuthState(sessionDir);
    // Serving needs a paired session. With none, no socket is made at all: the
    // library would otherwise ask for a QR and reconnect for ever.
    if (!auth?.creds?.registered && !auth?.creds?.me) {
      state = "unpaired";
      stopped = true;
      log("unpaired", {});
      return false;
    }
    let version;
    if (typeof lib.fetchLatestBaileysVersion === "function") {
      try {
        version = (await withTimeout(lib.fetchLatestBaileysVersion(), 15_000, "version")).version;
      } catch {
        log("version_fetch_failed", {});
      }
    }
    state = "connecting";
    const socket = lib.makeWASocket({
      ...(version ? { version } : {}),
      auth,
      logger: createSilentLibraryLogger(),
      printQRInTerminal: false,
      browser: ["Kinerary", "Chrome", "120.0"],
      syncFullHistory: false,
      // The phone's history and address book are never wanted here.
      shouldSyncHistoryMessage: () => false,
      markOnlineOnConnect: false,
      // The library asks for a message it must retry; hand it ours when we have
      // it, a placeholder otherwise (enough to finish the handshake).
      getMessage: async (key) => {
        const found = key?.remoteJid ? store.get(normalizeId(key.remoteJid), key.id) : null;
        return found?.message ?? { conversation: "" };
      },
    });
    sock = socket;
    // An event from a socket that is no longer the live one is ignored: a late
    // close from the old socket must not tear down its replacement.
    const live = (fn) => (...args) => (sock === socket ? fn(...args) : undefined);
    socket.ev.on("creds.update", guard("creds", () => saveCreds()));
    socket.ev.on("connection.update", (u) => {
      try {
        live(onConnection)(u);
      } catch (err) {
        log("handler_error", { handler: "connection", code: errorCode(err) });
      }
    });
    socket.ev.on("messages.upsert", guard("upsert", live(onUpsert)));
    socket.ev.on("groups.upsert", guard("groups_upsert", live(onGroupsUpsert)));
    socket.ev.on("groups.update", guard("groups_update", live(onGroupsUpdate)));
    socket.ev.on("group-participants.update", guard("participants", live(onParticipants)));
    return true;
  }

  /** @returns {Promise<boolean>} false when the session is not paired and nothing was started */
  async function start() {
    stopped = false;
    return (await connect()) === true;
  }

  function stop() {
    stopped = true;
    t.clearTimeout(reconnectTimer);
    try {
      // `end`, never `logout`: logging out would unlink the number.
      sock?.end?.(undefined);
    } catch {
      /* closing a dead socket */
    }
    sock = null;
    state = "disconnected";
  }

  // ---- operations ---------------------------------------------------------

  const connected = () => (state === "connected" && sock ? sock : null);
  const unavailable = () => failure(503, "unavailable", { state });

  function enqueue(fn) {
    const task = sendQueue.then(fn, fn);
    sendQueue = task.catch(() => {});
    return task;
  }

  function health() {
    return reply(200, {
      ok: true,
      version: CONTRACT_VERSION,
      state,
      epoch: bridgeEpoch,
      own: { lid: own.lid, phone: own.phone },
      buffered: events.size,
      lastSeq: events.lastSeq,
      counters: { delivered: counters.delivered, skipped: { ...counters.skipped } },
    });
  }

  /**
   * Long-poll. `after` absent means "from now": a relay that has lost its cursor
   * does not replay history to the people in it. A different `epoch` means the
   * bridge restarted and everything in its ring is new to the caller.
   */
  async function poll({ after, epoch: seen, waitMs = 25_000, signal } = {}) {
    let cursor = after;
    if (seen !== undefined && seen !== bridgeEpoch) cursor = 0;
    if (cursor === undefined) {
      return reply(200, { ok: true, epoch: bridgeEpoch, lastSeq: events.lastSeq, lost: 0, more: false, events: [] });
    }
    const wait = Math.max(0, Math.min(Number(waitMs) || 0, MAX_WAIT_MS));
    if (wait > 0) await events.wait(cursor, wait, signal);
    const { events: batch, lastSeq, lost, more } = events.since(cursor, 100);
    return reply(200, { ok: true, epoch: bridgeEpoch, lastSeq, lost, more, events: batch });
  }

  async function media(chatIdRaw, messageId, maxBytesRaw) {
    const chatId = normalizeId(chatIdRaw);
    if (!["group", "lid"].includes(idKind(chatId))) return failure(400, "bad_chat");
    if (!isMessageId(messageId)) return failure(400, "bad_message");
    const entry = store.get(chatId, messageId);
    if (!entry) return failure(404, "gone");
    const content = unwrap(entry.message);
    const item = content.imageMessage ?? content.videoMessage ?? content.audioMessage ?? content.documentMessage;
    if (!item) return failure(404, "no_media");
    const cap = Math.min(Number(maxBytesRaw) > 0 ? Number(maxBytesRaw) : MAX_MEDIA_DEFAULT, MAX_MEDIA_HARD);
    const declared = Number(item.fileLength?.toString?.() ?? item.fileLength ?? 0);
    if (declared > cap) return failure(413, "too_large", { size: declared });
    const socket = connected();
    if (!socket) return unavailable();
    try {
      const bytes = await withTimeout(
        lib.downloadMediaMessage(
          entry,
          "buffer",
          {},
          { logger: createSilentLibraryLogger(), reuploadRequest: socket.updateMediaMessage },
        ),
        SEND_TIMEOUT_MS,
        "download",
      );
      if (bytes.length > cap) return failure(413, "too_large", { size: bytes.length });
      return { status: 200, bytes, mime: typeof item.mimetype === "string" ? item.mimetype : "application/octet-stream" };
    } catch (err) {
      log("media_failed", { code: errorCode(err) });
      return failure(502, "download_failed");
    }
  }

  async function sendText(body) {
    const chatId = normalizeId(body?.chatId);
    const kind = idKind(chatId);
    if (kind !== "group" && kind !== "lid") return failure(400, "bad_chat");
    const text = body?.text;
    if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT) return failure(400, "bad_text");
    if (body.replyTo !== undefined && !isMessageId(body.replyTo)) return failure(400, "bad_message");
    const socket = connected();
    if (!socket) return unavailable();
    const content = { text };
    if (Array.isArray(body.mentions)) {
      const ids = body.mentions.map(normalizeId).filter((id) => ["lid", "pn"].includes(idKind(id))).slice(0, 50);
      if (ids.length) content.mentions = ids;
    }
    const options = {};
    let quoted = false;
    if (typeof body.replyTo === "string") {
      // A reply quotes only a message of THIS chat: the store is keyed by chat.
      const target = store.get(chatId, body.replyTo);
      if (target) {
        options.quoted = target;
        quoted = true;
      }
    }
    try {
      const sent = await enqueue(() => withTimeout(socket.sendMessage(chatId, content, options), SEND_TIMEOUT_MS, "send"));
      const id = sent?.key?.id;
      if (!id) return failure(502, "send_failed");
      sentIds.add(id);
      while (sentIds.size > 1024) sentIds.delete(sentIds.values().next().value);
      store.remember(chatId, { ...sent, key: { ...sent.key, fromMe: true } });
      return reply(200, { ok: true, messageId: id, quoted });
    } catch (err) {
      log("send_failed", { code: errorCode(err) });
      return failure(502, "send_failed");
    }
  }

  async function edit(body) {
    const chatId = normalizeId(body?.chatId);
    if (!["group", "lid"].includes(idKind(chatId))) return failure(400, "bad_chat");
    const text = body?.text;
    if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT) return failure(400, "bad_text");
    if (!isMessageId(body.messageId)) return failure(400, "bad_message");
    // Only a message THIS BRIDGE sent, in this chat. One typed on the number's own
    // phone is the number's, but not the relay's to rewrite; and after a restart
    // the bridge no longer remembers what it sent, so the answer is `gone`.
    const target = store.get(chatId, body.messageId);
    if (!target) return failure(404, "gone");
    if (!sentIds.has(body.messageId) || target.key?.fromMe !== true) return failure(403, "not_own_message");
    const socket = connected();
    if (!socket) return unavailable();
    try {
      await enqueue(() => withTimeout(socket.sendMessage(chatId, { text, edit: target.key }), SEND_TIMEOUT_MS, "edit"));
      return reply(200, { ok: true, messageId: body.messageId });
    } catch (err) {
      log("edit_failed", { code: errorCode(err) });
      return failure(502, "edit_failed");
    }
  }

  async function typing(body) {
    const chatId = normalizeId(body?.chatId);
    if (!["group", "lid"].includes(idKind(chatId))) return failure(400, "bad_chat");
    const presence = body?.state === "paused" ? "paused" : "composing";
    const socket = connected();
    if (!socket) return unavailable();
    try {
      await withTimeout(socket.sendPresenceUpdate(presence, chatId), META_TIMEOUT_MS, "typing");
      return reply(200, { ok: true });
    } catch (err) {
      log("typing_failed", { code: errorCode(err) });
      return failure(502, "typing_failed");
    }
  }

  async function groupMetadata(chatId) {
    const socket = connected();
    if (!socket) return { error: unavailable() };
    const cached = metadataCache.get(chatId);
    if (cached && now() - cached.at < METADATA_TTL_MS) return { md: cached.md };
    try {
      const md = await withTimeout(socket.groupMetadata(chatId), META_TIMEOUT_MS, "metadata");
      metadataCache.set(chatId, { md, at: now() });
      while (metadataCache.size > 256) metadataCache.delete(metadataCache.keys().next().value);
      return { md };
    } catch (err) {
      log("metadata_failed", { code: errorCode(err) });
      return { error: failure(503, "unavailable", { reason: "metadata", state }) };
    }
  }

  /** The chat's title and kind. Participant ids are NOT returned. */
  async function chatInfo(idRaw) {
    const chatId = normalizeId(idRaw);
    const kind = idKind(chatId);
    if (kind === "lid") return reply(200, { ok: true, chatId, kind: "private" });
    if (kind !== "group") return failure(400, "bad_chat");
    const { md, error } = await groupMetadata(chatId);
    if (error) return error;
    return reply(200, {
      ok: true,
      chatId,
      kind: "group",
      title: typeof md?.subject === "string" ? md.subject : "",
      size: Array.isArray(md?.participants) ? md.participants.length : 0,
    });
  }

  /**
   * Is this person in this group now? Three answers, and the third is not "no":
   * `inGroup: true`, `inGroup: false`, or 503 "could not check" (the relay's
   * AC-31 treats the last differently). The match is across the forms the group lists a person under.
   */
  async function participant(chatIdRaw, participantRaw) {
    const chatId = normalizeId(chatIdRaw);
    if (!isGroupId(chatId)) return failure(400, "bad_chat");
    // The linked-identity form only: the relay holds no other, and a phone form
    // would make the bridge's answer depend on a mapping it may not have.
    const wantedId = normalizeId(participantRaw);
    if (idKind(wantedId) !== "lid") return failure(400, "bad_participant");
    const { md, error } = await groupMetadata(chatId);
    if (error) return error;
    if (!Array.isArray(md?.participants)) return failure(503, "unavailable", { reason: "metadata", state });
    let inGroup = false;
    for (const entry of md.participants) {
      const who = await resolveParticipant(entry, resolver);
      if (who.lid === wantedId) {
        inGroup = true;
        break;
      }
    }
    return reply(200, { ok: true, chatId, inGroup });
  }

  return {
    start,
    stop,
    health,
    poll,
    media,
    send: sendText,
    edit,
    typing,
    chatInfo,
    participant,
    get state() {
      return state;
    },
  };
}
