/**
 * #327 preconditions 2–4: three assistant-event paths #177's replay test does
 * not drive, each read straight off the design's own contract (emitter.ts /
 * relay-facts.ts / contract.ts) rather than re-decided here.
 *
 *   2. `handedOff(delivered=false)`, through the real `applyDecision` — the
 *      gateway-unavailable branch of a `to_gateway` decision. The replay's
 *      "lost" scenario exercises `companionUnreachable` (a `reply` decision,
 *      the router answering because `canReachProfile` said no before dispatch
 *      ever built the decision); this is the OTHER lost path, where dispatch
 *      believed the gateway was reachable and `connector.pushInbound` said
 *      otherwise at the last moment. Different call, different emitter method,
 *      same contract requirement: `turn_lost`, never `reply_delivered`.
 *   3. The connector's `suppressed` (an internal-leak send, outside an
 *      interview chat) and `{ok:false}` (Telegram refused the send) branches —
 *      both already call `replySent` in connector.ts; nothing here is new
 *      behaviour, only the first test of it. Driven the way
 *      relay-connector.test.ts drives every other connector behaviour: dial a
 *      real `RelayConnector` over its own socket and send an `outbound` frame.
 *   4. `runDocumentCorrection`'s outcomes other than `failed_tool`
 *      (`blocked_by_policy`, `correction_proposed`, `no_new_information`) and
 *      the correction chain's `.catch` path, plus the sink-throws invariant
 *      extended to these outcomes (§12: sink failure is invisible to
 *      families) — driven the way document-correction-flow.test.ts drives
 *      every other correction outcome: `applyDecision` with a real
 *      `document_correction` decision, a scripted model runner, and a real
 *      database.
 *
 * `relay/poller.ts`, `relay/connector.ts` and `relay/dispatch.ts` are
 * must-not-touch SOURCE for this task (#326 and #163 own their next changes);
 * every path here is reached through their existing, already-exported seams
 * — `applyDecision`'s `InboundSink` interface, `RelayConnector`'s public
 * outbound-frame protocol, and the real `runDocumentCorrection` outcomes
 * already returned by the code as written. Nothing here needed a source
 * change in any of the three, so items 2–4 are ALL "already green, pinned":
 * the behaviour existed; only the test did not.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import pg from "pg";
import { startFromDeepLink } from "../src/chat-router.js";
import { filesystemDocumentStore } from "../src/document-store.js";
import { issueEnrollment } from "../src/enrollment.js";
import { confirmIntakeForChat } from "../src/interview.js";
import { applyMigrations } from "../src/migrations.js";
import type { RunnerResult, StructuredModelRequest, StructuredModelRunner } from "../src/model-runner.js";
import { inboundFacts } from "../src/analytics/relay-facts.js";
import { RelayAssistantEvents, type AssistantEventSink } from "../src/analytics/emitter.js";
import type { AssistantEvent } from "../src/analytics/contract.js";
import { RelayConnector } from "../src/relay/connector.js";
import { DEFAULT_STRINGS } from "../src/relay/dispatch.js";
import { makeUpgradeToken } from "../src/relay/protocol.js";
import { uiString } from "../src/intake-copy.js";
import { applyDecision, settleDocumentCorrections, type InboundSink, type TripBotPollerDeps } from "../src/relay/poller.js";
import type { SendResult, TelegramClient } from "../src/relay/telegram-api.js";
import { testDatabaseUrl } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

/** Records events in memory — no database needed for items 2 and 3. */
function recordingSink(): { sink: AssistantEventSink; rows: AssistantEvent[] } {
  const rows: AssistantEvent[] = [];
  return { sink: { write: async (events) => { rows.push(...events); return { inserted: events.length, rejected: [] }; } }, rows };
}

// ── Item 2: handedOff(delivered=false) via a real to_gateway decision ────────

describe("#327 precondition 2 — handedOff(delivered=false)", () => {
  test("a gateway that refuses the push emits turn_lost, never reply_delivered, and still tells the organizer", async () => {
    const { sink, rows } = recordingSink();
    const events = new RelayAssistantEvents({ sink, flushIntervalMs: 0, log: () => {} });

    const sent: { chatId: string; text: string }[] = [];
    const telegram = {
      async sendMessage(p: { chatId: string; text: string }): Promise<SendResult> {
        sent.push({ chatId: p.chatId, text: p.text });
        return { ok: true, messageId: "1" };
      },
    } as unknown as TelegramClient;

    // The seam #326/#163 own: an InboundSink whose pushInbound says no —
    // exactly the case dispatch could not have known about when it built the
    // decision (the gateway went away between the dispatch read and the push).
    const connector: InboundSink = { pushInbound: () => false };

    const deps: TripBotPollerDeps = { db: {} as pg.Pool, telegram, connector, strings: DEFAULT_STRINGS, log: () => {}, assistantEvents: events };

    const facts = inboundFacts({
      tripId: `trip_${"a".repeat(32)}`,
      telegramChatType: "supergroup",
      trigger: "name",
      linkRole: "organizer",
      attachmentKind: null,
      textLength: 20,
    });

    await applyDecision({
      kind: "to_gateway",
      event: {
        text: "Liv, how far is the station",
        message_type: "text",
        message_id: "42",
        source: { platform: "telegram", chat_id: "chat_lost", chat_type: "group", chat_name: null, user_id: "u1", user_name: "Someone", thread_id: null, chat_topic: null },
      },
      analytics: facts,
    }, deps);

    await events.flush();
    assert.equal(rows.length, 1, "exactly one event for the refused push");
    assert.equal(rows[0]!.event_type, "turn_lost");
    assert.equal(rows[0]!.outcome, "lost_gateway_unavailable");
    assert.ok(!rows.some((r) => r.outcome === "reply_delivered"), "never claims a reply was delivered");
    assert.equal(events.stats.dropped, 0);
    assert.equal(events.stats.rejected, 0);

    assert.equal(sent.length, 1, "the organizer is told, exactly as without assistant events");
    assert.equal(sent[0]!.text, DEFAULT_STRINGS.gatewayUnavailable);
  });
});

// ── Item 3: the connector's suppressed and {ok:false} branches ───────────────

function sendFrame(ws: WebSocket, frame: unknown): void {
  ws.send(JSON.stringify(frame) + "\n");
}

async function dial(port: number, token: string): Promise<{ ws: WebSocket; frames: Record<string, unknown>[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/relay`, { headers: { authorization: `Bearer ${token}` } });
  const frames: Record<string, unknown>[] = [];
  ws.on("message", (raw) => {
    for (const line of String(raw).split("\n")) {
      if (line.trim()) frames.push(JSON.parse(line));
    }
  });
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  return { ws, frames };
}

async function waitFor<T>(get: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const SECRET = "assistant-events-paths-secret";

describe("#327 precondition 3 — connector suppressed / {ok:false}", () => {
  test("an internal-leak send is suppressed, delivered as far as the gateway is concerned, and recorded as reply_suppressed", async () => {
    const { sink, rows } = recordingSink();
    const events = new RelayAssistantEvents({ sink, flushIntervalMs: 0, log: () => {} });

    const telegram = {
      async sendMessage(): Promise<SendResult> { throw new Error("must not reach Telegram"); },
      async editMessageText(): Promise<SendResult> { return { ok: true }; },
      async sendChatAction(): Promise<void> {},
      async answerCallbackQuery(): Promise<void> {},
      async getChatInfo() { return null; },
      async getMe() { return null; },
      async getUpdates(): Promise<unknown[]> { return []; },
      async deleteWebhookIfPresent(): Promise<void> {},
    } as unknown as TelegramClient;

    const connector = new RelayConnector({ gatewaySecrets: [SECRET], telegram, port: 0, log: () => {}, assistantEvents: events });
    await connector.listen();
    try {
      // A chat context the emitter already knows about, exactly as a real
      // inbound turn would have created one — replySent needs it to
      // attribute the reply to a trip; without one it records nothing at all
      // (by design: a reply to an unknown chat is not this trip's data).
      events.handedOff("900", inboundFacts({
        tripId: `trip_${"b".repeat(32)}`, telegramChatType: "supergroup", trigger: "name",
        linkRole: "organizer", attachmentKind: null, textLength: 10,
      }), true, "msg_1");

      const { ws, frames } = await dial(connector.address!, makeUpgradeToken("gw_paths", SECRET, 300));
      sendFrame(ws, {
        type: "outbound",
        requestId: "req_1",
        action: { op: "send", chat_id: "900", content: "`bot_gender` עדיין ב-optionalRemaining" },
      });
      const result = await waitFor(() => frames.find((f) => f.type === "outbound_result"));
      assert.deepEqual(result.result, { success: true }, "the gateway's future still resolves");
      ws.close();

      await events.flush();
      // rows also carries the request_forwarded event handedOff() itself
      // enqueued to open the chat context above — that is setup, not what
      // this test is about.
      const replies = rows.filter((r) => r.event_type === "reply_sent");
      assert.equal(replies.length, 1);
      assert.equal(replies[0]!.outcome, "reply_suppressed");
      assert.ok(!rows.some((r) => r.outcome === "reply_delivered"));
    } finally {
      await connector.close();
    }
  });

  test("a send Telegram refuses is recorded as failed_delivery, never reply_delivered", async () => {
    const { sink, rows } = recordingSink();
    const events = new RelayAssistantEvents({ sink, flushIntervalMs: 0, log: () => {} });

    const telegram = {
      async sendMessage(): Promise<SendResult> { return { ok: false, error: "chat not found" }; },
      async editMessageText(): Promise<SendResult> { return { ok: true }; },
      async sendChatAction(): Promise<void> {},
      async answerCallbackQuery(): Promise<void> {},
      async getChatInfo() { return null; },
      async getMe() { return null; },
      async getUpdates(): Promise<unknown[]> { return []; },
      async deleteWebhookIfPresent(): Promise<void> {},
    } as unknown as TelegramClient;

    const connector = new RelayConnector({ gatewaySecrets: [SECRET], telegram, port: 0, log: () => {}, assistantEvents: events });
    await connector.listen();
    try {
      events.handedOff("901", inboundFacts({
        tripId: `trip_${"c".repeat(32)}`, telegramChatType: "private", trigger: "dm",
        linkRole: "organizer", attachmentKind: null, textLength: 10,
      }), true, "msg_2");

      const { ws, frames } = await dial(connector.address!, makeUpgradeToken("gw_paths2", SECRET, 300));
      sendFrame(ws, { type: "outbound", requestId: "req_2", action: { op: "send", chat_id: "901", content: "hello" } });
      const result = await waitFor(() => frames.find((f) => f.type === "outbound_result"));
      assert.equal((result.result as { success: boolean }).success, false);
      ws.close();

      await events.flush();
      const replies = rows.filter((r) => r.event_type === "reply_sent");
      assert.equal(replies.length, 1);
      assert.equal(replies[0]!.outcome, "failed_delivery");
      assert.ok(!rows.some((r) => r.outcome === "reply_delivered"));
    } finally {
      await connector.close();
    }
  });
});

// ── Item 4: runDocumentCorrection's other outcomes, and the catch path ───────

const CHAT = "880000601";
const id = (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`;
const TOKYO = { name: "Tokyo", name_en: "Tokyo", start: "2026-09-19", end: "2026-09-23", accommodation: { name: "Hotel Gracery Shinjuku" } };

const CORRECTION_DOCS = {
  voucher: { name: "Gracery voucher.txt", body: "Gracery accommodation voucher\nTokyo 2026-09-19 to 2026-09-23\nHotel Gracery Shinjuku\nConfirmation GR-4471\n" },
  copy: { name: "Itinerary copy.txt", body: "Itinerary copy\nTokyo 2026-09-19 to 2026-09-23\nHotel Gracery Shinjuku\n" },
  // "passport" in the filename alone refuses the document before any content
  // is read (document-text.ts, looksLikeIdentityDocument) — registered: 0,
  // identity: 1, which runDocumentCorrection reads as blocked_by_policy.
  passport: { name: "passport-scan.txt", body: "some scanned text, never read\n" },
};

const SCRIPT: { needle: string; phases: unknown[]; evidence: string }[] = [
  {
    needle: "Gracery accommodation voucher",
    phases: [{ ...TOKYO, accommodation: { name: "Hotel Gracery Shinjuku", confirmation: "GR-4471" } }],
    evidence: "Tokyo 2026-09-19 to 2026-09-23\nHotel Gracery Shinjuku\nConfirmation GR-4471",
  },
  { needle: "Itinerary copy", phases: [TOKYO], evidence: "Tokyo 2026-09-19 to 2026-09-23\nHotel Gracery Shinjuku" },
];

function scriptedRunner(): StructuredModelRunner {
  return {
    describe: () => ({ provider: "scripted", model: "fixture-1" }),
    async run<T>(req: StructuredModelRequest<T>): Promise<RunnerResult<T>> {
      const hit = SCRIPT.find((s) => req.prompt.includes(s.needle));
      if (!hit) return { ok: false, reason: "FAILED", detail: "unscripted", attempts: 1, ms: 0 };
      const parsed = req.parse({
        proposals: [{ questionId: "phases", confidence: 0.95, evidence: hit.evidence, value: { kind: "structured", dataJson: JSON.stringify(hit.phases) } }],
        unclear: [],
      });
      return parsed === null ? { ok: false, reason: "BAD_OUTPUT", attempts: 1, ms: 0 } : { ok: true, value: parsed, attempts: 1, ms: 0 };
    },
  };
}

interface CorrectionTrip {
  pool: pg.Pool;
  tripId: string;
  sessionId: string;
  sent: { chatId: string; text: string }[];
  logs: string[];
  documentRoot: string;
}

/** Same shape as document-correction-flow.test.ts's withConfirmedTrip, minimal — only what item 4 needs. */
async function withConfirmedTrip(fn: (trip: CorrectionTrip) => Promise<void>): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
    await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    await applyMigrations(client, migrationsDir);
  } finally {
    client.release();
  }
  const root = await mkdtemp(path.join(tmpdir(), "assistant-events-doc-correction-"));
  try {
    const userId = id("user");
    const tripId = id("trip");
    await pool.query("INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', 'Owner')", [userId]);
    await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')", [tripId, tripId.replace(/_/g, "-")]);
    await pool.query(
      "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')",
      [id("memb"), tripId, userId],
    );
    const enrollment = await issueEnrollment(pool, userId, tripId, { enrollmentTtlSeconds: 3600 });
    assert.ok(enrollment.ok);
    const started = await startFromDeepLink(pool, CHAT, enrollment.token);
    assert.equal(started.kind, "started");
    await pool.query(
      "UPDATE control_plane.intake_sessions SET answers = $1, state = 'awaiting_confirmation' WHERE telegram_chat_id = $2",
      [
        JSON.stringify({
          trip_type: { kind: "choice", option_id: "family", schema_version: 2, other_text: null },
          destination: { kind: "text", schema_version: 2, text: "Japan" },
          departure_date: { kind: "text", schema_version: 2, text: "2026-09-19" },
          return_date: { kind: "text", schema_version: 2, text: "2026-09-23" },
          travelers: { kind: "structured", schema_version: 2, data: [{ name: "Dana" }] },
          phases: { kind: "structured", schema_version: 2, data: [TOKYO] },
          bot_name: { kind: "text", schema_version: 2, text: "Rio" },
          bot_gender: { kind: "choice", option_id: "neutral", schema_version: 2, other_text: null },
          bot_tone: { kind: "choice", option_id: "warm", schema_version: 2, other_text: null },
          organizer_identity: { kind: "text", schema_version: 2, text: "Dana" },
        }),
        CHAT,
      ],
    );
    const confirmed = await confirmIntakeForChat(pool, CHAT);
    assert.ok(confirmed.ok, `confirm failed: ${JSON.stringify(confirmed)}`);
    await pool.query(
      "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ($1, $2, $3, 'companion-test')",
      [id("tcb"), CHAT, tripId],
    );
    await fn({ pool, tripId, sessionId: started.kind === "started" ? started.sessionId : "", sent: [], logs: [], documentRoot: root });
  } finally {
    await pool.end();
    await rm(root, { recursive: true, force: true });
  }
}

/** Uploads one document through applyDecision, exactly as the poll loop would — with assistantEvents wired. */
async function uploadWithEvents(
  trip: CorrectionTrip,
  doc: { name: string; body: string },
  messageId: string,
  options: { db?: pg.Pool; assistantEvents?: RelayAssistantEvents } = {},
): Promise<void> {
  const bytes = Buffer.from(doc.body, "utf8");
  const deps = {
    db: options.db ?? trip.pool,
    telegram: { sendMessage: async (p: { chatId: string; text: string }) => { trip.sent.push(p); return { ok: true as const, messageId: "1" }; } },
    connector: { pushInbound: () => true },
    modelRunner: scriptedRunner(),
    documentStore: filesystemDocumentStore(trip.documentRoot),
    media: { telegram: { fetchFile: async () => ({ bytes, mime: "text/plain" }) }, store: { get: () => ({ bytes, mime: "text/plain", filename: doc.name }) }, baseUrl: "http://127.0.0.1:4312", log: () => {} },
    log: (line: string) => trip.logs.push(line),
    ...(options.assistantEvents ? { assistantEvents: options.assistantEvents } : {}),
  } as unknown as TripBotPollerDeps;
  await applyDecision({
    kind: "document_correction",
    chatId: CHAT,
    tripId: trip.tripId,
    sessionId: trip.sessionId,
    language: "en",
    event: {
      text: "",
      message_id: messageId,
      message_type: "document",
      source: { chat_id: CHAT },
      media_urls: [`http://127.0.0.1:4312/relay/media/${messageId}`],
      media: [{ kind: "document", mime: "text/plain", size: bytes.length, filename: doc.name }],
    },
    // Without this, dispatch never attached a descriptor and
    // `deps.assistantEvents?.toRelay(...)` is never called at all — exactly
    // the shape `dispatchUpdate` builds via `inboundFacts` (relay-facts.ts).
    ...(options.assistantEvents
      ? { analytics: { ...inboundFacts({ tripId: trip.tripId, telegramChatType: "private", trigger: "dm", linkRole: "organizer", attachmentKind: "document", textLength: 0 }), documents: 1 } }
      : {}),
  } as never, deps);
  await settleDocumentCorrections();
}

/** Wraps a real pool; the corrections insert rejects, everything else passes through — the catch path's trigger. */
function failingOnCorrectionInsert(pool: pg.Pool): pg.Pool {
  return {
    query: (text: string, values?: unknown[]) =>
      /INSERT INTO control_plane\.trip_document_corrections/.test(String(text))
        ? Promise.reject(new Error("simulated: corrections table unavailable"))
        : pool.query(text, values),
    connect: () => pool.connect(),
  } as unknown as pg.Pool;
}

describe("#327 precondition 4 — runDocumentCorrection's other outcomes", { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false }, () => {
  test("blocked_by_policy: an identity document is refused, and recorded as exactly that — never failed_tool", async () => {
    await withConfirmedTrip(async (trip) => {
      const { sink, rows } = recordingSink();
      const events = new RelayAssistantEvents({ sink, flushIntervalMs: 0, log: () => {} });
      await uploadWithEvents(trip, CORRECTION_DOCS.passport, "801", { assistantEvents: events });
      await events.flush();
      const completed = rows.filter((r) => r.event_type === "relay_tool_completed");
      assert.equal(completed.length, 1);
      assert.equal(completed[0]!.outcome, "blocked_by_policy");
      assert.ok(trip.sent.some((m) => m.text === uiString("documentIdentity", "en")));
    });
  });

  test("correction_proposed: a genuine change is proposed, and recorded as exactly that", async () => {
    await withConfirmedTrip(async (trip) => {
      const { sink, rows } = recordingSink();
      const events = new RelayAssistantEvents({ sink, flushIntervalMs: 0, log: () => {} });
      await uploadWithEvents(trip, CORRECTION_DOCS.voucher, "802", { assistantEvents: events });
      await events.flush();
      const completed = rows.filter((r) => r.event_type === "relay_tool_completed");
      assert.equal(completed.length, 1);
      assert.equal(completed[0]!.outcome, "correction_proposed");
    });
  });

  test("no_new_information: a document that says nothing new is recorded as exactly that", async () => {
    await withConfirmedTrip(async (trip) => {
      const { sink, rows } = recordingSink();
      const events = new RelayAssistantEvents({ sink, flushIntervalMs: 0, log: () => {} });
      await uploadWithEvents(trip, CORRECTION_DOCS.copy, "803", { assistantEvents: events });
      await events.flush();
      const completed = rows.filter((r) => r.event_type === "relay_tool_completed");
      assert.equal(completed.length, 1);
      assert.equal(completed[0]!.outcome, "no_new_information");
    });
  });

  test("the correction chain's catch path: a write failure after a proposal is built is recorded as failed_tool", async () => {
    await withConfirmedTrip(async (trip) => {
      const { sink, rows } = recordingSink();
      const events = new RelayAssistantEvents({ sink, flushIntervalMs: 0, log: () => {} });
      const failing = failingOnCorrectionInsert(trip.pool);
      await uploadWithEvents(trip, CORRECTION_DOCS.voucher, "804", { db: failing, assistantEvents: events });
      await events.flush();
      const completed = rows.filter((r) => r.event_type === "relay_tool_completed");
      assert.equal(completed.length, 1);
      assert.equal(completed[0]!.outcome, "failed_tool");
      assert.ok(trip.logs.some((l) => l.includes("trip_bot.document_correction_failed")), "the catch path itself ran, not an early failed_tool return");
      const stored = await trip.pool.query("SELECT count(*)::int AS n FROM control_plane.trip_document_corrections WHERE trip_id = $1", [trip.tripId]);
      assert.equal(stored.rows[0].n, 0, "the failed insert stored nothing");
    });
  });

  test("a sink that throws changes nothing the family sees, across all four outcomes", async () => {
    const cases: [string, { name: string; body: string }, "clean" | "failing"][] = [
      ["blocked_by_policy", CORRECTION_DOCS.passport, "clean"],
      ["correction_proposed", CORRECTION_DOCS.voucher, "clean"],
      ["no_new_information", CORRECTION_DOCS.copy, "clean"],
      ["failed_tool (catch path)", CORRECTION_DOCS.voucher, "failing"],
    ];
    for (const [label, doc, dbMode] of cases) {
      const withoutEvents: { sent: { chatId: string; text: string }[] } = { sent: [] };
      const withThrowingSink: { sent: { chatId: string; text: string }[] } = { sent: [] };
      await withConfirmedTrip(async (trip) => {
        const db = dbMode === "failing" ? failingOnCorrectionInsert(trip.pool) : trip.pool;
        await uploadWithEvents(trip, doc, "901", { db });
        withoutEvents.sent = trip.sent;
      });
      await withConfirmedTrip(async (trip) => {
        const db = dbMode === "failing" ? failingOnCorrectionInsert(trip.pool) : trip.pool;
        const throwing = new RelayAssistantEvents({ sink: { write() { throw new Error("analytics database is down"); } }, flushIntervalMs: 0, log: () => {} });
        await uploadWithEvents(trip, doc, "901", { db, assistantEvents: throwing });
        await throwing.flush();
        withThrowingSink.sent = trip.sent;
      });
      // dc:<random correction id>:a/r differs run to run — normalize before
      // comparing, since a fresh proposal is stored (and given a fresh
      // random id) independently in each withConfirmedTrip call.
      const normalize = (sent: unknown) => JSON.parse(JSON.stringify(sent).replace(/dcor_[a-f0-9]{32}/g, "dcor_x"));
      assert.deepEqual(normalize(withThrowingSink.sent), normalize(withoutEvents.sent), `${label}: same messages with a throwing sink`);
    }
  });
});
