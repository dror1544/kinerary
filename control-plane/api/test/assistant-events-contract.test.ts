/**
 * The assistant-event contract and emitter, without a database (#177).
 *
 *   - the TypeScript allow-list IS the JSON Schema's: same properties, same
 *     enums, same required fields, same per-type rules — and the two
 *     validators agree event by event;
 *   - the validator refuses unknown fields, unknown event types, out-of-set
 *     values, and an `answered` from the relay;
 *   - an unknown category value maps to `unclassified`, never a real bucket;
 *   - the emitter never throws, never makes the caller wait, and counts what
 *     it drops; unset configuration is OFF.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { RelayConnector } from "../src/relay/connector.js";
import { makeUpgradeToken } from "../src/relay/protocol.js";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  CHANNEL_TYPES,
  channelTypeOf,
  EVENT_FIELDS,
  EVENT_RULES,
  EVENT_TYPES,
  LENGTH_BUCKETS,
  lengthBucketOf,
  MEDIA_KINDS,
  mediaKindOf,
  METADATA_FIELDS,
  OUTCOMES,
  REQUESTER_ROLES,
  requesterRoleOf,
  REQUIRED_FIELDS,
  SOURCE_SERVICES,
  TRIGGER_TYPES,
  validateAssistantEvent,
  type AssistantEvent,
} from "../src/analytics/contract.js";
import { classifyTrigger, type InboundFacts } from "../src/analytics/relay-facts.js";
import {
  ASSISTANT_EVENTS_SETTING,
  assistantEventsFromEnv,
  assistantEventsSetting,
  RelayAssistantEvents,
  type AssistantEventSink,
} from "../src/analytics/emitter.js";

const schemaPath = fileURLToPath(new URL("../../../analytics/schemas/tripbot-event.v1.json", import.meta.url));
const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
  properties: Record<string, { enum?: unknown[]; properties?: Record<string, unknown> }>;
  required: string[];
  allOf: { if: { properties: { event_type: { const: string } } }; then: { required: string[]; properties: { outcome: { enum: string[] } } } }[];
};
const ajv = new Ajv2020({ allErrors: true, strict: false });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
const schemaValidate = ajv.compile(schema);

const TRIP = "trip_0123456789abcdef0123456789abcdef";
let seq = 0;
function uuid(): string {
  seq += 1;
  return `00000000-0000-4000-8000-${seq.toString(16).padStart(12, "0")}`;
}

function valid(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    event_id: uuid(),
    trip_id: TRIP,
    occurred_at: "2026-09-18T07:15:00.000Z",
    source_service: "relay",
    event_type: "request_forwarded",
    turn_id: uuid(),
    channel_type: "group",
    trigger_type: "name",
    requester_role: "organizer",
    outcome: "dispatched",
    response_latency_ms: null,
    message_length_bucket: "1_40",
    media_kind: "none",
    metadata: { attachments_joined: 0, documents: 0 },
    ...overrides,
  };
}

// ── The two definitions are one ─────────────────────────────────────────────

describe("the TypeScript contract is the JSON Schema", () => {
  test("same properties — an allow-list, in both places", () => {
    assert.deepEqual([...EVENT_FIELDS].sort(), Object.keys(schema.properties).sort());
    assert.equal((schema as { additionalProperties?: unknown }).additionalProperties, false);
  });

  test("same required fields", () => {
    assert.deepEqual([...REQUIRED_FIELDS].sort(), [...schema.required].sort());
  });

  test("same enums, value for value", () => {
    const nonNull = (field: string) => (schema.properties[field]?.enum ?? []).filter((v) => v !== null).map(String).sort();
    assert.deepEqual(nonNull("source_service"), [...SOURCE_SERVICES].sort());
    assert.deepEqual(nonNull("event_type"), [...EVENT_TYPES].sort());
    assert.deepEqual(nonNull("channel_type"), [...CHANNEL_TYPES].sort());
    assert.deepEqual(nonNull("trigger_type"), [...TRIGGER_TYPES].sort());
    assert.deepEqual(nonNull("requester_role"), [...REQUESTER_ROLES].sort());
    assert.deepEqual(nonNull("outcome"), [...OUTCOMES].sort());
    assert.deepEqual(nonNull("message_length_bucket"), [...LENGTH_BUCKETS].sort());
    assert.deepEqual(nonNull("media_kind"), [...MEDIA_KINDS].sort());
    assert.deepEqual(Object.keys(schema.properties.metadata?.properties ?? {}).sort(), Object.keys(METADATA_FIELDS).sort());
  });

  test("same per-type rules", () => {
    const fromSchema = Object.fromEntries(schema.allOf.map((rule) => [
      rule.if.properties.event_type.const,
      { outcomes: [...rule.then.properties.outcome.enum].sort(), required: [...rule.then.required].sort() },
    ]));
    const fromTs = Object.fromEntries(Object.entries(EVENT_RULES).map(([type, rule]) => [
      type,
      { outcomes: [...rule.outcomes].sort(), required: [...rule.required].sort() },
    ]));
    assert.deepEqual(fromTs, fromSchema);
  });

  test("there is no `answered` anywhere in the relay's vocabulary", () => {
    assert.ok(!(OUTCOMES as readonly string[]).includes("answered"));
    assert.ok(!(OUTCOMES as readonly string[]).includes("answered_with_tools"));
    assert.ok(!JSON.stringify(schema.properties.outcome).includes("\"answered"));
  });

  test("the two validators agree on every event in a corpus of good and bad ones", () => {
    const corpus: Record<string, unknown>[] = [];
    for (const type of EVENT_TYPES) {
      for (const outcome of OUTCOMES) {
        corpus.push(valid({ event_type: type, outcome }));
        corpus.push(valid({ event_type: type, outcome, turn_id: null }));
        corpus.push(valid({ event_type: type, outcome, channel_type: null, trigger_type: null, requester_role: null, media_kind: null }));
      }
    }
    corpus.push(
      valid({ chat_id: "-1009876543210" }),
      valid({ text: "hello" }),
      valid({ event_type: "message_received" }),
      valid({ channel_type: "participant_dm" }),
      valid({ requester_role: "admin" }),
      valid({ outcome: "answered" }),
      valid({ trip_id: "usa2026" }),
      valid({ trip_id: null }),
      valid({ event_id: "not-a-uuid" }),
      valid({ turn_id: "sha256:abc" }),
      valid({ occurred_at: "yesterday" }),
      valid({ response_latency_ms: -1 }),
      valid({ response_latency_ms: 1.5 }),
      valid({ response_latency_ms: 86_400_001 }),
      valid({ response_latency_ms: 1840 }),
      valid({ metadata: { documents: 21 } }),
      valid({ metadata: { documents: "2" } }),
      valid({ metadata: { filename: "voucher.pdf" } }),
      valid({ metadata: { document_held: "yes" } }),
      valid({ metadata: { document_held: true } }),
      valid({ metadata: {} }),
      valid({ source_service: "hermes_plugin" }),
      valid({ message_length_bucket: "0" }),
      valid({ media_kind: "video" }),
      // occurred_at: the review's disagreements, and their neighbours.
      valid({ occurred_at: "2026-09-18 07:15:00Z" }),
      valid({ occurred_at: "2026-09-18T07:15:00+0900" }),
      valid({ occurred_at: "2026-09-18T07:15:00+09" }),
      valid({ occurred_at: "2026-09-18T07:15:00+09:00" }),
      valid({ occurred_at: "2026-09-18t07:15:00z" }),
      valid({ occurred_at: "2026-02-30T00:00:00Z" }),
      valid({ occurred_at: "2025-02-29T00:00:00Z" }),
      valid({ occurred_at: "2024-02-29T00:00:00Z" }),
      valid({ occurred_at: "2026-09-18T24:00:00Z" }),
      valid({ occurred_at: "2026-09-18T23:59:60Z" }),
      valid({ occurred_at: "2026-09-18T07:15:00.123456Z" }),
      valid({ occurred_at: "2026-09-18T07:15:00.1234567Z" }),
      valid({ occurred_at: "2026-13-01T00:00:00Z" }),
      valid({ metadata: null }),
      valid({ metadata: [] }),
    );
    for (const event of corpus) {
      const ours = validateAssistantEvent(event).ok;
      const theirs = schemaValidate(event) as boolean;
      assert.equal(ours, theirs, `validators disagree on ${JSON.stringify(event)}: ts=${ours} schema=${theirs} ${JSON.stringify(schemaValidate.errors)}`);
    }
    assert.ok(corpus.some((e) => validateAssistantEvent(e).ok), "the corpus has accepted events");
    assert.ok(corpus.some((e) => !validateAssistantEvent(e).ok), "and refused ones");
  });
});

// ── The validator refuses, never repairs ────────────────────────────────────

describe("validateAssistantEvent", () => {
  test("accepts a well-formed event", () => {
    const result = validateAssistantEvent(valid());
    assert.ok(result.ok, JSON.stringify(result));
  });

  test("refuses an unknown field — the allow-list, not a deny-list (#156)", () => {
    for (const field of ["chat_id", "user_id", "text", "caption", "filename", "url", "sender_digest", "content_fingerprint"]) {
      const result = validateAssistantEvent(valid({ [field]: "x" }));
      assert.deepEqual(result, { ok: false, reason: "UNKNOWN_FIELD" }, field);
    }
  });

  test("refuses an unknown event type", () => {
    assert.deepEqual(validateAssistantEvent(valid({ event_type: "message_received" })), { ok: false, reason: "BAD:event_type" });
  });

  test("refuses a value outside its set, in every enumerated field", () => {
    for (const field of ["channel_type", "trigger_type", "requester_role", "message_length_bucket", "media_kind", "source_service", "outcome"]) {
      const result = validateAssistantEvent(valid({ [field]: "banana" }));
      assert.equal(result.ok, false, field);
      assert.equal(!result.ok && result.reason, `BAD:${field}`);
    }
  });

  test("the relay can never write `answered`", () => {
    for (const outcome of ["answered", "answered_with_tools"]) {
      assert.deepEqual(validateAssistantEvent(valid({ outcome })), { ok: false, reason: "BAD:outcome" });
    }
  });

  test("an outcome must belong to its event type", () => {
    assert.deepEqual(
      validateAssistantEvent(valid({ event_type: "request_forwarded", outcome: "reply_delivered" })),
      { ok: false, reason: "OUTCOME_NOT_ALLOWED_FOR_TYPE" },
    );
  });

  test("an inbound event must carry every dimension, and a request its turn", () => {
    assert.deepEqual(validateAssistantEvent(valid({ requester_role: null })), { ok: false, reason: "MISSING:requester_role" });
    assert.deepEqual(validateAssistantEvent(valid({ turn_id: null })), { ok: false, reason: "MISSING:turn_id" });
    assert.deepEqual(validateAssistantEvent(valid({ trip_id: null })), { ok: false, reason: "MISSING:trip_id" });
  });

  test("metadata holds only named, bounded numbers and a boolean", () => {
    assert.deepEqual(validateAssistantEvent(valid({ metadata: { filename: "voucher.pdf" } })), { ok: false, reason: "UNKNOWN_METADATA_FIELD" });
    assert.deepEqual(validateAssistantEvent(valid({ metadata: { documents: "2" } })), { ok: false, reason: "BAD:metadata.documents" });
    assert.deepEqual(validateAssistantEvent(valid({ metadata: { documents: 99 } })), { ok: false, reason: "BAD:metadata.documents" });
  });

  test("occurred_at is strict RFC 3339 and a real calendar day", () => {
    for (const at of ["2026-09-18T07:15:00.123Z", "2026-09-18T07:15:00+09:00", "2024-02-29T00:00:00Z"]) {
      assert.ok(validateAssistantEvent(valid({ occurred_at: at })).ok, at);
    }
    for (const at of ["2026-09-18 07:15:00Z", "2026-09-18T07:15:00+0900", "2026-02-30T00:00:00Z", "2026-09-18T24:00:00Z", "2026-09-18T07:15:00.1234567Z"]) {
      assert.deepEqual(validateAssistantEvent(valid({ occurred_at: at })), { ok: false, reason: "BAD:occurred_at" }, at);
    }
  });

  test("metadata may be absent, but not null", () => {
    const { metadata: _omit, ...without } = valid();
    const absent = validateAssistantEvent(without);
    assert.ok(absent.ok && JSON.stringify(absent.event.metadata) === "{}");
    assert.deepEqual(validateAssistantEvent(valid({ metadata: null })), { ok: false, reason: "BAD:metadata" });
  });

  test("the input is read once: a getter cannot pass the check and hand over something else", () => {
    const sentence = "the family is arguing about the hotel";
    let reads = 0;
    const event = valid();
    const id = event.event_id as string;
    Object.defineProperty(event, "event_id", {
      enumerable: true,
      get: () => (reads++ === 0 ? id : sentence),
    });
    const result = validateAssistantEvent(event);
    assert.ok(result.ok);
    assert.equal(result.ok && result.event.event_id, id, "the value checked is the value returned");
    assert.equal(reads, 1);
    assert.ok(!JSON.stringify(result).includes(sentence));

    // A getter that serves a bad value first is refused; one that throws is refused.
    let second = 0;
    const flip = valid();
    Object.defineProperty(flip, "channel_type", { enumerable: true, get: () => (second++ === 0 ? sentence : "group") });
    assert.deepEqual(validateAssistantEvent(flip), { ok: false, reason: "BAD:channel_type" });
    const throwing = valid();
    Object.defineProperty(throwing, "outcome", { enumerable: true, get: () => { throw new Error(sentence); } });
    assert.deepEqual(validateAssistantEvent(throwing), { ok: false, reason: "INVALID" });
  });

  test("a refusal never echoes the refused value", () => {
    const secret = "-1009876543210";
    for (const event of [valid({ chat_id: secret }), valid({ channel_type: secret }), valid({ trip_id: secret })]) {
      const result = validateAssistantEvent(event);
      assert.equal(result.ok, false);
      assert.ok(!JSON.stringify(result).includes(secret));
    }
  });
});

// ── Unknown resolves to `unclassified` ──────────────────────────────────────

describe("mapping relay facts onto the vocabulary", () => {
  test("an unknown Telegram chat type is unclassified, not a group", () => {
    // Telegram's own `chat.type` — the mapped wire type would already have
    // folded an unknown one into "group".
    assert.equal(channelTypeOf("private", "organizer"), "organizer_dm");
    assert.equal(channelTypeOf("private", "unknown"), "other");
    assert.equal(channelTypeOf("group", "unknown"), "group");
    assert.equal(channelTypeOf("supergroup", "organizer"), "group");
    assert.equal(channelTypeOf("channel", "organizer"), "other");
    assert.equal(channelTypeOf("secret_chat", "organizer"), "unclassified");
    assert.equal(channelTypeOf("dm", "organizer"), "unclassified", "a mapped wire type is not a Telegram type");
    assert.equal(channelTypeOf(undefined, "organizer"), "unclassified");
  });

  test("an unknown person-link role is unclassified, not an organizer; no link is unknown", () => {
    assert.equal(requesterRoleOf("organizer"), "organizer");
    assert.equal(requesterRoleOf("participant"), "participant");
    assert.equal(requesterRoleOf(null), "unknown");
    assert.equal(requesterRoleOf("admin"), "unclassified");
  });

  test("an unknown attachment kind is unclassified, not none", () => {
    assert.equal(mediaKindOf(null), "none");
    assert.equal(mediaKindOf("image"), "photo");
    assert.equal(mediaKindOf("document"), "document");
    assert.equal(mediaKindOf("voice"), "audio");
    assert.equal(mediaKindOf("video"), "other");
    assert.equal(mediaKindOf("sticker"), "unclassified");
  });

  test("length is bucketed, never kept", () => {
    assert.deepEqual([0, 1, 40, 41, 160, 161, 640, 641].map(lengthBucketOf),
      ["none", "1_40", "1_40", "41_160", "41_160", "161_640", "161_640", "641_plus"]);
  });
});

describe("classifyTrigger records the gate, it does not re-decide it", () => {
  const base = {
    addressed: true, capturedAsReply: false, chatType: "group", text: "", assistantNames: ["ליב", "Liv"],
    botUsername: "Kinerary_bot", isReplyToAssistant: false,
  };
  test("each of the gate's reasons, in the gate's order", () => {
    assert.equal(classifyTrigger({ ...base, addressed: false, text: "Liv is great" }), "not_addressed",
      "the gate's verdict wins, even when a name appears");
    assert.equal(classifyTrigger({ ...base, chatType: "dm", capturedAsReply: true }), "dm");
    assert.equal(classifyTrigger({ ...base, capturedAsReply: true, text: "Liv" }), "reply_window");
    assert.equal(classifyTrigger({ ...base, isReplyToAssistant: true, text: "@Kinerary_bot" }), "reply_to_bot");
    assert.equal(classifyTrigger({ ...base, text: "@kinerary_bot what's on today" }), "mention");
    assert.equal(classifyTrigger({ ...base, text: "ליב, מה התוכנית?" }), "name");
    assert.equal(classifyTrigger({ ...base, text: "nothing here" }), "unclassified",
      "addressed for a reason this cannot name: said so, not guessed");
  });
});

// ── The emitter ─────────────────────────────────────────────────────────────

const FACTS: InboundFacts = {
  tripId: TRIP,
  channelType: "group",
  triggerType: "name",
  requesterRole: "organizer",
  mediaKind: "none",
  lengthBucket: "1_40",
};

function recordingSink(): AssistantEventSink & { batches: AssistantEvent[][] } {
  const batches: AssistantEvent[][] = [];
  return { batches, async write(events) { batches.push(events); return { inserted: events.length, duplicates: 0, rejected: [] }; } };
}

describe("RelayAssistantEvents", () => {
  test("every call the relay makes is synchronous — nothing for the relay to await", () => {
    const events = new RelayAssistantEvents({ sink: recordingSink(), flushIntervalMs: 0 });
    const results = [
      events.notAddressed(FACTS),
      events.handedOff("-1009876543210", FACTS, true, "41"),
      events.companionUnreachable("-1009876543210", FACTS),
      events.replySent("-1009876543210", "delivered", 12, "41"),
      events.relayToolCompleted(events.toRelay("7123456789", { ...FACTS, channelType: "organizer_dm" }), "failed_tool", 1),
    ];
    for (const value of results) assert.ok(!(value instanceof Promise));
    assert.equal(events.stats.queued, 6);
  });

  test("a sink that throws costs events, counted — never an exception to the caller", async () => {
    const events = new RelayAssistantEvents({
      sink: { write() { throw new Error("boom"); } },
      flushIntervalMs: 0,
    });
    events.handedOff("-1009876543210", FACTS, true);
    events.notAddressed(FACTS);
    await events.flush();
    assert.equal(events.stats.dropped, 2);
    assert.equal(events.stats.queued, 0);
  });

  test("a sink that never answers is abandoned at the timeout and counted", async () => {
    const lines: string[] = [];
    const events = new RelayAssistantEvents({
      sink: { write: () => new Promise(() => {}) },
      flushIntervalMs: 0,
      writeTimeoutMs: 30,
      log: (line) => lines.push(line),
    });
    events.notAddressed(FACTS);
    const started = Date.now();
    await events.flush();
    assert.ok(Date.now() - started < 2_000);
    assert.equal(events.stats.dropped, 1);
    assert.ok(lines.some((l) => l.includes("relay.assistant_events_dropped") && l.includes("WRITE_TIMEOUT")));
  });

  test("a hung write stays the ONE write: later ticks start nothing until it settles", async () => {
    let started = 0;
    let outstanding = 0;
    let peakOutstanding = 0;
    let release: () => void = () => {};
    const events = new RelayAssistantEvents({
      sink: {
        write() {
          started += 1;
          outstanding += 1;
          peakOutstanding = Math.max(peakOutstanding, outstanding);
          return new Promise<void>((resolve) => {
            release = () => { outstanding -= 1; resolve(); };
          });
        },
      },
      flushIntervalMs: 0,
      writeTimeoutMs: 20,
      batchSize: 1,
    });
    for (let i = 0; i < 6; i += 1) events.notAddressed(FACTS);
    for (let tick = 0; tick < 8; tick += 1) {
      await events.flush();
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(started, 1, "eight ticks past the timeout, still only the first write was ever started");
    assert.equal(peakOutstanding, 1);
    assert.equal(events.stats.writeOutstanding, true);
    assert.equal(events.stats.dropped, 1, "the abandoned batch is counted");
    assert.equal(events.stats.queued, 5, "the rest wait — and would drop at the queue limit, not open connections");

    release();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(events.stats.writeOutstanding, false);
    await events.flush();
    assert.equal(started, 2, "once it settles, the next write may start");
    assert.equal(peakOutstanding, 1, "and never two at once");
    release();
  });

  test("stop() writes every batch it can within its own deadline", async () => {
    const sink = recordingSink();
    const events = new RelayAssistantEvents({ sink, flushIntervalMs: 0, batchSize: 2 });
    for (let i = 0; i < 5; i += 1) events.notAddressed(FACTS);
    await events.stop();
    assert.deepEqual(sink.batches.map((b) => b.length), [2, 2, 1]);
    assert.equal(events.stats.dropped, 0);
  });

  test("stop() does not outlast its deadline behind a hung write, and counts what it could not write", async () => {
    const events = new RelayAssistantEvents({
      sink: { write: () => new Promise(() => {}) },
      flushIntervalMs: 0,
      writeTimeoutMs: 10_000,
      batchSize: 2,
    });
    for (let i = 0; i < 5; i += 1) events.notAddressed(FACTS);
    void events.flush();
    const started = Date.now();
    await events.stop(150);
    const took = Date.now() - started;
    assert.ok(took < 1_000, `stop took ${took} ms`);
    assert.equal(events.stats.queued, 0);
    assert.equal(events.stats.dropped, 3, "the three still queued; the in-flight two are its own timeout's to count");
  });

  test("a log function that throws never escapes — not to the relay, not as an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const events = new RelayAssistantEvents({
        sink: { write() { throw new Error("database down"); } },
        log: () => { throw new Error("log sink down"); },
        flushIntervalMs: 5,
      });
      events.start();
      assert.doesNotThrow(() => events.notAddressed({ ...FACTS, tripId: "not a trip" }), "invalid-event log");
      for (let i = 0; i < 3; i += 1) assert.doesNotThrow(() => events.notAddressed(FACTS));
      await new Promise((r) => setTimeout(r, 60));
      await events.stop();
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(events.stats.dropped, 3);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("a reply_to naming no open request is recorded with no turn, and does not answer the one waiting", async () => {
    let now = 1_000_000;
    const sink = recordingSink();
    const events = new RelayAssistantEvents({ sink, flushIntervalMs: 0, now: () => now, continuationMs: 60_000 });
    const chat = "-1009876543210";
    events.handedOff(chat, FACTS, true, "A");
    now += 1_000;
    events.replySent(chat, "delivered", 20, "A"); // answers A
    now += 120_000; // A's continuation window is over
    events.handedOff(chat, FACTS, true, "B");
    now += 1_000;
    events.replySent(chat, "delivered", 20, "A"); // a late follow-up to A — not B's answer
    now += 2_000;
    events.replySent(chat, "delivered", 20, "B"); // B's real answer
    await events.flush();
    const rows = sink.batches.flat();
    const [turnA, turnB] = rows.filter((r) => r.event_type === "request_forwarded").map((r) => r.turn_id);
    const replies = rows.filter((r) => r.event_type === "reply_sent").map((r) => [
      r.turn_id === turnA ? "A" : r.turn_id === turnB ? "B" : "none", r.response_latency_ms,
    ]);
    assert.deepEqual(replies, [["A", 1_000], ["none", null], ["B", 3_000]]);
  });

  test("a full queue drops the newest and counts it, rather than growing", () => {
    const events = new RelayAssistantEvents({ sink: recordingSink(), flushIntervalMs: 0, queueLimit: 3 });
    for (let i = 0; i < 5; i += 1) events.notAddressed(FACTS);
    assert.equal(events.stats.queued, 3);
    assert.equal(events.stats.dropped, 2);
  });

  test("only one write is in flight at a time", async () => {
    let concurrent = 0;
    let peak = 0;
    const events = new RelayAssistantEvents({
      sink: {
        async write() {
          concurrent += 1;
          peak = Math.max(peak, concurrent);
          await new Promise((r) => setTimeout(r, 20));
          concurrent -= 1;
        },
      },
      flushIntervalMs: 0,
      batchSize: 1,
    });
    for (let i = 0; i < 4; i += 1) events.notAddressed(FACTS);
    await Promise.all([events.flush(), events.flush(), events.flush()]);
    assert.equal(peak, 1);
  });

  test("a reply is matched to its request: reply_to first, then oldest waiting, then the answer in progress", async () => {
    let now = 1_000_000;
    const sink = recordingSink();
    const events = new RelayAssistantEvents({ sink, flushIntervalMs: 0, now: () => now });
    const chat = "-1009876543210";
    events.handedOff(chat, FACTS, true, "100");
    now += 1_000;
    events.handedOff(chat, FACTS, true, "101");
    now += 2_000;
    events.replySent(chat, "delivered", 80, "101"); // answers the second, by reply_to
    now += 500;
    events.replySent(chat, "delivered", 80, "101"); // more of the same answer
    now += 1_000;
    events.replySent(chat, "delivered", 80); // no reply_to: the oldest still waiting
    now += 1_000;
    events.replySent(chat, "failed", 80); // nothing waiting: continuation of the last answer
    await events.flush();
    const rows = sink.batches.flat();
    const turns = rows.filter((r) => r.event_type === "request_forwarded").map((r) => r.turn_id);
    const replies = rows.filter((r) => r.event_type === "reply_sent");
    assert.deepEqual(replies.map((r) => [r.turn_id === turns[0] ? "first" : r.turn_id === turns[1] ? "second" : "none", r.outcome, r.response_latency_ms]), [
      ["second", "reply_delivered", 2_000],
      ["second", "reply_delivered", 2_500],
      ["first", "reply_delivered", 4_500],
      ["first", "failed_delivery", 5_500],
    ]);
  });

  test("a failed send does not answer the request it was for", async () => {
    const sink = recordingSink();
    const events = new RelayAssistantEvents({ sink, flushIntervalMs: 0 });
    events.handedOff("-1009876543210", FACTS, true, "100");
    events.replySent("-1009876543210", "failed", 10, "100");
    events.replySent("-1009876543210", "delivered", 10, "100");
    await events.flush();
    const replies = sink.batches.flat().filter((r) => r.event_type === "reply_sent");
    assert.equal(replies.length, 2);
    assert.equal(replies[0]!.turn_id, replies[1]!.turn_id, "both belong to the one request");
  });

  test("a message to a chat the relay knows nothing about is not recorded, only counted", async () => {
    const sink = recordingSink();
    const events = new RelayAssistantEvents({ sink, flushIntervalMs: 0 });
    events.replySent("-1001111111111", "delivered", 10);
    await events.flush();
    assert.equal(sink.batches.flat().length, 0);
    assert.equal(events.stats.unattributedReplies, 1);
  });

  test("a gateway that took nothing is a lost turn, not a request", async () => {
    const sink = recordingSink();
    const events = new RelayAssistantEvents({ sink, flushIntervalMs: 0 });
    events.handedOff("-1009876543210", FACTS, false);
    await events.flush();
    assert.deepEqual(sink.batches.flat().map((r) => [r.event_type, r.outcome, r.turn_id]), [["turn_lost", "lost_gateway_unavailable", null]]);
  });

  test("a malformed descriptor is refused and counted as a bug, never queued", () => {
    const lines: string[] = [];
    const events = new RelayAssistantEvents({ sink: recordingSink(), flushIntervalMs: 0, log: (l) => lines.push(l) });
    events.notAddressed({ ...FACTS, tripId: "not a trip" });
    assert.equal(events.stats.queued, 0);
    assert.equal(events.stats.rejected, 1);
    assert.ok(lines.some((l) => l.includes("relay.assistant_event_invalid")));
    assert.ok(!lines.join("\n").includes("not a trip"), "the log names the field, not the value");
  });
});

describe("the connector's reply hook", () => {
  test("a Telegram send that THROWS is recorded as failed_delivery, and the gateway gets the same answer as before", async () => {
    const secret = "hook-secret";
    const observed: [string, string][] = [];
    const telegram = {
      async sendMessage(): Promise<never> { throw new TypeError("fetch failed"); },
      async editMessageText() { return { ok: true }; },
      async sendChatAction() {},
      async answerCallbackQuery() {},
      async getChatInfo() { return null; },
      async getMe() { return null; },
      async getUpdates() { return []; },
      async deleteWebhookIfPresent() {},
      async fetchFile() { return null; },
    };
    const results: Record<string, unknown>[] = [];
    for (const withHook of [false, true]) {
      const connector = new RelayConnector({
        gatewaySecrets: [secret],
        telegram,
        port: 0,
        ...(withHook ? { assistantEvents: { replySent: (chat: string, delivery: string) => { observed.push([chat, delivery]); } } } : {}),
      });
      await connector.listen();
      try {
        const ws = new WebSocket(`ws://127.0.0.1:${connector.address}/relay`, {
          headers: { authorization: `Bearer ${makeUpgradeToken("companion-x", secret, 300)}` },
        });
        const frames: Record<string, unknown>[] = [];
        ws.on("message", (raw) => { for (const line of String(raw).split("\n")) if (line.trim()) frames.push(JSON.parse(line)); });
        await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
        ws.send(JSON.stringify({ type: "outbound", requestId: "r1", action: { op: "send", chat_id: "-1001", content: "hi" } }) + "\n");
        const deadline = Date.now() + 2_000;
        while (!frames.some((f) => f.type === "outbound_result") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
        results.push(frames.find((f) => f.type === "outbound_result")!);
        ws.close();
      } finally {
        await connector.close();
      }
    }
    assert.deepEqual(results[1], results[0], "same outbound_result with the hook as without");
    assert.deepEqual(results[0], { type: "outbound_result", requestId: "r1", result: { success: false, error: "SEND_FAILED" } });
    assert.deepEqual(observed, [["-1001", "failed"]]);
  });
});

describe("the setting: unset is OFF", () => {
  test("only 1 turns it on (whitespace around it ignored)", () => {
    assert.equal(ASSISTANT_EVENTS_SETTING, "ASSISTANT_EVENTS_ENABLED");
    assert.deepEqual(assistantEventsSetting({}), { enabled: false, unrecognized: false });
    assert.deepEqual(assistantEventsSetting({ ASSISTANT_EVENTS_ENABLED: "" }), { enabled: false, unrecognized: false });
    assert.deepEqual(assistantEventsSetting({ ASSISTANT_EVENTS_ENABLED: "0" }), { enabled: false, unrecognized: false });
    assert.deepEqual(assistantEventsSetting({ ASSISTANT_EVENTS_ENABLED: "true" }), { enabled: false, unrecognized: true });
    assert.deepEqual(assistantEventsSetting({ ASSISTANT_EVENTS_ENABLED: " 1 " }), { enabled: true, unrecognized: false });
  });

  test("unset builds no emitter, and says so in the log", () => {
    const lines: string[] = [];
    const fakePool = {} as never;
    assert.equal(assistantEventsFromEnv({}, fakePool, (l) => lines.push(l)), undefined);
    assert.ok(lines.some((l) => l.includes("\"relay.assistant_events\"") && l.includes("\"enabled\":false")));
  });

  test("a value that is not 1 is off, and says it was not understood", () => {
    const lines: string[] = [];
    assert.equal(assistantEventsFromEnv({ ASSISTANT_EVENTS_ENABLED: "yes" }, {} as never, (l) => lines.push(l)), undefined);
    assert.ok(lines.some((l) => l.includes("relay.assistant_events_setting_unrecognized")));
  });

  test("no database, no emitter — whatever the setting", () => {
    assert.equal(assistantEventsFromEnv({ ASSISTANT_EVENTS_ENABLED: "1" }, undefined, () => {}), undefined);
  });
});
