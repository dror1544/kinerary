/**
 * #655 review round 2, owner's decision 2026-11-24: a WhatsApp chat whose companion is down is TOLD so, with the line
 * Telegram uses and the same once-per-window limiter (OutageNoticeLimiter), as plain text through the bridge. Chatter in
 * a group is never answered. Bridge stand-in; never real WhatsApp.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type pg from "pg";
import { uiString } from "../src/intake-copy.js";
import { DEFAULT_STRINGS } from "../src/relay/dispatch.js";
import { testDatabaseUrl } from "./support/test-database.js";
import { freshDatabase } from "./support/whatsapp-fixture.js";
import { bindGroup, bindPrivate, startRelay, waTrip, type Relay, type WaTrip } from "./support/whatsapp-relay-harness.js";

const SKIP = !testDatabaseUrl();
const ALICE = "731852946107733@lid";
const BOB = "731852946107744@lid";
const GROUP = "120363098765432101@g.us";
const UNAVAILABLE = uiString("companionUnavailable", "en");

describe("a WhatsApp chat whose companion is down is told so, once a window", { skip: SKIP }, () => {
  let pool: pg.Pool;
  before(async () => { pool = await freshDatabase(); });
  after(async () => { await pool?.end(); });

  /** A relay with NO gateway connected for the trip: its companion is unreachable. */
  async function scene(options: { announced: boolean }): Promise<{ relay: Relay; trip: WaTrip }> {
    await pool.query("UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'test_reset', transport_address = NULL, phone_last4 = NULL WHERE closed_at IS NULL");
    await pool.query("DELETE FROM control_plane.trip_person_links WHERE platform = 'whatsapp'");
    const relay = await startRelay(pool);
    const trip = await waTrip(pool);
    if (options.announced) {
      await pool.query(
        `INSERT INTO control_plane.notification_outbox
           (id, trip_id, kind, recipient, payload, signup_request_id, notification_type, adapter, state, sent_at)
         VALUES ('nob_' || md5(random()::text), $1, 'companion_ready', '700000000', '{}'::jsonb, NULL, 'companion_ready', 'provisioner', 'sent', now())`,
        [trip.tripId],
      );
    }
    return { relay, trip };
  }
  const sendsTo = (relay: Relay, chat: string) => relay.fake.control.sent().filter((c) => c.kind === "send" && c.chatId === chat).map((c) => c.text);

  test("private chat, companion announced and unreachable: one 'off for now' line, and nothing for a second message inside the window", async () => {
    const { relay, trip } = await scene({ announced: true });
    try {
      await bindPrivate(pool, trip, ALICE);
      relay.fake.control.message({ chatId: ALICE, senderId: ALICE, text: "where is the hotel?", messageId: "D1" });
      await relay.until("whatsapp.companion_notice", { sent: true });
      relay.fake.control.message({ chatId: ALICE, senderId: ALICE, text: "hello?", messageId: "D2" });
      await relay.until("whatsapp.companion_notice", { sent: false, reason: "notice_limited" });
      console.log(`EVIDENCE companion down, private: bridge sends to the chat=${JSON.stringify(sendsTo(relay, ALICE))}; lines=${JSON.stringify(relay.events("whatsapp.companion_notice"))}`);
      assert.deepEqual(sendsTo(relay, ALICE), [UNAVAILABLE]);
      assert.deepEqual(relay.telegram.calls, [], "no Telegram call");
    } finally { await relay.stop(); }
  });

  test("group, companion announced and unreachable: chatter gets nothing; the first addressed message gets one line; a second addressed one inside the window gets nothing", async () => {
    const { relay, trip } = await scene({ announced: true });
    try {
      await bindGroup(pool, trip, GROUP);
      relay.fake.control.message({ chatId: GROUP, senderId: BOB, text: "I am so tired", messageId: "G0" });
      await relay.until("whatsapp.inbound_dropped", { reason: "NOT_ADDRESSED" });
      assert.deepEqual(sendsTo(relay, GROUP), [], "chatter is never answered");
      relay.fake.control.message({ chatId: GROUP, senderId: ALICE, text: "Liv, where is the hotel?", messageId: "G1" });
      await relay.until("whatsapp.companion_notice", { sent: true });
      relay.fake.control.message({ chatId: GROUP, senderId: BOB, text: "Liv??", messageId: "G2" });
      await relay.until("whatsapp.companion_notice", { sent: false, reason: "notice_limited" });
      console.log(`EVIDENCE companion down, group: bridge sends to the group=${JSON.stringify(sendsTo(relay, GROUP))}; lines=${JSON.stringify(relay.events("whatsapp.companion_notice"))}`);
      assert.deepEqual(sendsTo(relay, GROUP), [UNAVAILABLE]);
      assert.deepEqual(relay.telegram.calls, []);
    } finally { await relay.stop(); }
  });

  test("companion never announced: the 'still finishing' line Telegram uses, once a window in a private chat, and never to group chatter", async () => {
    const { relay, trip } = await scene({ announced: false });
    try {
      await bindPrivate(pool, trip, ALICE);
      await bindGroup(pool, trip, GROUP);
      relay.fake.control.message({ chatId: GROUP, senderId: BOB, text: "see you at dinner", messageId: "P0" });
      await relay.until("whatsapp.companion_notice", { sent: false, reason: "not_addressed" });
      relay.fake.control.message({ chatId: ALICE, senderId: ALICE, text: "hi", messageId: "P1" });
      await relay.until("whatsapp.companion_notice", { sent: true });
      relay.fake.control.message({ chatId: ALICE, senderId: ALICE, text: "hi again", messageId: "P2" });
      await relay.until("whatsapp.companion_notice", { sent: false, reason: "notice_limited" });
      console.log(`EVIDENCE companion pending: private sends=${JSON.stringify(sendsTo(relay, ALICE))}; group sends=${JSON.stringify(sendsTo(relay, GROUP))}`);
      assert.deepEqual(sendsTo(relay, ALICE), [DEFAULT_STRINGS.companionPending]);
      assert.deepEqual(sendsTo(relay, GROUP), []);
    } finally { await relay.stop(); }
  });
});
