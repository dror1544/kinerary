/**
 * AC-28 (spec 625): a group is bound by adding the number to it ONLY when the adder's
 * person link names an account that is the ACTIVE OWNER of the trip the adder's own private
 * chat is bound to, the trip is not retired and its switch is on. Every other case binds
 * nothing and sends nothing. Driven through the real loop on the bridge stand-in's
 * `added_to_group`, `title_changed` and `participant_left` events. Never real WhatsApp.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type pg from "pg";
import { issueChatBindingCode } from "../src/chat-binding-codes.js";
import { FAKE_OWN } from "../tools/fake-whatsapp.js";
import { testDatabaseUrl } from "./support/test-database.js";
import { freshDatabase, mkMember, mkUser, setWhatsappSwitch } from "./support/whatsapp-fixture.js";
import { alias, bindGroup, bindPrivate, startRelay, waTrip, type Relay, type WaTrip } from "./support/whatsapp-relay-harness.js";

const SKIP = !testDatabaseUrl();
const OWNER = "731852946108811@lid";
const OTHER = "731852946108822@lid";
const GROUP = "120363098765400001@g.us";
const OLD_GROUP = "972541230000-1478000999@g.us";

describe("AC-28: binding a group by adding the number", { skip: SKIP }, () => {
  let pool: pg.Pool;
  before(async () => { pool = await freshDatabase(); });
  after(async () => { await pool?.end(); });

  async function scene(): Promise<{ relay: Relay; trip: WaTrip; done: () => Promise<void> }> {
    await pool.query("UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'test_reset', transport_address = NULL, phone_last4 = NULL WHERE closed_at IS NULL");
    await pool.query("DELETE FROM control_plane.trip_person_links WHERE platform = 'whatsapp'");
    const relay = await startRelay(pool);
    const trip = await waTrip(pool);
    return { relay, trip, done: () => relay.stop() };
  }

  const groupRows = (realId: string) => pool.query(
    "SELECT chat_id, trip_id, chat_title, transport_address, platform FROM control_plane.telegram_chat_bindings WHERE transport_address = $1 AND closed_at IS NULL",
    [realId],
  ).then((r) => r.rows);

  async function add(relay: Relay, input: { chatId: string; addedBy?: string; title?: string }, n = 1): Promise<Record<string, unknown>> {
    relay.fake.control.added(input);
    await relay.until("whatsapp.added_to_group", {}, n);
    return relay.events("whatsapp.added_to_group").at(-1)!;
  }

  test("the trip's owner, connected privately, adds the number: the group is bound to that trip with its title, introduced, and the owner is told in their own WhatsApp chat", async () => {
    const { relay, trip, done } = await scene();
    try {
      await bindPrivate(pool, trip, OWNER, { account: trip.ownerId, name: "Dana" });
      const line = await add(relay, { chatId: GROUP, addedBy: OWNER, title: "Cousins 2026" });
      console.log(`EVIDENCE AC-28 owner adds: log=${JSON.stringify(line)} bridge sends=${JSON.stringify(relay.fake.control.sent().map((s) => ({ to: s.chatId === GROUP ? "<group>" : s.chatId === OWNER ? "<owner private>" : "<other>", text: s.text })))}`);
      assert.deepEqual(line, { level: "info", event: "whatsapp.added_to_group", bound: true });
      assert.deepEqual(await groupRows(GROUP), [{ chat_id: alias.group(GROUP), trip_id: trip.tripId, chat_title: "Cousins 2026", transport_address: GROUP, platform: "whatsapp" }]);
      const sent = relay.fake.control.sent();
      const intro = sent.find((s) => s.chatId === GROUP);
      assert.ok(intro, "the introduction goes to the group");
      assert.match(intro!.text!, /I read this group's messages only to know when someone is talking to me\./);
      assert.ok(!intro!.text!.includes("hunter2-secret"));
      const notice = sent.find((s) => s.chatId === OWNER);
      assert.ok(notice, "the owner is told in their connected WhatsApp chat");
      assert.match(notice!.text!, /"Cousins 2026" was connected to "Alsace" on WhatsApp/);
    } finally { await done(); }
  });

  test("an old-style group (its id carries a number) binds the same way, behind its alias", async () => {
    const { relay, trip, done } = await scene();
    try {
      await bindPrivate(pool, trip, OWNER, { account: trip.ownerId });
      relay.fake.control.group({ chatId: OLD_GROUP, title: "Old family group", participants: [OWNER, FAKE_OWN.lid] });
      const line = await add(relay, { chatId: OLD_GROUP, addedBy: OWNER });
      assert.equal(line.bound, true);
      const [row] = await groupRows(OLD_GROUP);
      assert.equal(row.chat_id, alias.group(OLD_GROUP));
      assert.equal(row.chat_title, "Old family group", "the title is read from the bridge when the event has none");
    } finally { await done(); }
  });

  const refusals: Array<{ name: string; reason: string; arrange: (trip: WaTrip) => Promise<{ addedBy?: string }> }> = [
    {
      name: "a secondary organizer, connected privately, adds it",
      reason: "ADDER_NOT_OWNER",
      arrange: async (trip) => {
        const organizer = await mkUser(pool, "Second");
        await mkMember(pool, trip.tripId, organizer, "organizer");
        await bindPrivate(pool, trip, OTHER, { account: organizer });
        return { addedBy: OTHER };
      },
    },
    {
      name: "a member, connected privately, adds it",
      reason: "ADDER_NOT_OWNER",
      arrange: async (trip) => {
        const member = await mkUser(pool, "Member");
        await mkMember(pool, trip.tripId, member, "member");
        await bindPrivate(pool, trip, OTHER, { account: member });
        return { addedBy: OTHER };
      },
    },
    {
      name: "a traveller who connected with no account adds it",
      reason: "ADDER_NOT_CONNECTED",
      arrange: async (trip) => {
        await bindPrivate(pool, trip, OTHER, { account: null });
        return { addedBy: OTHER };
      },
    },
    {
      name: "the owner adds it without a connected private chat",
      reason: "ADDER_NOT_CONNECTED",
      arrange: async () => ({ addedBy: OWNER }),
    },
    {
      name: "the event does not say who added it",
      reason: "NO_ADDER",
      arrange: async (trip) => {
        await bindPrivate(pool, trip, OWNER, { account: trip.ownerId });
        return {};
      },
    },
    {
      name: "the owner adds it while the trip's switch is off",
      reason: "TRIP_UNAVAILABLE",
      arrange: async (trip) => {
        await bindPrivate(pool, trip, OWNER, { account: trip.ownerId });
        await setWhatsappSwitch(pool, trip.tripId, false);
        return { addedBy: OWNER };
      },
    },
    {
      name: "the owner whose membership is no longer active adds it",
      reason: "ADDER_NOT_OWNER",
      arrange: async (trip) => {
        await bindPrivate(pool, trip, OWNER, { account: trip.ownerId });
        await pool.query("UPDATE control_plane.trip_memberships SET status = 'revoked' WHERE trip_id = $1 AND user_id = $2", [trip.tripId, trip.ownerId]);
        return { addedBy: OWNER };
      },
    },
  ];
  for (const refusal of refusals) {
    test(`nothing is bound and nothing is sent when ${refusal.name}`, async () => {
      const { relay, trip, done } = await scene();
      try {
        const { addedBy } = await refusal.arrange(trip);
        const line = await add(relay, { chatId: GROUP, ...(addedBy ? { addedBy } : {}), title: "Cousins" });
        console.log(`EVIDENCE AC-28 ${refusal.name}: log=${JSON.stringify(line)} bridge sends=${relay.fake.control.sent().length}`);
        assert.deepEqual(line, { level: "info", event: "whatsapp.added_to_group", bound: false, reason: refusal.reason });
        assert.deepEqual(await groupRows(GROUP), []);
        assert.deepEqual(relay.fake.control.sent(), [], "nothing is sent");
      } finally { await done(); }
    });
  }

  test("a group already bound is left as it is: no second binding, no second introduction; and the group code still works for a refused add", async () => {
    const { relay, trip, done } = await scene();
    try {
      await bindPrivate(pool, trip, OWNER, { account: trip.ownerId });
      await bindGroup(pool, trip, GROUP, "Cousins");
      const line = await add(relay, { chatId: GROUP, addedBy: OWNER });
      assert.deepEqual(line, { level: "info", event: "whatsapp.added_to_group", bound: false, reason: "ALREADY_BOUND" });
      assert.equal((await groupRows(GROUP)).length, 1);
      assert.deepEqual(relay.fake.control.sent(), []);

      // Refused by the event (no adder), then bound by the group code.
      const second = "120363098765400002@g.us";
      await add(relay, { chatId: second }, 2);
      assert.deepEqual(await groupRows(second), []);
      const code = await issueChatBindingCode(pool, { tripId: trip.tripId, userId: trip.ownerId, kind: "group" });
      assert.ok(code.ok);
      relay.fake.control.message({ chatId: second, senderId: OTHER, text: code.code });
      await relay.until("whatsapp.code_attempt", { ok: true, kind: "group" });
      assert.equal((await groupRows(second)).length, 1);
    } finally { await done(); }
  });

  test("title_changed updates the open binding's title; the number leaving a group closes nothing", async () => {
    const { relay, trip, done } = await scene();
    try {
      await bindGroup(pool, trip, GROUP, "Cousins");
      relay.fake.control.title({ chatId: GROUP, title: "Cousins\u0000 in Alsace" });
      await relay.until("whatsapp.group_title_changed", { bound: true });
      assert.equal((await groupRows(GROUP))[0].chat_title, "Cousins in Alsace");
      relay.fake.control.left({ chatId: GROUP, participantId: FAKE_OWN.lid });
      await relay.until("whatsapp.participant_left", { self: true });
      assert.equal((await groupRows(GROUP)).length, 1, "the spec leaves leaving to a later slice: nothing is closed");
      assert.deepEqual(relay.fake.control.sent(), []);
    } finally { await done(); }
  });
});
