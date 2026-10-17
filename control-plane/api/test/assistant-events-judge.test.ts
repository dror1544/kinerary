/**
 * The group judge's accountability (owner's KPIs, 2026-10-16): every judge
 * decision is an assistant event; two live accuracy PROXIES (missed, over-eager)
 * are computed from events alone; speed and fallbacks are rates; the daily report
 * has a section for it. None of it may carry message text or an identifier.
 *
 * Part 1 needs no database (contract, emitter). Part 2 is DB-backed (the table's
 * CHECK constraints as a second line, the rollup join, rates, report).
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { validateAssistantEvent, type AssistantEvent } from "../src/analytics/contract.js";
import { classifyTrigger, type InboundFacts, type JudgeFacts } from "../src/analytics/relay-facts.js";
import { JUDGE_MISSED_WINDOW_MS, RelayAssistantEvents, type AssistantEventSink } from "../src/analytics/emitter.js";
import { rollupAssistantEvents, writeAssistantEvents } from "../src/analytics/store.js";
import { deriveRates } from "../src/analytics/rates.js";
import { renderDailyReport } from "../src/analytics/report.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const TRIP = "trip_0123456789abcdef0123456789abcdef";
const CHAT = "-1001234567890";
const SENDER = "7123456789";

function recordingSink(): AssistantEventSink & { all: AssistantEvent[] } {
  const all: AssistantEvent[] = [];
  return { all, async write(events) { all.push(...events); return { inserted: events.length, duplicates: 0, rejected: [] }; } };
}

function factsOf(overrides: Partial<InboundFacts> = {}): InboundFacts {
  return {
    tripId: TRIP,
    channelType: "group",
    triggerType: "not_addressed",
    requesterRole: "unknown",
    mediaKind: "none",
    lengthBucket: "41_160",
    chatKey: CHAT,
    senderKey: SENDER,
    ...overrides,
  };
}

const judge = (j: Partial<JudgeFacts> & Pick<JudgeFacts, "outcome">): JudgeFacts => ({ latencyMs: 300, model: "vendor/free-model:free", ...j });

async function drain(events: RelayAssistantEvents, sink: { all: AssistantEvent[] }): Promise<AssistantEvent[]> {
  await events.flush();
  return sink.all.splice(0);
}

const byType = (events: AssistantEvent[], type: string) => events.filter((e) => e.event_type === type);

describe("the contract admits the judge's events - and only those", () => {
  const base = (over: Record<string, unknown> = {}) => ({
    event_id: randomUUID(), trip_id: TRIP, occurred_at: "2026-10-16T10:00:00.000Z", source_service: "relay",
    event_type: "group_judged", turn_id: null, channel_type: "group", trigger_type: "not_addressed",
    requester_role: "unknown", outcome: "judge_no", response_latency_ms: 300, message_length_bucket: "1_40",
    media_kind: "none", metadata: { judge_confidence_pct: 90, judge_model: "vendor/m:free" }, ...over,
  });

  test("a judge decision with its bounded metadata validates", () => {
    for (const outcome of ["judge_yes", "judge_no", "judge_fallback", "judge_missed"]) {
      assert.ok(validateAssistantEvent(base({ outcome })).ok, outcome);
    }
    assert.ok(validateAssistantEvent(base({ outcome: "judge_fallback", metadata: { judge_fallback_reason: "timeout" } })).ok);
    assert.ok(validateAssistantEvent(base({ outcome: "judge_fallback", metadata: { judge_fallback_reason: "circuit_open" } })).ok, "an open circuit is recorded, not a silent gap");
    assert.ok(validateAssistantEvent(base({ metadata: { judge_below_threshold: true, judge_confidence_pct: 65 } })).ok);
  });

  test("text cannot ride in the metadata: model ids are restricted, reasons are a closed set, confidence is 0..100", () => {
    for (const metadata of [
      { judge_model: "has a space in it" },
      { judge_model: "line\nbreak" },
      { judge_model: "x".repeat(81) },
      { judge_model: "" },
      { judge_fallback_reason: "the user wrote a secret" },
      { judge_confidence_pct: 101 },
      { judge_confidence_pct: 0.5 },
      { judge_below_threshold: "yes" },
      { judge_text: "what time is check-in" },
    ]) {
      assert.equal(validateAssistantEvent(base({ metadata })).ok, false, JSON.stringify(metadata));
    }
  });

  test("a judge outcome belongs to group_judged only, and group_judged takes no other outcome", () => {
    assert.equal(validateAssistantEvent(base({ event_type: "ignored_not_addressed", outcome: "judge_no" })).ok, false);
    assert.equal(validateAssistantEvent(base({ outcome: "dispatched" })).ok, false);
    assert.equal(validateAssistantEvent(base({ requester_role: null })).ok, false, "dimensions are required");
  });

  test("the judge trigger is a trigger, and classifyTrigger names it only after every other reason", () => {
    const input = { addressed: true, capturedByJudge: true, capturedByConversation: false, capturedAsReply: false, chatType: "group", text: "when do we leave?", assistantNames: ["Liv"], isReplyToAssistant: false };
    assert.equal(classifyTrigger(input), "judge");
    assert.equal(classifyTrigger({ ...input, text: "Liv when do we leave?" }), "name");
    assert.equal(classifyTrigger({ ...input, capturedByConversation: true }), "conversation_window");
    assert.equal(classifyTrigger({ ...input, addressed: false }), "not_addressed");
  });
});

describe("RelayAssistantEvents records the judge", () => {
  test("a yes: a group_judged row sharing the turn id of the request it caused, and the reply that follows joins that turn", async () => {
    const sink = recordingSink();
    let now = Date.parse("2026-10-16T10:00:00Z");
    const events = new RelayAssistantEvents({ sink, flushIntervalMs: 0, now: () => now });
    events.handedOff(CHAT, factsOf({ triggerType: "judge", judge: judge({ outcome: "judge_yes", confidencePct: 90 }) }), true, "41");
    now += 2_000;
    events.replySent(CHAT, "suppressed", 25, "41");
    const rows = await drain(events, sink);

    const forwarded = byType(rows, "request_forwarded")[0]!;
    const judged = byType(rows, "group_judged")[0]!;
    assert.equal(forwarded.trigger_type, "judge");
    assert.equal(judged.outcome, "judge_yes");
    assert.equal(judged.turn_id, forwarded.turn_id, "the same turn");
    assert.equal(judged.response_latency_ms, 300, "the judge's own latency");
    assert.deepEqual(judged.metadata, { judge_confidence_pct: 90, judge_model: "vendor/free-model:free" });
    const reply = byType(rows, "reply_sent")[0]!;
    assert.equal(reply.turn_id, forwarded.turn_id);
    assert.equal(reply.outcome, "reply_suppressed", "the companion stayed silent");
  });

  test("a no, a below-threshold no and a fallback: each an event beside the ignore, no turn", async () => {
    const sink = recordingSink();
    const events = new RelayAssistantEvents({ sink, flushIntervalMs: 0 });
    events.notAddressed(factsOf({ judge: judge({ outcome: "judge_no", confidencePct: 95 }) }));
    events.notAddressed(factsOf({ judge: judge({ outcome: "judge_no", confidencePct: 62, belowThreshold: true }) }));
    events.notAddressed(factsOf({ judge: judge({ outcome: "judge_fallback", fallbackReason: "timeout", latencyMs: 3000 }) }));
    const rows = await drain(events, sink);
    assert.equal(byType(rows, "ignored_not_addressed").length, 3, "the ignore is recorded as ever");
    const judged = byType(rows, "group_judged");
    assert.deepEqual(judged.map((j) => j.outcome), ["judge_no", "judge_no", "judge_fallback"]);
    assert.ok(judged.every((j) => j.turn_id === null));
    assert.deepEqual(judged[1]!.metadata, { judge_confidence_pct: 62, judge_model: "vendor/free-model:free", judge_below_threshold: true });
    assert.deepEqual(judged[2]!.metadata, { judge_model: "vendor/free-model:free", judge_fallback_reason: "timeout" });
    assert.equal(judged[2]!.response_latency_ms, 3000);
  });

  test("a model id the contract would refuse is left out; the decision is still recorded", async () => {
    const sink = recordingSink();
    const events = new RelayAssistantEvents({ sink, flushIntervalMs: 0 });
    events.notAddressed(factsOf({ judge: judge({ outcome: "judge_no", model: "a model with spaces", confidencePct: 80 }) }));
    const rows = await drain(events, sink);
    assert.deepEqual(byType(rows, "group_judged")[0]!.metadata, { judge_confidence_pct: 80 });
    assert.equal(events.stats.rejected, 0);
  });

  test("MISSED proxy: the same sender, within three minutes, addressed by name - after a judge no", async () => {
    const sink = recordingSink();
    let now = Date.parse("2026-10-16T10:00:00Z");
    const events = new RelayAssistantEvents({ sink, flushIntervalMs: 0, now: () => now });
    events.notAddressed(factsOf({ judge: judge({ outcome: "judge_no", confidencePct: 90 }) }));
    now += 40_000;
    events.handedOff(CHAT, factsOf({ triggerType: "name" }), true, "42");
    const rows = await drain(events, sink);
    const missed = byType(rows, "group_judged").filter((e) => e.outcome === "judge_missed");
    assert.equal(missed.length, 1);
    assert.equal(missed[0]!.response_latency_ms, 40_000, "the gap since the no");
    assert.equal(missed[0]!.trigger_type, "name", "the dimensions are the follow-up's");
    assert.equal(missed[0]!.turn_id, null);
  });

  test("not a miss: a different sender, a different chat, too late, a non-explicit trigger, or an intervening message", async () => {
    const run = async (mutate: (events: RelayAssistantEvents, set: (ms: number) => void) => void) => {
      const sink = recordingSink();
      let now = Date.parse("2026-10-16T10:00:00Z");
      const events = new RelayAssistantEvents({ sink, flushIntervalMs: 0, now: () => now });
      events.notAddressed(factsOf({ judge: judge({ outcome: "judge_no", confidencePct: 90 }) }));
      mutate(events, (ms) => { now += ms; });
      return (await drain(events, sink)).filter((e) => e.outcome === "judge_missed");
    };
    assert.equal((await run((e, wait) => { wait(1000); e.handedOff(CHAT, factsOf({ triggerType: "name", senderKey: "555" }), true, "1"); })).length, 0, "other sender");
    assert.equal((await run((e, wait) => { wait(1000); e.handedOff("-100999", factsOf({ triggerType: "name", chatKey: "-100999" }), true, "1"); })).length, 0, "other chat");
    assert.equal((await run((e, wait) => { wait(JUDGE_MISSED_WINDOW_MS + 1); e.handedOff(CHAT, factsOf({ triggerType: "name" }), true, "1"); })).length, 0, "too late");
    assert.equal((await run((e, wait) => { wait(JUDGE_MISSED_WINDOW_MS); e.handedOff(CHAT, factsOf({ triggerType: "mention" }), true, "1"); })).length, 1, "exactly three minutes still counts");
    assert.equal((await run((e, wait) => { wait(1000); e.handedOff(CHAT, factsOf({ triggerType: "conversation_window" }), true, "1"); })).length, 0, "a window forward is not the sender addressing it");
    assert.equal((await run((e, wait) => { wait(1000); e.handedOff(CHAT, factsOf({ triggerType: "judge", judge: judge({ outcome: "judge_yes" }) }), true, "1"); })).length, 0, "a judge yes is not either");
    assert.equal((await run((e, wait) => { wait(1000); e.notAddressed(factsOf()); wait(1000); e.handedOff(CHAT, factsOf({ triggerType: "name" }), true, "1"); })).length, 0, "their NEXT message was something else");
    assert.equal((await run((e, wait) => { wait(1000); e.handedOff(CHAT, factsOf({ triggerType: "reply_to_bot" }), true, "1"); })).length, 1, "a reply to the bot is addressing it");
  });

  test("it counts once: a second explicit message is not a second miss", async () => {
    const sink = recordingSink();
    const events = new RelayAssistantEvents({ sink, flushIntervalMs: 0 });
    events.notAddressed(factsOf({ judge: judge({ outcome: "judge_no", confidencePct: 90 }) }));
    events.handedOff(CHAT, factsOf({ triggerType: "name" }), true, "1");
    events.handedOff(CHAT, factsOf({ triggerType: "name" }), true, "2");
    assert.equal((await drain(events, sink)).filter((e) => e.outcome === "judge_missed").length, 1);
  });

  test("a fallback is not a 'no' for the missed proxy", async () => {
    const sink = recordingSink();
    const events = new RelayAssistantEvents({ sink, flushIntervalMs: 0 });
    events.notAddressed(factsOf({ judge: judge({ outcome: "judge_fallback", fallbackReason: "error" }) }));
    events.handedOff(CHAT, factsOf({ triggerType: "name" }), true, "1");
    assert.equal((await drain(events, sink)).filter((e) => e.outcome === "judge_missed").length, 0);
  });

  test("NO identifier or text reaches any event: the chat and sender keys stay in memory", async () => {
    const sink = recordingSink();
    const events = new RelayAssistantEvents({ sink, flushIntervalMs: 0 });
    events.notAddressed(factsOf({ judge: judge({ outcome: "judge_no", confidencePct: 90 }) }));
    events.handedOff(CHAT, factsOf({ triggerType: "name" }), true, "42");
    events.handedOff(CHAT, factsOf({ triggerType: "judge", judge: judge({ outcome: "judge_yes", confidencePct: 80 }) }), true, "43");
    events.replySent(CHAT, "suppressed", 25, "43");
    const rows = await drain(events, sink);
    assert.ok(rows.length >= 6);
    const text = JSON.stringify(rows);
    assert.ok(!text.includes(SENDER) && !text.includes(CHAT.slice(1)), "no sender or chat id in any event");
    assert.equal(events.stats.rejected, 0, "and every event validated");
  });

  test("its bookkeeping is bounded: the missed map cannot grow without limit", async () => {
    const sink = recordingSink();
    const events = new RelayAssistantEvents({ sink, flushIntervalMs: 0, maxChats: 5 });
    for (let i = 0; i < 50; i += 1) events.notAddressed(factsOf({ senderKey: `${i}`, judge: judge({ outcome: "judge_no", confidencePct: 90 }) }));
    events.handedOff(CHAT, factsOf({ triggerType: "name", senderKey: "0" }), true, "1");
    assert.equal((await drain(events, sink)).filter((e) => e.outcome === "judge_missed").length, 0, "the oldest was forgotten");
  });
});

describe("the proactive level change is an event - counts only", () => {
  const change = (over: Record<string, unknown> = {}) => ({
    event_id: randomUUID(), trip_id: TRIP, occurred_at: "2026-10-16T10:00:00.000Z", source_service: "relay",
    event_type: "proactive_level_changed", turn_id: null, channel_type: "group", trigger_type: null,
    requester_role: "organizer", outcome: "level_lowered", response_latency_ms: null,
    message_length_bucket: null, media_kind: null, metadata: { proactive_level: 1 }, ...over,
  });

  test("validates with its level; the level is required and bounded 1..3; outcomes are its own", () => {
    assert.ok(validateAssistantEvent(change()).ok);
    assert.ok(validateAssistantEvent(change({ outcome: "level_raised", metadata: { proactive_level: 3 } })).ok);
    for (const bad of [
      change({ metadata: {} }),
      change({ metadata: { proactive_level: 0 } }),
      change({ metadata: { proactive_level: 4 } }),
      change({ metadata: { proactive_level: "2" } }),
      change({ outcome: "dispatched" }),
      change({ outcome: "judge_no" }),
      change({ requester_role: null }),
      change({ event_type: "group_judged", outcome: "level_raised" }),
    ]) {
      assert.equal(validateAssistantEvent(bad).ok, false, JSON.stringify(bad));
    }
    const { metadata: _drop, ...noMetadata } = change();
    assert.equal(validateAssistantEvent(noMetadata).ok, false, "absent metadata is not a level");
  });

  test("the emitter writes one event per change, with no chat, no person and no text", async () => {
    const sink = recordingSink();
    const events = new RelayAssistantEvents({ sink, flushIntervalMs: 0 });
    events.proactiveLevelChanged({ tripId: TRIP, level: 1, direction: "lowered" });
    events.proactiveLevelChanged({ tripId: TRIP, level: 3, direction: "raised" });
    const rows = await drain(events, sink);
    assert.deepEqual(rows.map((r) => [r.event_type, r.outcome, r.metadata.proactive_level, r.channel_type, r.requester_role]), [
      ["proactive_level_changed", "level_lowered", 1, "group", "organizer"],
      ["proactive_level_changed", "level_raised", 3, "group", "organizer"],
    ]);
    assert.equal(events.stats.rejected, 0);
    assert.ok(rows.every((r) => r.turn_id === null && r.message_length_bucket === null && r.trigger_type === null));
  });
});

// ── DB-backed ───────────────────────────────────────────────────────────────

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

async function withDb(fn: (pool: pg.Pool, tripId: string) => Promise<void>): Promise<void> {
  const pool = testPool();
  const client = await pool.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
    await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    await applyMigrations(client, migrationsDir);
  } finally {
    client.release();
  }
  try {
    const tripId = `trip_${randomBytes(16).toString("hex")}`;
    await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')", [tripId, tripId.replace(/_/g, "-")]);
    await fn(pool, tripId);
  } finally {
    await pool.end();
  }
}

const DAY = "2026-10-16";
let tick = 0;
function row(tripId: string, over: Partial<AssistantEvent>): AssistantEvent {
  tick += 1;
  return {
    event_id: randomUUID(), trip_id: tripId, occurred_at: `${DAY}T10:${String(Math.floor(tick / 60)).padStart(2, "0")}:${String(tick % 60).padStart(2, "0")}.000Z`,
    source_service: "relay", event_type: "group_judged", turn_id: null, channel_type: "group", trigger_type: "not_addressed",
    requester_role: "unknown", outcome: "judge_no", response_latency_ms: 300, message_length_bucket: "41_160", media_kind: "none",
    metadata: { judge_confidence_pct: 90, judge_model: "vendor/free-model:free" }, tool_name: null, ...over,
  };
}

describe("the table and the rollup", { skip: SKIP }, () => {
  test("the table refuses what the contract refuses, as a second line", async () => {
    await withDb(async (pool, tripId) => {
      const insert = (e: AssistantEvent) => pool.query(
        `INSERT INTO control_plane.assistant_events
           (event_id, trip_id, occurred_at, source_service, event_type, turn_id, channel_type, trigger_type, requester_role, outcome,
            response_latency_ms, message_length_bucket, media_kind, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [e.event_id, e.trip_id, e.occurred_at, e.source_service, e.event_type, e.turn_id, e.channel_type, e.trigger_type, e.requester_role, e.outcome, e.response_latency_ms, e.message_length_bucket, e.media_kind, JSON.stringify(e.metadata)],
      );
      await insert(row(tripId, {}));
      await insert(row(tripId, { outcome: "judge_fallback", metadata: { judge_fallback_reason: "rate_limited" } }));
      await insert(row(tripId, { outcome: "judge_fallback", response_latency_ms: 0, metadata: { judge_fallback_reason: "circuit_open", judge_model: "vendor/m" } }));
      await insert(row(tripId, { trigger_type: "judge", outcome: "judge_yes" }));
      await insert(row(tripId, { event_type: "proactive_level_changed", outcome: "level_lowered", trigger_type: null, response_latency_ms: null, message_length_bucket: null, media_kind: null, requester_role: "organizer", metadata: { proactive_level: 1 } }));
      for (const bad of [
        row(tripId, { metadata: { judge_model: "has a space" } as never }),
        row(tripId, { metadata: { judge_fallback_reason: "because" } as never }),
        row(tripId, { metadata: { judge_confidence_pct: 101 } as never }),
        row(tripId, { metadata: { judge_below_threshold: "yes" } as never }),
        row(tripId, { metadata: { judge_text: "hello" } as never }),
        row(tripId, { outcome: "dispatched" }),
        row(tripId, { event_type: "ignored_not_addressed", outcome: "judge_no" }),
        row(tripId, { requester_role: null }),
        row(tripId, { event_type: "proactive_level_changed", outcome: "level_raised", trigger_type: null, metadata: {} }),
        row(tripId, { event_type: "proactive_level_changed", outcome: "level_raised", trigger_type: null, metadata: { proactive_level: 4 } as never }),
        row(tripId, { event_type: "proactive_level_changed", outcome: "judge_no", trigger_type: null, metadata: { proactive_level: 2 } }),
      ]) {
        await assert.rejects(insert(bad), /violates check constraint/, JSON.stringify(bad.metadata) + bad.outcome);
      }
    });
  });

  test("the writer accepts the judge's events end to end (validated, idempotent)", async () => {
    await withDb(async (pool, tripId) => {
      const events = [row(tripId, {}), row(tripId, { outcome: "judge_missed", trigger_type: "name", response_latency_ms: 50_000, metadata: {} })];
      assert.deepEqual((await writeAssistantEvents(pool, events)).rejected, []);
      assert.equal((await writeAssistantEvents(pool, events)).duplicates, 2);
    });
  });

  test("the rollup computes volume, the two proxies, speed, fallbacks and model - with the over-eager join on the turn", async () => {
    await withDb(async (pool, tripId) => {
      const turnSilent = randomUUID();
      const turnAnswered = randomUUID();
      const turnMixed = randomUUID();
      const events: AssistantEvent[] = [
        // Two yeses: the companion stayed silent on one (over-eager), answered the other.
        row(tripId, { outcome: "judge_yes", trigger_type: "judge", turn_id: turnSilent, response_latency_ms: 400 }),
        row(tripId, { event_type: "request_forwarded", outcome: "dispatched", trigger_type: "judge", turn_id: turnSilent, response_latency_ms: null, metadata: {} }),
        row(tripId, { event_type: "reply_sent", outcome: "reply_suppressed", turn_id: turnSilent, response_latency_ms: 1500, metadata: {}, channel_type: "group", trigger_type: "judge" }),
        row(tripId, { outcome: "judge_yes", trigger_type: "judge", turn_id: turnAnswered, response_latency_ms: 500 }),
        row(tripId, { event_type: "request_forwarded", outcome: "dispatched", trigger_type: "judge", turn_id: turnAnswered, response_latency_ms: null, metadata: {} }),
        row(tripId, { event_type: "reply_sent", outcome: "reply_delivered", turn_id: turnAnswered, response_latency_ms: 4000, metadata: {}, trigger_type: "judge" }),
        // A turn with one suppressed AND one delivered reply was answered: not over-eager.
        row(tripId, { outcome: "judge_yes", trigger_type: "judge", turn_id: turnMixed, response_latency_ms: 600 }),
        row(tripId, { event_type: "request_forwarded", outcome: "dispatched", trigger_type: "judge", turn_id: turnMixed, response_latency_ms: null, metadata: {} }),
        row(tripId, { event_type: "reply_sent", outcome: "reply_suppressed", turn_id: turnMixed, response_latency_ms: 900, metadata: {}, trigger_type: "judge" }),
        row(tripId, { event_type: "reply_sent", outcome: "reply_delivered", turn_id: turnMixed, response_latency_ms: 2000, metadata: {}, trigger_type: "judge" }),
        // Four nos (one below threshold), one fallback, one missed.
        row(tripId, { response_latency_ms: 200 }),
        row(tripId, { response_latency_ms: 250 }),
        row(tripId, { response_latency_ms: 300 }),
        row(tripId, { response_latency_ms: 350, metadata: { judge_confidence_pct: 62, judge_model: "vendor/free-model:free", judge_below_threshold: true } }),
        row(tripId, { outcome: "judge_fallback", response_latency_ms: 3000, metadata: { judge_model: "vendor/free-model:free", judge_fallback_reason: "timeout" } }),
        row(tripId, { outcome: "judge_missed", trigger_type: "name", response_latency_ms: 45_000, metadata: {} }),
      ];
      assert.deepEqual((await writeAssistantEvents(pool, events)).rejected, []);

      const [day] = await rollupAssistantEvents(pool, { tripId, timeZone: "UTC" });
      const j = day!.judge;
      assert.deepEqual(
        { yes: j.yes, no: j.no, below: j.below_threshold, fallback: j.fallback, missed: j.missed, overEager: j.over_eager },
        { yes: 3, no: 4, below: 1, fallback: 1, missed: 1, overEager: 1 },
      );
      assert.deepEqual(j.fallback_by_reason, { timeout: 1 });
      assert.deepEqual(j.by_model, { "vendor/free-model:free": 8 });
      assert.equal(j.latency_ms.length, 8, "the missed gap is not a judge latency");
      assert.ok(!j.latency_ms.includes(45_000));

      const rates = deriveRates(day!);
      assert.equal(rates.judge.decisions, 8);
      assert.equal(rates.judge.yes_rate.value, 3 / 8);
      assert.equal(rates.judge.fallback_rate.value, 1 / 8);
      assert.equal(rates.judge.missed_proxy.value, 1 / 4, "missed / nos");
      assert.equal(rates.judge.over_eager_proxy.value, 1 / 3, "silent / yeses");
      assert.equal(rates.judge.latency_p50_ms.value, 350, "nearest rank over 200..600 and the 3000 timeout");
      assert.equal(rates.judge.latency_p95_ms.value, 3000);

      const { json, markdown } = renderDailyReport(day!);
      const section = json.sections.find((s) => s.title === "Group Judge")!;
      const value = (label: RegExp) => section.lines.find((l) => label.test(l.label))!.value;
      assert.equal(value(/Messages judged/), "8");
      assert.match(value(/yes rate/), /37\.5% \(3\/8\)/);
      assert.match(value(/Missed proxy/), /25\.0% \(1\/4\)/);
      assert.match(value(/Over-eager proxy/), /33\.3% \(1\/3\)/);
      assert.match(value(/latency p50/), /350 ms/);
      assert.match(value(/latency p95/), /3000 ms/);
      assert.match(value(/Fallbacks/), /12\.5% \(1\/8\) - timeout 1/);
      assert.match(value(/Model/), /vendor\/free-model:free \(8\)/);
      assert.match(markdown, /## Group Judge/);
      // The header names the trip, whose random hex id can itself hold a long digit run: strip it first.
      assert.ok(!/-?\d{9,}/.test(markdown.split(tripId).join("")), "no id-shaped number in the report");
    });
  });

  test("the rollup counts level changes, and snapshots the open GROUP bindings by level", async () => {
    await withDb(async (pool, tripId) => {
      const bind = (chat: string, level: number, closed = false) => pool.query(
        `INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile, proactive_level, closed_at, closed_reason)
         VALUES ('tcb_' || md5(random()::text), $1, $2, 'p', $3, CASE WHEN $4 THEN now() ELSE NULL END, CASE WHEN $4 THEN 'test' ELSE NULL END)`,
        [chat, tripId, level, closed],
      );
      await bind("-1001", 3);
      await bind("-1002", 3);
      await bind("-1003", 1);
      await bind("-1004", 2, true); // closed: not counted
      await bind("5551", 1); // a private chat: not a group
      const change = (outcome: "level_raised" | "level_lowered", level: number) => row(tripId, {
        event_type: "proactive_level_changed", outcome, trigger_type: null, response_latency_ms: null, message_length_bucket: null,
        media_kind: null, requester_role: "organizer", metadata: { proactive_level: level },
      });
      await writeAssistantEvents(pool, [change("level_lowered", 1), change("level_lowered", 2), change("level_raised", 3)]);
      const [day] = await rollupAssistantEvents(pool, { tripId, timeZone: "UTC" });
      assert.deepEqual(day!.proactive, { raised: 1, lowered: 2, groups_by_level: { "1": 1, "3": 2 } });

      const section = renderDailyReport(day!).json.sections.find((s) => s.title === "Group Judge")!;
      const value = (label: RegExp) => section.lines.find((l) => label.test(l.label))!.value;
      assert.equal(value(/Groups by proactive level/), "1: 1, 3: 2");
      assert.equal(value(/Proactive level changes/), "raised 1, lowered 2");
    });
  });

  test("a day with no judge events has an all-zero judge block and a report that says 'no data'", async () => {
    await withDb(async (pool, tripId) => {
      await writeAssistantEvents(pool, [row(tripId, { event_type: "ignored_not_addressed", outcome: "ignored_not_addressed", metadata: {} })]);
      const [day] = await rollupAssistantEvents(pool, { tripId, timeZone: "UTC" });
      assert.equal(day!.judge.yes + day!.judge.no + day!.judge.fallback + day!.judge.missed, 0);
      const section = renderDailyReport(day!).json.sections.find((s) => s.title === "Group Judge")!;
      assert.ok(section.lines.every((l) => l.no_data), "every line is 'no data recorded', not a zero rate");
    });
  });
});
