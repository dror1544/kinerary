/**
 * Test doubles for the WhatsApp Web library. Nothing here connects anywhere:
 * the "library" is a plain object whose socket is an in-memory emitter.
 *
 * Every id is obviously fake (`1000000000000NN@lid`, `2000000000NN@s.whatsapp.net`).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBridge } from "../src/core.js";
import { createBridgeServer } from "../src/http.js";

export const OWN = { lid: "100000000000099@lid", phone: "200000000099@s.whatsapp.net" };
export const ALICE = { lid: "100000000000001@lid", phone: "200000000001@s.whatsapp.net", name: "Alice Fixture" };
export const BOB = { lid: "100000000000002@lid", phone: "200000000002@s.whatsapp.net", name: "Bob Fixture" };
export const CAROL = { lid: "100000000000003@lid", phone: "200000000003@s.whatsapp.net", name: "Carol Fixture" };
export const NEW_GROUP = "120000000000000001@g.us";
export const OLD_GROUP = "200000000001-1466483396@g.us";
export const SECRET = "test-secret-0123456789abcdef";
export const DISCONNECT = { loggedOut: 401, restartRequired: 515, connectionReplaced: 440, connectionClosed: 428 };

export class FakeSocket {
  constructor() {
    this.handlers = new Map();
    this.sent = [];
    this.presence = [];
    this.groups = new Map();
    this.metadataError = null;
    this.sendError = null;
    this.ended = false;
    this.user = { id: "200000000099:7@s.whatsapp.net", lid: "100000000000099:7@lid" };
    this.signalRepository = { lidMapping: { map: new Map(), getLIDForPN: async (pn) => this.signalRepository.lidMapping.map.get(pn) ?? null } };
    this.ev = {
      on: (name, fn) => {
        const list = this.handlers.get(name) ?? [];
        list.push(fn);
        this.handlers.set(name, list);
      },
    };
    this.updateMediaMessage = () => {};
  }
  get subscribed() {
    return [...this.handlers.keys()].sort();
  }
  /** Deliver an event to every handler and wait for them, as the library's emitter would. */
  async emit(name, payload) {
    for (const fn of this.handlers.get(name) ?? []) await fn(payload);
  }
  async sendMessage(chatId, content, options = {}) {
    if (this.sendError) throw this.sendError;
    const id = `SENT${String(this.sent.length + 1).padStart(4, "0")}`;
    const entry = { chatId, content, options, id };
    this.sent.push(entry);
    return { key: { remoteJid: chatId, fromMe: true, id }, message: content.edit ? undefined : { conversation: content.text } };
  }
  async sendPresenceUpdate(state, chatId) {
    this.presence.push({ state, chatId });
  }
  async groupMetadata(chatId) {
    if (this.metadataError) throw this.metadataError;
    const md = this.groups.get(chatId);
    if (!md) throw Object.assign(new Error("forbidden"), { data: 403 });
    return md;
  }
  end() {
    this.ended = true;
  }
}

export function makeFakeLib() {
  const sockets = [];
  const authCalls = [];
  const lib = {
    DisconnectReason: DISCONNECT,
    useMultiFileAuthState: async (dir) => {
      authCalls.push(dir);
      return { state: { creds: {}, keys: {} }, saveCreds: async () => {} };
    },
    makeWASocket: (options) => {
      const sock = new FakeSocket();
      sock.options = options;
      sockets.push(sock);
      return sock;
    },
    downloadMediaMessage: async (msg) => {
      if (lib.downloadError) throw lib.downloadError;
      return Buffer.from(lib.mediaBytes ?? `bytes-of-${msg.key.id}`);
    },
  };
  return { lib, sockets, authCalls, get sock() { return sockets[sockets.length - 1]; } };
}

/** Manual timers: nothing fires until the test says so. */
export function makeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => pending.delete(id),
    get pending() {
      return [...pending.values()];
    },
    async fireNext() {
      const [id, entry] = [...pending.entries()][0] ?? [];
      if (!entry) return null;
      pending.delete(id);
      entry.fn();
      await new Promise((resolve) => setImmediate(resolve));
      return entry.ms;
    },
  };
}

export function tempDir(prefix = "wa-bridge-test-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** A connected bridge on a fake library, with its log captured. */
export async function startBridge({ timers, limits } = {}) {
  const fake = makeFakeLib();
  const logs = [];
  const bridge = createBridge({
    lib: fake.lib,
    sessionDir: tempDir(),
    log: (event, fields) => logs.push({ event, ...fields }),
    timers,
    limits,
    epoch: "epoch-test",
  });
  await bridge.start();
  const sock = fake.sock;
  await sock.emit("connection.update", { connection: "open" });
  return { bridge, fake, sock, logs };
}

export async function serve(bridge, { secret = SECRET, log = () => {} } = {}) {
  const http = createBridgeServer(bridge, { secret, log });
  const address = await http.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  const call = (pathAndQuery, { method = "GET", body, token = secret, headers = {} } = {}) =>
    fetch(`${base}${pathAndQuery}`, {
      method,
      headers: {
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  return { http, base, address, call };
}

/** A library message as `messages.upsert` delivers it. */
export function upsertOf(messages, type = "notify") {
  return { messages, type };
}

export function privateText({ from = ALICE, text = "hello fixture", id = "MSGPRIV0001", alt = true, extra = {} } = {}) {
  return {
    key: { remoteJid: from.lid, ...(alt ? { remoteJidAlt: from.phone } : {}), fromMe: false, id, participant: "", addressingMode: "lid" },
    messageTimestamp: 1795380942,
    pushName: from.name,
    message: { extendedTextMessage: { text, ...extra } },
  };
}

export function groupText({ group = NEW_GROUP, from = ALICE, text = "group fixture text", id = "MSGGRP0001", alt = true, ctx = {} } = {}) {
  return {
    key: { remoteJid: group, fromMe: false, id, participant: from.lid, ...(alt ? { participantAlt: from.phone } : {}), addressingMode: "lid" },
    messageTimestamp: 1795381004,
    pushName: from.name,
    message: { extendedTextMessage: { text, contextInfo: ctx } },
  };
}

export const group = (id, participants, extra = {}) => ({
  id,
  subject: "Fixture Group",
  participants: participants.map((p) => ({ id: p.lid, phoneNumber: p.phone, admin: null })),
  ...extra,
});

export async function readJson(res) {
  return { status: res.status, body: await res.json() };
}
