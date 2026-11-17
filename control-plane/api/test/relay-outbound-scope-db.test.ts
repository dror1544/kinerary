/**
 * Outbound actions are scoped to the caller's own chats - against the real
 * route lookup (docs/specs/sprint-9/x-relay-chat-scope.md).
 *
 * The connector is built with `outboundScopeOptions(pool, interviewerProfile)`,
 * the one function relay/server.ts spreads into its connector options, over a
 * real `telegram_chat_bindings` row (open, then closed) and a real
 * `intake_sessions` row (live, then confirmed). server.ts runs `main()` on
 * import and cannot be loaded by a test, so the last test in this file pins the
 * wiring from its source.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { WebSocket } from "ws";
import { issueEnrollment } from "../src/enrollment.js";
import { applyMigrations } from "../src/migrations.js";
import { RelayConnector } from "../src/relay/connector.js";
import { CHAT_NOT_IN_SCOPE, SCOPE_CHECK_FAILED, outboundScopeOptions } from "../src/relay/outbound-scope.js";
import { makeUpgradeToken } from "../src/relay/protocol.js";
import type { ChatInfo, SendResult, TelegramClient } from "../src/relay/telegram-api.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const skip = !testDatabaseUrl();
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const SECRET = "relay-outbound-scope-db-secret";
const COLMAR = "companion-colmar";
const JAPAN = "companion-japan";
const INTERVIEWER = "kinerary-interviewer";
const id = (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`;

class FakeTelegram implements TelegramClient {
  readonly calls: string[] = [];
  async sendMessage(p: { chatId: string }): Promise<SendResult> { this.calls.push(`send:${p.chatId}`); return { ok: true, messageId: "555" }; }
  async editMessageText(p: { chatId: string }): Promise<SendResult> { this.calls.push(`edit:${p.chatId}`); return { ok: true }; }
  async sendChatAction(p: { chatId: string }): Promise<void> { this.calls.push(`typing:${p.chatId}`); }
  async answerCallbackQuery(): Promise<void> {}
  async getChatInfo(chatId: string): Promise<ChatInfo | null> { this.calls.push(`info:${chatId}`); return { name: "Trip", type: "group" }; }
  async getUpdates(): Promise<unknown[]> { return []; }
  async deleteWebhookIfPresent(): Promise<void> {}
}

let pool: pg.Pool;
let connector: RelayConnector;
let telegram: FakeTelegram;
const logs: string[] = [];
const exchanges: Array<{ as: string; frame: unknown; reply: unknown }> = [];

const colmarTrip = id("trip");
const japanTrip = id("trip");
const GROUP = "-100200300"; // a group bound to the Colmar trip
const ORGANIZER_DM = "7001"; // the Colmar organizer's private chat
const JAPAN_GROUP = "-100999000";
const UNBOUND = "7777";
const NO_PROFILE = "-100555000";

before(async () => {
  if (skip) return;
  pool = testPool({ max: 4 });
  const client = await pool.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
    await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    await applyMigrations(client, migrationsDir);
  } finally {
    client.release();
  }
  const user = id("user");
  await pool.query("INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', 'kin.test+local')", [user]);
  for (const trip of [colmarTrip, japanTrip]) {
    await pool.query(
      "INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')",
      [trip, trip.replace(/_/g, "-")],
    );
    await pool.query(
      "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status, dashboard_access) VALUES ($1, $2, $3, 'owner', 'active', true)",
      [id("memb"), trip, user],
    );
  }
  const bind = (chat: string, trip: string, profile: string | null) => pool.query(
    "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ($1, $2, $3, $4)",
    [id("tcb"), chat, trip, profile],
  );
  await bind(GROUP, colmarTrip, COLMAR);
  await bind(ORGANIZER_DM, colmarTrip, COLMAR);
  await bind(JAPAN_GROUP, japanTrip, JAPAN);
  await bind(NO_PROFILE, japanTrip, null);

  telegram = new FakeTelegram();
  connector = new RelayConnector({
    gatewaySecrets: [SECRET],
    telegram,
    port: 0,
    log: (l) => logs.push(l),
    ...outboundScopeOptions(pool, INTERVIEWER),
  });
  await connector.listen();
});

after(async () => {
  if (skip) return;
  await connector?.close();
  await pool?.end();
  if (process.env.RELAY_SCOPE_EVIDENCE === "1") {
    for (const e of exchanges) console.log(`EVIDENCE as=${e.as} frame=${JSON.stringify(e.frame)} reply=${JSON.stringify(e.reply)}`);
    for (const l of logs.filter((x) => x.includes("relay.outbound_out_of_scope"))) console.log(`EVIDENCE log=${l}`);
  }
});

/** One outbound frame over a real socket, authenticated as `as`. */
async function ask(as: string, action: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ws = new WebSocket(`ws://127.0.0.1:${connector.address}/relay`, {
    headers: { authorization: `Bearer ${makeUpgradeToken(as, SECRET, 300)}` },
  });
  const frames: Record<string, unknown>[] = [];
  ws.on("message", (raw) => { for (const line of String(raw).split("\n")) if (line.trim()) frames.push(JSON.parse(line)); });
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  const frame = { type: "outbound", requestId: `req_${exchanges.length}`, action };
  ws.send(JSON.stringify(frame) + "\n");
  const deadline = Date.now() + 3000;
  while (!frames.some((f) => f.type === "outbound_result")) {
    if (Date.now() > deadline) throw new Error("no outbound_result");
    await new Promise((r) => setTimeout(r, 10));
  }
  ws.close();
  const reply = frames.find((f) => f.type === "outbound_result")!;
  exchanges.push({ as, frame, reply });
  return reply.result as Record<string, unknown>;
}

const send = (chat: string) => ({ op: "send", chat_id: chat, content: "hello" });
const refused = { success: false, error: CHAT_NOT_IN_SCOPE };

async function startInterview(chat: string, trip: string): Promise<string> {
  const user = (await pool.query<{ user_id: string }>("SELECT user_id FROM control_plane.trip_memberships WHERE trip_id = $1", [trip])).rows[0]!.user_id;
  const issued = await issueEnrollment(pool, user, trip, { enrollmentTtlSeconds: 3600 });
  assert.ok(issued.ok);
  const sessionId = id("sess");
  await pool.query(
    `INSERT INTO control_plane.intake_sessions(id, trip_id, user_id, enrollment_id, session_token_digest, state, answers, telegram_chat_id)
     SELECT $1, $2, $3, e.id, $4, 'interviewing', '{}'::jsonb, $5 FROM control_plane.interview_enrollments e WHERE e.trip_id = $2`,
    [sessionId, trip, user, `sha256:${createHash("sha256").update(sessionId).digest("hex")}`, chat],
  );
  return sessionId;
}

/** A finished interview on `chat` (its own trip), confirmed `ageHours` ago; `expired` also stamps `expired_at`. */
async function confirmedSession(chat: string, ageHours: number, expired = false): Promise<void> {
  const user = id("user");
  await pool.query("INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', 'kin.test+local')", [user]);
  const trip = id("trip");
  await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')", [trip, trip.replace(/_/g, "-")]);
  await pool.query(
    "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status, dashboard_access) VALUES ($1, $2, $3, 'owner', 'active', true)",
    [id("memb"), trip, user],
  );
  const issued = await issueEnrollment(pool, user, trip, { enrollmentTtlSeconds: 3600 });
  assert.ok(issued.ok);
  const sessionId = id("sess");
  await pool.query(
    `INSERT INTO control_plane.intake_sessions(id, trip_id, user_id, enrollment_id, session_token_digest, state, answers, telegram_chat_id, updated_at, expired_at)
     SELECT $1, $2, $3, e.id, NULL, 'confirmed', '{}'::jsonb, $4, now() - make_interval(hours => $5::int), CASE WHEN $6::boolean THEN now() ELSE NULL END
       FROM control_plane.interview_enrollments e WHERE e.trip_id = $2`,
    [sessionId, trip, user, chat, ageHours, expired],
  );
}

describe("outbound scope against the real route lookup", { skip }, () => {
  test("the interviewer keeps its private chat between confirmation and the companion's binding; nobody else does, and no group qualifies", async () => {
    // narrowest rule: a PRIVATE chat, no open binding, whose session was confirmed within the last 24 hours and is not expired
    await confirmedSession("7100", 1);
    telegram.calls.length = 0;
    assert.deepEqual(await ask(INTERVIEWER, { op: "typing", chat_id: "7100" }), { success: true });
    assert.deepEqual(await ask(INTERVIEWER, send("7100")), { success: true, message_id: "555" });
    assert.deepEqual(telegram.calls, ["typing:7100", "send:7100"], "delivered directly: there is no live session to route through");
    for (const op of [send("7100"), { op: "typing", chat_id: "7100" }, { op: "get_chat_info", chat_id: "7100" }, { op: "edit", chat_id: "7100", message_id: "9", content: "x" }]) {
      assert.deepEqual(await ask(COLMAR, op), refused, `a companion: ${String(op.op)}`);
    }
    // too old, expired, or a group: refused for the interviewer too
    await confirmedSession("7101", 48);
    await confirmedSession("7102", 1, true);
    await confirmedSession("-100700103", 1);
    telegram.calls.length = 0;
    for (const chat of ["7101", "7102", "-100700103"]) {
      assert.deepEqual(await ask(INTERVIEWER, { op: "typing", chat_id: chat }), refused, chat);
    }
    assert.deepEqual(telegram.calls, []);
    // once the companion's binding is open the chat is the companion's
    await pool.query(
      "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ($1, $2, $3, $4)",
      [id("tcb"), "7100", colmarTrip, COLMAR],
    );
    assert.deepEqual(await ask(INTERVIEWER, { op: "typing", chat_id: "7100" }), refused);
    assert.deepEqual(await ask(COLMAR, { op: "typing", chat_id: "7100" }), { success: true });
  });

  test("a gateway acts in its own trip's bound chats, and in no other trip's, unbound or profile-less chat", async () => {
    for (const op of [send(GROUP), { op: "typing", chat_id: GROUP }, { op: "get_chat_info", chat_id: GROUP }, { op: "edit", chat_id: GROUP, message_id: "9", content: "x" }]) {
      assert.equal((await ask(COLMAR, op)).success, true, String(op.op));
    }
    telegram.calls.length = 0;
    for (const chat of [JAPAN_GROUP, UNBOUND, NO_PROFILE]) {
      for (const op of [send(chat), { op: "typing", chat_id: chat }, { op: "get_chat_info", chat_id: chat }, { op: "edit", chat_id: chat, message_id: "9", content: "x" }]) {
        assert.deepEqual(await ask(COLMAR, op), refused, `${String(op.op)} in ${chat}`);
      }
    }
    assert.deepEqual(telegram.calls, [], "no Telegram call for a refused action");
    assert.deepEqual(await ask(JAPAN, send(GROUP)), refused, "and the other trip's gateway is refused in Colmar's group");
  });

  test("a binding closed after it was open refuses the next action; no cache", async () => {
    const chat = "-100777001";
    await pool.query(
      "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ($1, $2, $3, $4)",
      [id("tcb"), chat, colmarTrip, COLMAR],
    );
    assert.equal((await ask(COLMAR, send(chat))).success, true);
    await pool.query("UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'test' WHERE chat_id = $1", [chat]);
    telegram.calls.length = 0;
    assert.deepEqual(await ask(COLMAR, send(chat)), refused);
    assert.deepEqual(telegram.calls, []);
  });

  test("Decision 3: mid-interview, only the organizer's private chat is closed to the companion; the trip's group keeps working", async () => {
    const sessionId = await startInterview(ORGANIZER_DM, colmarTrip);
    telegram.calls.length = 0;
    // the group of the same trip: unaffected
    assert.equal((await ask(COLMAR, send(GROUP))).success, true);
    assert.equal((await ask(COLMAR, { op: "typing", chat_id: GROUP })).success, true);
    // the private chat that is mid-interview: refused, every op
    for (const op of [send(ORGANIZER_DM), { op: "typing", chat_id: ORGANIZER_DM }, { op: "get_chat_info", chat_id: ORGANIZER_DM }, { op: "edit", chat_id: ORGANIZER_DM, message_id: "9", content: "x" }]) {
      assert.deepEqual(await ask(COLMAR, op), refused, `${String(op.op)} in the private chat`);
    }
    assert.deepEqual(telegram.calls, ["send:" + GROUP, "typing:" + GROUP], "only the group's two actions reached Telegram");
    // the interviewer's gateway is allowed there (its send is converted: nothing reaches Telegram directly)
    assert.deepEqual(await ask(INTERVIEWER, { op: "typing", chat_id: ORGANIZER_DM }), { success: true });
    // the session ends: the companion has the chat back
    await pool.query("UPDATE control_plane.intake_sessions SET state = 'confirmed' WHERE id = $1", [sessionId]);
    assert.equal((await ask(COLMAR, send(ORGANIZER_DM))).success, true);
  });

  test("identity warning against real bindings: a bound companion and the interviewer profile are silent; the VM-shaped interviewer id is warned once", async () => {
    const warnedIds = () => logs.filter((l) => l.includes("relay.gateway_identity_unmatched")).map((l) => (JSON.parse(l) as { gateway_id: string }).gateway_id);
    const connectAs = async (gateway: string) => {
      const ws = new WebSocket(`ws://127.0.0.1:${connector.address}/relay`, { headers: { authorization: `Bearer ${makeUpgradeToken(gateway, SECRET, 300)}` } });
      await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
      await new Promise((r) => setTimeout(r, 300));
      ws.close();
    };
    await connectAs(COLMAR); // an open binding names it
    await connectAs(INTERVIEWER); // the interviewer profile
    assert.deepEqual(warnedIds(), []);
    await connectAs("kinerary-trip-intake"); // names neither
    await connectAs("kinerary-trip-intake");
    assert.deepEqual(warnedIds(), ["kinerary-trip-intake"]);
  });

  test("a failed lookup is SCOPE_CHECK_FAILED, answered once", async () => {
    const broken = new RelayConnector({
      gatewaySecrets: [SECRET],
      telegram,
      port: 0,
      resolveRoute: outboundScopeOptions({ query: async () => { throw new Error("db down"); } } as unknown as pg.Pool, undefined).resolveRoute!,
    });
    await broken.listen();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${broken.address}/relay`, { headers: { authorization: `Bearer ${makeUpgradeToken(COLMAR, SECRET, 300)}` } });
      const frames: Record<string, unknown>[] = [];
      ws.on("message", (raw) => { for (const line of String(raw).split("\n")) if (line.trim()) frames.push(JSON.parse(line)); });
      await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
      telegram.calls.length = 0;
      ws.send(JSON.stringify({ type: "outbound", requestId: "r1", action: send(GROUP) }) + "\n");
      await new Promise((r) => setTimeout(r, 300));
      const results = frames.filter((f) => f.type === "outbound_result");
      assert.equal(results.length, 1);
      assert.deepEqual(results[0]!.result, { success: false, error: SCOPE_CHECK_FAILED });
      assert.deepEqual(telegram.calls, []);
      exchanges.push({ as: COLMAR, frame: { type: "outbound", requestId: "r1", action: send(GROUP) }, reply: results[0] });
      ws.close();
    } finally {
      await broken.close();
    }
  });
});

describe("a database that accepts the connection and never answers", () => {
  test("the scope lookup is bounded: SCOPE_CHECK_FAILED, exactly one outbound_result, nothing reaches Telegram", async () => {
    // A database that accepts the call and never answers it: every query stays pending.
    const hungPool = { query: () => new Promise(() => {}) } as unknown as pg.Pool;
    const tg = new FakeTelegram();
    const hung = new RelayConnector({ gatewaySecrets: [SECRET], telegram: tg, port: 0, scopeLookupTimeoutMs: 300, ...outboundScopeOptions(hungPool, INTERVIEWER) });
    await hung.listen();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${hung.address}/relay`, { headers: { authorization: `Bearer ${makeUpgradeToken(COLMAR, SECRET, 300)}` } });
      const frames: Record<string, unknown>[] = [];
      ws.on("message", (raw) => { for (const line of String(raw).split("\n")) if (line.trim()) frames.push(JSON.parse(line)); });
      await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
      ws.send(JSON.stringify({ type: "outbound", requestId: "h1", action: { op: "typing", chat_id: "-1001" } }) + "\n");
      await new Promise((r) => setTimeout(r, 1200));
      const results = frames.filter((f) => f.type === "outbound_result");
      assert.equal(results.length, 1);
      assert.deepEqual(results[0], { type: "outbound_result", requestId: "h1", result: { success: false, error: SCOPE_CHECK_FAILED } });
      assert.deepEqual(tg.calls, []);
      ws.close();
    } finally {
      await hung.close();
    }
  });
});

describe("server.ts wiring", () => {
  test("the relay server spreads outboundScopeOptions(runtime.db, runtime.interviewerProfile) into the connector, and no longer passes interviewChat", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/relay/server.ts", import.meta.url)), "utf8");
    assert.ok(source.includes("...outboundScopeOptions(runtime.db, runtime.interviewerProfile)"));
    assert.ok(!/\binterviewChat\b/.test(source));
    assert.ok(source.includes("fallbackGatewayId: runtime.multiplexGatewayId"), "the multiplex id the scope check reads is still wired");
  });
});
