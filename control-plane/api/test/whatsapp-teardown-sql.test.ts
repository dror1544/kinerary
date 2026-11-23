/**
 * WhatsApp S2, AC-17 end to end: the SQL `scripts/teardown-trip.py` really sends (rendered by the script itself, psql mocked)
 * is run against a real database, once on the new schema with WhatsApp rows and live codes, once on the OLD schema. The Python
 * unit tests pin the statement text and its order; this proves the text works, that the CHECK on a closed row is satisfied,
 * and that a database without the WhatsApp tables still tears a trip down.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { issueChatBindingCode, redeemChatBindingCode } from "../src/chat-binding-codes.js";
import { testDatabaseUrl } from "./support/test-database.js";
import { freshDatabase, mkTrip, mkWhatsappTrip, openBinding, waGroupId, waSender } from "./support/whatsapp-fixture.js";

const SKIP = !testDatabaseUrl();
const SCRIPT = fileURLToPath(new URL("../../../scripts/teardown-trip.py", import.meta.url));

/** The transaction `retire_in_db` sends for this trip, rendered by the script with psql replaced. */
function renderRetire(trip: { id: string; slug: string }): string {
  const program = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("teardown_trip", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
seen = []
m.psql = lambda sql: (seen.append(sql), "0")[1]
m.retire_in_db({"id": sys.argv[2], "slug": sys.argv[3], "orig": "wa-trip"})
print(json.dumps(seen[-1]))
`;
  const run = spawnSync("python3", ["-I", "-B", "-c", program, SCRIPT, trip.id, trip.slug], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout) as string;
}

describe("teardown-trip.py's transaction, run for real", { skip: SKIP }, () => {
  let pool: pg.Pool | undefined;
  after(async () => { await pool?.end(); });

  test("AC-17: on the new schema the live codes expire, WhatsApp bindings close 'trip_destroyed' with the address cleared, and the slug is retired", async () => {
    pool = await freshDatabase();
    const { tripId, ownerId } = await mkWhatsappTrip(pool, { title: "Alsace" });
    const s = waSender(), g = waGroupId();
    const me = await issueChatBindingCode(pool, { tripId, userId: ownerId, kind: "me" });
    const grp = await issueChatBindingCode(pool, { tripId, userId: ownerId, kind: "group" });
    const spare = await issueChatBindingCode(pool, { tripId, userId: ownerId, kind: "me" });
    assert.ok(me.ok && grp.ok && spare.ok);
    assert.ok((await redeemChatBindingCode(pool, { code: me.code, chatId: s.chatId, senderId: s.senderId, transportAddress: "100000000000006@lid", phoneLast4: "4567" })).ok);
    assert.ok((await redeemChatBindingCode(pool, { code: grp.code, chatId: g, senderId: s.senderId, chatTitle: "Family" })).ok);
    await openBinding(pool, { tripId, chatId: "-1001000000077" });
    const slug = (await pool.query("SELECT slug FROM control_plane.trips WHERE id=$1", [tripId])).rows[0].slug;

    const sql = renderRetire({ id: tripId, slug });
    await pool.query(sql);

    assert.equal((await pool.query("SELECT count(*)::int AS n FROM control_plane.chat_binding_codes WHERE trip_id=$1 AND state='issued'", [tripId])).rows[0].n, 0);
    const bindings = (await pool.query("SELECT chat_id, platform, closed_reason, transport_address, phone_last4 FROM control_plane.telegram_chat_bindings WHERE trip_id=$1 ORDER BY created_at", [tripId])).rows;
    assert.equal(bindings.length, 3);
    for (const b of bindings) {
      assert.equal(b.closed_reason, "trip_destroyed", `${b.platform} bindings close with the same reason`);
      assert.equal(b.transport_address, null);
      assert.equal(b.phone_last4, null);
    }
    assert.ok((await pool.query("SELECT slug FROM control_plane.trips WHERE id=$1", [tripId])).rows[0].slug.startsWith("retired-"));
    // the already-retired fast path runs too
    await pool.query(renderRetire({ id: tripId, slug: `retired-${slug}` }));
  });

  test("AC-17: on the OLD schema the same transaction still retires a Telegram trip (no table, no columns)", async () => {
    await pool?.end();
    pool = await freshDatabase({ oldSchema: true });
    const tripId = await mkTrip(pool);
    await pool.query("INSERT INTO control_plane.telegram_chat_bindings (id, chat_id, trip_id, hermes_profile) VALUES ($1,'-1001000000088',$2,'gw-x')", [`tcb_${"a".repeat(16)}`, tripId]);
    const slug = (await pool.query("SELECT slug FROM control_plane.trips WHERE id=$1", [tripId])).rows[0].slug;
    await pool.query(renderRetire({ id: tripId, slug }));
    assert.equal((await pool.query("SELECT closed_reason FROM control_plane.telegram_chat_bindings WHERE trip_id=$1", [tripId])).rows[0].closed_reason, "trip_destroyed");
    assert.ok((await pool.query("SELECT slug FROM control_plane.trips WHERE id=$1", [tripId])).rows[0].slug.startsWith("retired-"));
  });
});
