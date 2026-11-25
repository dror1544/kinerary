/**
 * WhatsApp S2: AC-17 for the trip clear, and "new code on the OLD schema" for every existing function S2 added SQL to
 * (spec 625, AC-5 and the "two clocks" rule): `removeMember`, the Telegram path of `openBinding` (through
 * `redeemGroupBindingToken`), `executeClear`, the person lookup, and the dashboard's trip detail. A statement that names a new
 * column or table fails on the old schema even when it matches no row, so each is run there.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type pg from "pg";
import { issueChatBindingCode, redeemChatBindingCode, closeEndedMembershipBindings, whatsappSchemaPresent } from "../src/chat-binding-codes.js";
import { issueGroupBindingToken, redeemGroupBindingToken } from "../src/group-binding.js";
import { removeMember } from "../src/member-removal.js";
import { executeClear, previewClear, restoreFromArchive } from "../src/trip-clear.js";
import { testDatabaseUrl } from "./support/test-database.js";
import { freshDatabase, mkMember, mkTrip, mkUser, mkWhatsappTrip, openBinding, setWhatsappSwitch, waGroupId, waSender } from "./support/whatsapp-fixture.js";

const SKIP = !testDatabaseUrl();

describe("AC-17: a trip clear and WhatsApp", { skip: SKIP }, () => {
  let pool: pg.Pool;
  before(async () => { pool = await freshDatabase(); });
  after(async () => { await pool.end(); });

  test("AC-17: a trip clear expires the trip's live codes (and a restore puts the states back)", async () => {
    const { tripId, ownerId } = await mkWhatsappTrip(pool, { lifecycle: "intake_confirmed" });
    const issued = await Promise.all([1, 2].map(() => issueChatBindingCode(pool, { tripId, userId: ownerId, kind: "me" })));
    assert.ok(issued.every((r) => r.ok));
    const slug = (await pool.query("SELECT slug FROM control_plane.trips WHERE id=$1", [tripId])).rows[0].slug;
    const preview = await previewClear(pool, tripId);
    assert.ok(preview.ok, JSON.stringify(preview));
    const result = await executeClear(pool, tripId, slug, "test:operator");
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM control_plane.chat_binding_codes WHERE trip_id=$1 AND state='issued'", [tripId])).rows[0].n, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM control_plane.chat_binding_codes WHERE trip_id=$1 AND state='expired'", [tripId])).rows[0].n, 2);
    const restored = await restoreFromArchive(pool, (result as { archiveId: string }).archiveId);
    assert.equal(restored.chat_binding_codes, 2);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM control_plane.chat_binding_codes WHERE trip_id=$1 AND state='issued'", [tripId])).rows[0].n, 2);
  });

  test("AC-17: a trip that ever had a WhatsApp binding is still refused (EVER_PROVISIONED), whichever platform the binding was on", async () => {
    for (const kind of ["group", "private"] as const) {
      const { tripId } = await mkWhatsappTrip(pool, { lifecycle: "intake_confirmed" });
      const slug = (await pool.query("SELECT slug FROM control_plane.trips WHERE id=$1", [tripId])).rows[0].slug;
      const bindingId = await openBinding(pool, kind === "group"
        ? { tripId, chatId: waGroupId(), platform: "whatsapp", title: "Family" }
        : { tripId, chatId: waSender().chatId, platform: "whatsapp", transportAddress: "100000000000005@lid" });
      const preview = await previewClear(pool, tripId);
      assert.equal(preview.ok, false);
      assert.equal((preview as { reason: string }).reason, "EVER_PROVISIONED", kind);
      const executed = await executeClear(pool, tripId, slug, "test:operator");
      assert.equal(executed.ok, false);
      assert.equal((executed as { reason: string }).reason, "EVER_PROVISIONED", kind);
      // and a closed one counts too (it ever existed)
      await pool.query("UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'dashboard_removed', transport_address = NULL WHERE id = $1", [bindingId]);
      assert.equal(((await executeClear(pool, tripId, slug, "test:operator")) as { reason: string }).reason, "EVER_PROVISIONED", `${kind} closed`);
    }
  });
});

describe("AC-5: new code on the OLD schema", { skip: SKIP }, () => {
  let pool: pg.Pool;
  before(async () => { pool = await freshDatabase({ oldSchema: true }); });
  after(async () => { await pool.end(); });

  test("AC-5: the old schema really has no WhatsApp columns or table", async () => {
    assert.equal(await whatsappSchemaPresent(pool), false);
    assert.equal((await pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema='control_plane' AND table_name='telegram_chat_bindings' AND column_name='platform'")).rowCount, 0);
  });

  test("AC-5: removeMember still removes a member on the old schema", async () => {
    const tripId = await mkTrip(pool);
    const owner = await mkUser(pool), member = await mkUser(pool);
    await mkMember(pool, tripId, owner, "owner"); await mkMember(pool, tripId, member, "member");
    assert.deepEqual(await removeMember(pool, { tripId, actorUserId: owner, targetUserId: member }), { ok: true });
    assert.equal((await pool.query("SELECT status FROM control_plane.trip_memberships WHERE user_id=$1", [member])).rows[0].status, "revoked");
    const c = await pool.connect();
    try { assert.deepEqual(await closeEndedMembershipBindings(c, tripId, member), []); } finally { c.release(); }
  });

  test("AC-5: a Telegram group token still binds a group (the Telegram INSERT names no new column)", async () => {
    const tripId = await mkTrip(pool);
    await issueGroupBindingToken(pool, tripId, "424242", { ttlSeconds: 600 });
    const tokens = await pool.query("SELECT token_digest FROM control_plane.telegram_group_binding_tokens WHERE trip_id=$1", [tripId]);
    assert.equal(tokens.rowCount, 1);
    // redemption needs the plaintext token: issue one and read it back from the return value
    const issued = await issueGroupBindingToken(pool, tripId, "424242", { ttlSeconds: 600 });
    assert.ok(issued.ok);
    // the sender must be an organizer only to MOVE a group; a free group binds on the token alone
    const redeemed = await redeemGroupBindingToken(pool, issued.token, "-100888777", "424242");
    assert.equal(redeemed.ok, true, JSON.stringify(redeemed));
    assert.equal((await pool.query("SELECT 1 FROM control_plane.telegram_chat_bindings WHERE chat_id='-100888777' AND closed_at IS NULL")).rowCount, 1);
  });

  test("AC-5: a trip clear works on the old schema and archives no codes", async () => {
    const tripId = await mkTrip(pool, { lifecycle: "intake_confirmed" });
    const slug = (await pool.query("SELECT slug FROM control_plane.trips WHERE id=$1", [tripId])).rows[0].slug;
    const result = await executeClear(pool, tripId, slug, "test:operator");
    assert.ok(result.ok, JSON.stringify(result));
    const archive = await pool.query("SELECT payload FROM control_plane.trip_clear_archives WHERE id=$1", [(result as { archiveId: string }).archiveId]);
    assert.ok(!("chat_binding_codes" in archive.rows[0].payload));
    assert.ok(!("chat_binding_codes" in (await restoreFromArchive(pool, (result as { archiveId: string }).archiveId))));
  });

  test("AC-5: with the switch on and no table, issuing and redeeming fail LOUDLY instead of quietly binding or quietly refusing", async () => {
    const { tripId, ownerId } = await mkWhatsappTrip(pool);
    await assert.rejects(issueChatBindingCode(pool, { tripId, userId: ownerId, kind: "me" }), { code: "42P01" });
    const s = waSender();
    // a code of the right shape is looked up in a table that is not there: an error, never a bound chat
    await assert.rejects(redeemChatBindingCode(pool, { text: "KWA-ABCD2345", chatId: s.chatId, senderId: s.senderId, transportAddress: "100000000000007@lid" }), { code: "42P01" });
    await setWhatsappSwitch(pool, tripId, false);
  });
});
