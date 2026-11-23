/**
 * WhatsApp S2 (docs/specs/sprint-9/625-whatsapp-via-relay.md): AC-3, AC-4, AC-5 and the `chatKind` cases.
 * Every test name starts with its criterion so a report can list AC-3 to AC-19 one by one.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type pg from "pg";
import { resolveChatRoute, resolveTripPerson } from "../src/chat-router.js";
import { chatKind, chatPlatformOf, isAcceptedWhatsAppGroupId, isPrivateChatId, whatsappChatAlias, whatsappOpaqueId } from "../src/identity.js";
import { testDatabaseUrl } from "./support/test-database.js";
import {
  FIXTURE_ADDRESS, freshDatabase, mkTrip, mkUser, openBinding, uid, waGroupAddress, waGroupId, waOldGroupAddress, waSender,
} from "./support/whatsapp-fixture.js";

const SKIP = !testDatabaseUrl();

async function refused(pool: pg.Pool, sql: string, params: unknown[], constraint?: string) {
  await assert.rejects(pool.query(sql, params), (error: { code?: string; constraint?: string }) => {
    assert.equal(error.code, "23514", `expected a CHECK violation, got ${error.code}`);
    if (constraint) assert.equal(error.constraint, constraint);
    return true;
  });
}

describe("chatKind", () => {
  test("chatKind: Telegram digits are private, minus-digits a group", () => {
    assert.equal(chatKind("123456789"), "private");
    assert.equal(chatKind("-1001234567890"), "group");
  });
  test("chatKind: a WhatsApp group alias (wa_…@g) is a group and the @p alias is private", () => {
    assert.equal(chatKind(`wa_${"a".repeat(32)}@g`), "group");
    assert.equal(chatKind(`wa_${"a".repeat(32)}@p`), "private");
  });
  test("chatKind: anything else is unknown, the most restrictive answer; a REAL WhatsApp id is never a chat id", () => {
    for (const id of ["", "abc", "120363025246125486@g.us", "123456789012-1234567890@g.us", "100000000000001@lid", `wa_${"a".repeat(31)}@p`, `wa_${"A".repeat(32)}@p`,
      `wa_${"a".repeat(32)}@x`, `wa_${"a".repeat(32)}`, `wa_${"a".repeat(33)}@g`, "@g", "-", "+972501234567", "12345@s.whatsapp.net"]) {
      assert.equal(chatKind(id), "unknown", id);
    }
  });
  test("the real group id the relay accepts from the bridge: new style and old style, nothing else", () => {
    for (const ok of ["120363025246125486@g.us", "12345@g.us", "123456789012-1234567890@g.us", "12345-12345@g.us"]) assert.equal(isAcceptedWhatsAppGroupId(ok), true, ok);
    for (const bad of ["", "1234@g.us", "123456789012-@g.us", "-1234567890@g.us", "123456789012-1234567890-1@g.us", "123456789012-123@g.us", "120363025246125486@g", "120363025246125486", "100000000000001@lid",
      "120363025246125486@s.whatsapp.net", ` ${"1".repeat(12)}@g.us`, `${"1".repeat(41)}@g.us`, null, undefined, 12345]) {
      assert.equal(isAcceptedWhatsAppGroupId(bad), false, String(bad));
    }
  });
  test("the alias derivation: HMAC of the real id under the SAME key as sender ids, 32 hex, @g for a group and @p for a person; the key is passed in", () => {
    const key = "test-key-a";
    const person = whatsappOpaqueId(key, "100000000000001@lid");
    assert.match(person, /^wa_[0-9a-f]{32}$/);
    assert.equal(whatsappChatAlias(key, "100000000000001@lid", "private"), `${person}@p`);
    const real = waGroupAddress(), old = waOldGroupAddress();
    for (const realId of [real, old]) {
      const alias = whatsappChatAlias(key, realId, "group");
      assert.match(alias, /^wa_[0-9a-f]{32}@g$/);
      assert.equal(chatKind(alias), "group");
      assert.equal(alias, `${whatsappOpaqueId(key, realId)}@g`, "the same key and construction as a sender id");
      assert.equal(whatsappChatAlias(key, realId, "group"), alias, "deterministic: the relay needs no lookup to receive");
      assert.ok(!alias.includes(realId.split("@")[0]!.split("-")[0]!.slice(0, 8)), "the number does not show through the alias");
    }
    assert.notEqual(whatsappChatAlias("test-key-b", real, "group"), whatsappChatAlias(key, real, "group"), "a different key gives a different alias");
    assert.notEqual(whatsappChatAlias(key, real, "group"), whatsappChatAlias(key, old, "group"));
    assert.equal(whatsappChatAlias(Buffer.from("test-key-a"), real, "group"), whatsappChatAlias(key, real, "group"), "a Buffer key is the same key");
    // fail loud: no key, no id, or a group id of no accepted shape
    assert.throws(() => whatsappOpaqueId("", "x@lid"), /key is required/);
    assert.throws(() => whatsappOpaqueId(undefined as never, "x@lid"), /key is required/);
    assert.throws(() => whatsappOpaqueId(key, ""), /id is required/);
    assert.throws(() => whatsappChatAlias(key, "100000000000001@lid", "group"), /not an accepted/);
    assert.throws(() => whatsappChatAlias(key, "-1001234567", "group"), /not an accepted/);
  });
  test("chatKind: isPrivateChatId keeps meaning a TELEGRAM private chat; a WhatsApp private chat is never one", () => {
    assert.equal(isPrivateChatId(`wa_${"a".repeat(32)}@p`), false);
    assert.equal(chatPlatformOf(`wa_${"a".repeat(32)}@p`), "whatsapp");
    assert.equal(chatPlatformOf("-100123"), "telegram");
    assert.equal(chatPlatformOf("nonsense"), null);
  });
});

describe("AC-3 / AC-4 / AC-5 against PostgreSQL", { skip: SKIP }, () => {
  let pool: pg.Pool;
  let tripId: string;
  before(async () => { pool = await freshDatabase(); tripId = await mkTrip(pool); });
  after(async () => { await pool.end(); });

  const insertBinding = (chatId: string, platform: string | null, extra: { address?: string | null; closed?: boolean; last4?: string | null } = {}) =>
    pool.query(
      `INSERT INTO control_plane.telegram_chat_bindings (id, chat_id, trip_id, hermes_profile${platform ? ", platform" : ""}, transport_address, phone_last4${extra.closed ? ", closed_at, closed_reason" : ""})
       VALUES ($1,$2,$3,'gw-x'${platform ? `,'${platform}'` : ""},$4,$5${extra.closed ? ",now(),'x'" : ""})`,
      [uid("tcb"), chatId, tripId, extra.address !== undefined ? extra.address : (platform === "whatsapp" && !extra.closed ? (chatId.endsWith("@g") ? waGroupAddress() : FIXTURE_ADDRESS) : null), extra.last4 ?? null],
    );

  test("AC-3: the active-chat unique index keeps its name and definition, and a row written with no platform is 'telegram'", async () => {
    const idx = await pool.query("SELECT indexdef FROM pg_indexes WHERE schemaname='control_plane' AND indexname='telegram_chat_bindings_active_chat_idx'");
    assert.match(idx.rows[0].indexdef, /UNIQUE INDEX telegram_chat_bindings_active_chat_idx ON control_plane\.telegram_chat_bindings USING btree \(chat_id\) WHERE \(closed_at IS NULL\)/);
    // The previous release's INSERT names no new column and still works.
    await pool.query("INSERT INTO control_plane.telegram_chat_bindings (id, chat_id, trip_id, hermes_profile) VALUES ($1,'-100200300',$2,'gw-old')", [uid("tcb"), tripId]);
    const row = await pool.query("SELECT platform, transport_address, chat_title FROM control_plane.telegram_chat_bindings WHERE chat_id='-100200300'");
    assert.deepEqual(row.rows[0], { platform: "telegram", transport_address: null, chat_title: null });
    // ...and the previous release's person-link upsert too.
    const user = await mkUser(pool);
    void user;
    await pool.query(
      `INSERT INTO control_plane.trip_person_links (id, trip_id, telegram_user_id, participant_username, display_name, role, verified_via)
       VALUES ($1,$2,'424242','ronmargolin','Ron','organizer','interview_chat')
       ON CONFLICT (trip_id, telegram_user_id) DO UPDATE SET role = EXCLUDED.role`, [uid("tpl"), tripId]);
    const link = await pool.query("SELECT platform, account_user_id FROM control_plane.trip_person_links WHERE telegram_user_id='424242'");
    assert.deepEqual(link.rows[0], { platform: "telegram", account_user_id: null });
  });

  test("AC-4: a whatsapp binding whose chat_id is not an accepted alias is refused, and a REAL group id (new or old style) is never a chat_id", async () => {
    for (const bad of ["-100123", "12345", "12345-67890@g.us", "123@g.us", waGroupAddress(), waOldGroupAddress(), "100000000000001@lid", `wa_${"a".repeat(31)}@p`, `wa_${"a".repeat(31)}@g`, `wa_${"a".repeat(32)}`, "x@g.us", "120363025246125486@s.whatsapp.net"]) {
      await refused(pool, "INSERT INTO control_plane.telegram_chat_bindings (id, chat_id, trip_id, platform, transport_address) VALUES ($1,$2,$3,'whatsapp',$4)", [uid("tcb"), bad, tripId, FIXTURE_ADDRESS], "telegram_chat_bindings_platform_chat_shape_ck");
    }
    await insertBinding(waGroupId(), "whatsapp");
    await insertBinding(waSender().chatId, "whatsapp");
  });

  test("AC-4: a telegram binding whose id contains @ is refused, including by a writer that names no platform", async () => {
    await refused(pool, "INSERT INTO control_plane.telegram_chat_bindings (id, chat_id, trip_id) VALUES ($1,$2,$3)", [uid("tcb"), waGroupId(), tripId], "telegram_chat_bindings_platform_chat_shape_ck");
    await refused(pool, "INSERT INTO control_plane.telegram_chat_bindings (id, chat_id, trip_id, platform) VALUES ($1,$2,$3,'telegram')", [uid("tcb"), waSender().chatId, tripId], "telegram_chat_bindings_platform_chat_shape_ck");
    await refused(pool, "INSERT INTO control_plane.telegram_chat_bindings (id, chat_id, trip_id, platform) VALUES ($1,'1@x',$2,'signal')", [uid("tcb"), tripId]);
  });

  test("AC-4: transport_address is REQUIRED on every open WhatsApp binding (group and private) and allowed nowhere else", async () => {
    const insert = (chatId: string, platform: string, address: string | null, closed = false) => pool.query(
      `INSERT INTO control_plane.telegram_chat_bindings (id, chat_id, trip_id, platform, transport_address${closed ? ", closed_at, closed_reason" : ""})
       VALUES ($1,$2,$3,$4,$5${closed ? ",now(),'x'" : ""})`, [uid("tcb"), chatId, tripId, platform, address]);
    // an open WhatsApp row without one is refused, group or private
    await assert.rejects(insert(waGroupId(), "whatsapp", null), { code: "23514", constraint: "telegram_chat_bindings_transport_address_ck" });
    await assert.rejects(insert(waSender().chatId, "whatsapp", null), { code: "23514", constraint: "telegram_chat_bindings_transport_address_ck" });
    await assert.rejects(insert(waGroupId(), "whatsapp", ""), { code: "23514" });
    // with one, both kinds are accepted; an old group's real id is just an address
    await insert(waGroupId(), "whatsapp", waGroupAddress());
    await insert(waGroupId(), "whatsapp", waOldGroupAddress());
    await insert(waSender().chatId, "whatsapp", FIXTURE_ADDRESS);
    // never on a Telegram row, and never on a closed row
    await assert.rejects(insert("-100777", "telegram", FIXTURE_ADDRESS), { code: "23514", constraint: "telegram_chat_bindings_transport_address_ck" });
    await assert.rejects(insert(waGroupId(), "whatsapp", waGroupAddress(), true), { code: "23514", constraint: "telegram_chat_bindings_transport_address_ck" });
    await insert(waGroupId(), "whatsapp", null, true);
    // closing a row without clearing it is refused, for a group as well
    for (const chatId of [waGroupId(), waSender().chatId]) {
      await insertBinding(chatId, "whatsapp");
      await refused(pool, "UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'dashboard_removed' WHERE chat_id = $1", [chatId]);
      await pool.query("UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'dashboard_removed', transport_address = NULL, phone_last4 = NULL WHERE chat_id = $1", [chatId]);
    }
  });

  test("AC-4: phone_last4 only on an open WhatsApp PRIVATE binding, four digits", async () => {
    const insert = (chatId: string, platform: string, last4: string) => pool.query(
      `INSERT INTO control_plane.telegram_chat_bindings (id, chat_id, trip_id, platform, transport_address, phone_last4) VALUES ($1,$2,$3,$4,$5,$6)`,
      [uid("tcb"), chatId, tripId, platform, platform === "whatsapp" ? (chatId.endsWith("@g") ? waGroupAddress() : FIXTURE_ADDRESS) : null, last4]);
    await insert(waSender().chatId, "whatsapp", "4567");
    await assert.rejects(insert(waGroupId(), "whatsapp", "4567"), { code: "23514", constraint: "telegram_chat_bindings_phone_last4_ck" });
    await assert.rejects(insert("-100778", "telegram", "4567"), { code: "23514", constraint: "telegram_chat_bindings_phone_last4_ck" });
    for (const bad of ["456", "45678", "45a7", ""]) await assert.rejects(insert(waSender().chatId, "whatsapp", bad), { code: "23514" });
  });

  test("AC-4: a WhatsApp person link's stored role must be 'participant', its id of the opaque shape, its verified_via a WhatsApp one", async () => {
    const link = (sender: string, role: string, via: string, platform = "whatsapp", username: string | null = "ella") => pool.query(
      `INSERT INTO control_plane.trip_person_links (id, trip_id, telegram_user_id, participant_username, role, verified_via, platform) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uid("tpl"), tripId, sender, username, role, via, platform]);
    await assert.rejects(link(waSender().senderId, "organizer", "dashboard_code"), { code: "23514", constraint: "trip_person_links_whatsapp_role_ck" });
    await assert.rejects(link("12345", "participant", "dashboard_code"), { code: "23514" });
    await assert.rejects(link(waSender().senderId, "participant", "interview_chat"), { code: "23514" });
    await assert.rejects(link(waSender().senderId, "participant", "dashboard_code", "telegram"), { code: "23514" });
    await assert.rejects(link("555", "participant", "interview_chat", "telegram", null), { code: "23514" });
    await link(waSender().senderId, "participant", "dashboard_code", "whatsapp", null);
    await link(waSender().senderId, "participant", "group_membership");
  });

  test("AC-4 / AC-9: one account and one traveller have one WhatsApp link per trip (partial unique indexes)", async () => {
    const trip = await mkTrip(pool);
    const user = await mkUser(pool);
    const ins = (sender: string, account: string | null, username: string | null) => pool.query(
      `INSERT INTO control_plane.trip_person_links (id, trip_id, telegram_user_id, participant_username, role, verified_via, platform, account_user_id)
       VALUES ($1,$2,$3,$4,'participant','dashboard_code','whatsapp',$5)`, [uid("tpl"), trip, sender, username, account]);
    await ins(waSender().senderId, user, "noa");
    await assert.rejects(ins(waSender().senderId, user, "dan"), { code: "23505", constraint: "trip_person_links_wa_account_idx" });
    await assert.rejects(ins(waSender().senderId, null, "noa"), { code: "23505", constraint: "trip_person_links_wa_traveller_idx" });
    await ins(waSender().senderId, null, null);
    await ins(waSender().senderId, null, null);
  });

  test("AC-5: a companion route carries the platform of the binding row; the chat id alone selects it", async () => {
    const trip = await mkTrip(pool, { profile: "gw-route" });
    const tgChat = "-1009998887";
    const group = waGroupId();
    const priv = waSender().chatId;
    await openBinding(pool, { tripId: trip, chatId: tgChat, profile: "gw-route" });
    await openBinding(pool, { tripId: trip, chatId: group, platform: "whatsapp", profile: "gw-route", title: "Family" });
    await openBinding(pool, { tripId: trip, chatId: priv, platform: "whatsapp", profile: "gw-route", transportAddress: FIXTURE_ADDRESS });
    const tg = await resolveChatRoute(pool, tgChat);
    assert.deepEqual(tg, { kind: "companion", tripId: trip, hermesProfile: "gw-route", assistantNames: [], platform: "telegram" });
    assert.equal((await resolveChatRoute(pool, group) as { platform: string }).platform, "whatsapp");
    assert.equal((await resolveChatRoute(pool, priv) as { platform: string }).platform, "whatsapp");
    assert.deepEqual(await resolveChatRoute(pool, waGroupId()), { kind: "unbound" });
  });

  test("AC-5: a closed WhatsApp binding does not route", async () => {
    const trip = await mkTrip(pool);
    const group = waGroupId();
    await openBinding(pool, { tripId: trip, chatId: group, platform: "whatsapp" });
    await pool.query("UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'dashboard_removed', transport_address = NULL WHERE chat_id = $1", [group]);
    assert.deepEqual(await resolveChatRoute(pool, group), { kind: "unbound" });
  });

  test("AC-5: the Telegram person lookup never answers for a WhatsApp sender id", async () => {
    const trip = await mkTrip(pool);
    const s = waSender();
    await pool.query(
      `INSERT INTO control_plane.trip_person_links (id, trip_id, telegram_user_id, participant_username, role, verified_via, platform)
       VALUES ($1,$2,$3,'ella','participant','group_membership','whatsapp')`, [uid("tpl"), trip, s.senderId]);
    assert.equal(await resolveTripPerson(pool, trip, s.senderId), null);
  });
});

describe("AC-3: rows the previous release wrote", { skip: SKIP }, () => {
  test("AC-3: every pre-existing binding row and person link reads platform 'telegram' after the migration", async () => {
    const old = await freshDatabaseWithRowsBeforeMigration();
    try {
      const b = await old.query("SELECT DISTINCT platform FROM control_plane.telegram_chat_bindings");
      assert.deepEqual(b.rows, [{ platform: "telegram" }]);
      const l = await old.query("SELECT DISTINCT platform FROM control_plane.trip_person_links");
      assert.deepEqual(l.rows, [{ platform: "telegram" }]);
    } finally { await old.end(); }
  });
});

/** The previous release's rows, then the S2 migration on top of them. */
async function freshDatabaseWithRowsBeforeMigration(): Promise<pg.Pool> {
  const pool = await freshDatabase({ oldSchema: true });
  const trip = await mkTrip(pool);
  await pool.query("INSERT INTO control_plane.telegram_chat_bindings (id, chat_id, trip_id, hermes_profile) VALUES ($1,'-100555',$2,'gw-a'),($3,'777',$2,'gw-a')", [uid("tcb"), trip, uid("tcb")]);
  await pool.query(
    `INSERT INTO control_plane.trip_person_links (id, trip_id, telegram_user_id, participant_username, display_name, role, verified_via)
     VALUES ($1,$2,'777','ron','Ron','organizer','interview_chat')`, [uid("tpl"), trip]);
  const { readFile } = await import("node:fs/promises");
  const { MIGRATIONS_DIR, S2_MIGRATION } = await import("./support/whatsapp-fixture.js");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(await readFile(`${MIGRATIONS_DIR}${S2_MIGRATION}`, "utf8"));
    await client.query("COMMIT");
  } finally { client.release(); }
  return pool;
}

describe("AC-5: new code on the OLD schema (the column does not exist yet)", { skip: SKIP }, () => {
  let pool: pg.Pool;
  before(async () => { pool = await freshDatabase({ oldSchema: true }); });
  after(async () => { await pool.end(); });

  test("AC-5: routing for Telegram chats works exactly as before and no WhatsApp route can resolve", async () => {
    const trip = await mkTrip(pool, { profile: "gw-old" });
    await pool.query("INSERT INTO control_plane.telegram_chat_bindings (id, chat_id, trip_id, hermes_profile) VALUES ($1,'-100123',$2,'gw-old'),($3,'4242',$2,'gw-old')", [uid("tcb"), trip, uid("tcb")]);
    assert.deepEqual(await resolveChatRoute(pool, "-100123"), { kind: "companion", tripId: trip, hermesProfile: "gw-old", assistantNames: [], platform: "telegram" });
    assert.equal((await resolveChatRoute(pool, "4242")).kind, "companion");
    assert.deepEqual(await resolveChatRoute(pool, waGroupId()), { kind: "unbound" });
    assert.deepEqual(await resolveChatRoute(pool, waSender().chatId), { kind: "unbound" });
    // the person lookup is the same Telegram query as before
    assert.equal(await resolveTripPerson(pool, trip, "4242"), null);
  });
});
