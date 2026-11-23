/**
 * WhatsApp S2: the readers that sniffed the SIGN of a chat id (spec 625, "Chat kind"). Each row of that table is pinned here:
 * what a WhatsApp row must do at the reader, and that no outbox message and no plan-change line goes to a WhatsApp group.
 * Also the monitor role: `transport_address` is not granted. Fixture ids are test values.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { channelTypeOf, type AssistantEvent } from "../src/analytics/contract.js";
import { rollupAssistantEvents, writeAssistantEvents } from "../src/analytics/store.js";
import { pollPlanChangesOnce } from "../src/plan-change-poller.js";
import { confirmAudience, enqueueTripMessage, resolveTripAudience } from "../src/trip-audience.js";
import { testDatabaseUrl } from "./support/test-database.js";
import { freshDatabase, mkTrip, openBinding, uid, waGroupId, waSender } from "./support/whatsapp-fixture.js";

const SKIP = !testDatabaseUrl();

describe("Chat kind readers (no database)", () => {
  test("Chat kind: analytics classifies a WhatsApp group as a group and a WhatsApp private chat like a private one, an unknown kind as unclassified", () => {
    assert.equal(channelTypeOf("group", "participant"), "group");
    assert.equal(channelTypeOf("private", "organizer"), "organizer_dm");
    assert.equal(channelTypeOf("private", "participant"), "other");
    assert.equal(channelTypeOf(undefined, "participant"), "unclassified");
    assert.equal(channelTypeOf("unknown", "participant"), "unclassified");
  });

  test("monitor role: the grant list names no new column of the binding table; transport_address and phone_last4 are NOT granted", async () => {
    const sql = await readFile(fileURLToPath(new URL("../../deployment/monitor-db-role.sql", import.meta.url)), "utf8");
    const grants = /\$grants\$\n([\s\S]*?)\$grants\$/.exec(sql)![1]!;
    const bindingLines = grants.split("\n").filter((l) => l.startsWith("control_plane.telegram_chat_bindings:"));
    assert.deepEqual(bindingLines, ["control_plane.telegram_chat_bindings: chat_id trip_id hermes_profile created_at closed_at closed_reason"]);
    for (const secret of ["transport_address", "phone_last4", "chat_title", "chat_binding_codes", "account_user_id", "code_digest"]) {
      assert.ok(!grants.includes(secret), `${secret} must not be granted to the monitor role`);
    }
    const personLines = grants.split("\n").filter((l) => l.startsWith("control_plane.trip_person_links:"));
    assert.deepEqual(personLines, ["control_plane.trip_person_links: trip_id role verified_via"]);
  });
});

describe("Chat kind readers against PostgreSQL", { skip: SKIP }, () => {
  let pool: pg.Pool;
  before(async () => { pool = await freshDatabase(); });
  after(async () => { await pool.end(); });

  test("Chat kind: no outbox message goes to a WhatsApp group (trip-audience resolves Telegram groups only)", async () => {
    const trip = await mkTrip(pool);
    const tgGroup = await openBinding(pool, { tripId: trip, chatId: "-1001000000009" });
    const waGroup = await openBinding(pool, { tripId: trip, chatId: waGroupId(), platform: "whatsapp", title: "Family" });
    await openBinding(pool, { tripId: trip, chatId: waSender().chatId, platform: "whatsapp", transportAddress: "100000000000003@lid" });
    const audience = await resolveTripAudience(pool, trip, "trip_group");
    assert.deepEqual(audience.map((a) => a.bindingId), [tgGroup]);
    assert.equal(await enqueueTripMessage(pool, { tripId: trip, type: "trip_plan_changed", target: "trip_group", payload: {}, dedupeKey: "wa-exclusion-1" }), 1);
    const rows = await pool.query("SELECT binding_id FROM control_plane.notification_outbox WHERE trip_id = $1", [trip]);
    assert.deepEqual(rows.rows, [{ binding_id: tgGroup }]);
    // a row addressed to a WhatsApp group binding is refused at send time, not sent
    assert.deepEqual(await confirmAudience(pool, { trip_id: trip, target: "trip_group", binding_id: waGroup }), { ok: false, reason: "no_audience" });
  });

  test("Chat kind: the plan-change poller never polls a trip whose only group is a WhatsApp group", async () => {
    const waOnly = await mkTrip(pool);
    await openBinding(pool, { tripId: waOnly, chatId: waGroupId(), platform: "whatsapp", title: "Family" });
    const tgTrip = await mkTrip(pool);
    await openBinding(pool, { tripId: tgTrip, chatId: "-1001000000010" });
    const polled: string[] = [];
    const summary = await pollPlanChangesOnce({
      db: pool, exchangeKey: "k", upstreamHostSuffixes: ["sites.example.invalid"],
      switchOn: async (tripId) => { polled.push(tripId); return false; },
    });
    assert.ok(polled.includes(tgTrip));
    assert.ok(!polled.includes(waOnly), "a trip with only a WhatsApp group has no group to post to");
    void summary;
  });

  test("Chat kind: the rollup counts an open WhatsApp group by proactive level as a group, and a WhatsApp private chat as no group", async () => {
    const trip = await mkTrip(pool);
    await pool.query("UPDATE control_plane.telegram_chat_bindings SET closed_at = now() WHERE false");
    await openBinding(pool, { tripId: trip, chatId: "-1001000000011" });
    await openBinding(pool, { tripId: trip, chatId: waGroupId(), platform: "whatsapp", title: "Family" });
    await openBinding(pool, { tripId: trip, chatId: waSender().chatId, platform: "whatsapp", transportAddress: "100000000000004@lid" });
    await openBinding(pool, { tripId: trip, chatId: "5559991" });
    const event: AssistantEvent = {
      event_id: randomUUID(), trip_id: trip, occurred_at: "2026-11-20T10:00:00.000Z", source_service: "relay",
      event_type: "proactive_level_changed", turn_id: null, channel_type: "group", trigger_type: null, requester_role: "organizer",
      outcome: "level_lowered", response_latency_ms: null, message_length_bucket: null, media_kind: null,
      metadata: { proactive_level: 1 }, tool_name: null,
    };
    await writeAssistantEvents(pool, [event]);
    const [day] = await rollupAssistantEvents(pool, { tripId: trip, timeZone: "UTC" });
    assert.deepEqual(day!.proactive.groups_by_level, { "3": 2 }, "the Telegram group and the WhatsApp group; no private chat");
    void uid;
  });
});
