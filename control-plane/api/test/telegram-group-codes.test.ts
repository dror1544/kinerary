/**
 * Telegram groups from the dashboard (#690, spec 690): redemption in the relay (AC-9 to AC-12) and the code table's sharing between
 * platforms (AC-5, AC-11). The code is minted with `issueChatBindingCode` as the portal route does; the group message is
 * `/start@<bot> <code>`, which is what Telegram posts for `?startgroup=<code>`.
 * Contract shape with two producers is not in play here: this is the relay's group binding, not `phases[]`.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, describe, test } from "node:test";
import type pg from "pg";
import { issueChatBindingCode, redeemChatBindingCode, chatBindingCodeDigest } from "../src/chat-binding-codes.js";
import { digestTelegramId } from "../src/identity.js";
import { issueGroupBindingToken } from "../src/group-binding.js";
import { uiString } from "../src/intake-copy.js";
import { DEFAULT_STRINGS, dispatchUpdate } from "../src/relay/dispatch.js";
import {
  listTelegramGroups, recordTelegramGroupTitle, redeemTelegramGroupCode, removeTelegramGroup, telegramGroupCodeFromStartPayload,
} from "../src/telegram-group-codes.js";
import { testDatabaseUrl } from "./support/test-database.js";
import { freshDatabase, mkMember, mkTrip, mkUser, openBinding, waGroupAddress, waGroupId } from "./support/whatsapp-fixture.js";

const SKIP = !testDatabaseUrl();
const BOT = { id: "8463178587", username: "Kinerary_bot" };
const OWNER_TG = 7_100_000_001;
const STRANGER_TG = 7_100_000_002;

describe("telegramGroupCodeFromStartPayload", () => {
  test("accepts exactly one code, canonicalised; anything that merely contains one is not a payload", () => {
    assert.equal(telegramGroupCodeFromStartPayload("KWA-ABCD2345"), "KWA-ABCD2345");
    assert.equal(telegramGroupCodeFromStartPayload("kwa-abcd2345"), "KWA-ABCD2345");
    for (const payload of ["KWA-ABCD2345x", "KWA-ABCD234", "xKWA-ABCD2345", "see KWA-ABCD2345", "KIN-ABCD2345", "KWA-ABCI2345", "", null, undefined]) {
      assert.equal(telegramGroupCodeFromStartPayload(payload as never), null, String(payload));
    }
  });
  test("a code is a legal Telegram start payload: A-Za-z0-9_- and at most 64 characters", () => {
    assert.match("KWA-ABCD2345", /^[A-Za-z0-9_-]{1,64}$/);
  });
});

describe("telegram group codes in the relay", { skip: SKIP }, () => {
  let pool: pg.Pool;
  after(async () => { await pool?.end(); });
  const groupChat = () => `-100${Math.floor(1e9 + Math.random() * 8e9)}`;
  const startInGroup = (chatId: string, payload: string, fromId: number = OWNER_TG, title?: string, chatType = "supergroup") => ({
    update_id: 95,
    message: {
      message_id: 9, chat: { id: chatId, type: chatType, ...(title ? { title } : {}) },
      from: { id: fromId, is_bot: false, first_name: "Dana" }, text: `/start@Kinerary_bot ${payload}`,
    },
  }) as never;
  const dispatch = (update: never) => dispatchUpdate(pool, update, undefined, undefined, BOT);

  /** An owner whose Telegram is linked, a trip with a companion intro, and a code the owner minted from the dashboard. */
  async function fixture() {
    pool = pool ?? await freshDatabase();
    const tripId = await mkTrip(pool, { title: "Alsace" });
    const ownerId = await mkUser(pool, "Dana Owner"); await mkMember(pool, tripId, ownerId, "owner");
    await pool.query(
      "INSERT INTO control_plane.telegram_organizer_trip_links(id,user_id,trip_id,telegram_subject_digest,verified_via) VALUES ($1,$2,$3,$4,'enrollment_redemption')",
      [`otl_${randomBytes(16).toString("hex")}`, ownerId, tripId, digestTelegramId(String(OWNER_TG))]);
    await pool.query("UPDATE control_plane.trips SET companion_intro = $2::jsonb WHERE id = $1", [tripId, JSON.stringify({
      assistant_name: "Rio", trip_title: "Alsace", private_url: "https://alsace.example", language: "en", login_password: "seed-pw",
    })]);
    const mint = async () => {
      const issued = await issueChatBindingCode(pool, { tripId, userId: ownerId, kind: "group", platform: "telegram" });
      assert.ok(issued.ok);
      return issued.code;
    };
    return { tripId, ownerId, mint, code: await mint() };
  }
  const open = async (chatId: string) => (await pool.query("SELECT id, trip_id, chat_title FROM control_plane.telegram_chat_bindings WHERE chat_id = $1 AND closed_at IS NULL", [chatId])).rows;
  const codeRow = async (code: string) => (await pool.query("SELECT state, binding_id FROM control_plane.chat_binding_codes WHERE code_digest = $1", [chatBindingCodeDigest(code)])).rows[0];
  const refusal = DEFAULT_STRINGS.groupTokenRefused;

  test("AC-9: the owner's own link binds a free group through the same path as /group KIN-…, greets it, and spends the code", async () => {
    const f = await fixture();
    const chat = groupChat();
    const d = await dispatch(startInGroup(chat, f.code, OWNER_TG, "Family"));
    assert.equal(d.kind, "group_intro");
    if (d.kind !== "group_intro") return;
    assert.equal(d.chatId, chat);
    assert.match(d.text, /Rio/);
    const bound = await open(chat);
    assert.deepEqual(bound.map((r) => r.trip_id), [f.tripId]);
    assert.deepEqual(await codeRow(f.code), { state: "redeemed", binding_id: bound[0].id });
    // The decision is the one /group <token> makes for the same group: text and pin are the same function's output.
    const kin = await issueGroupBindingToken(pool, f.tripId, String(OWNER_TG), { ttlSeconds: 3600 });
    if (!kin.ok) throw new Error("issue failed");
    const viaKin = await dispatch({ update_id: 96, message: { message_id: 10, chat: { id: groupChat(), type: "supergroup" }, from: { id: OWNER_TG, is_bot: false, first_name: "Dana" }, text: `/group ${kin.token}` } } as never);
    assert.equal(viaKin.kind === "group_intro" && viaKin.text, d.text);
    assert.equal(viaKin.kind === "group_intro" && viaKin.pin, d.pin);
  });

  test("AC-9: a lowercase payload binds too, and the same code tapped again is single-use: refused with the flat sentence, nothing duplicated", async () => {
    const f = await fixture();
    const chat = groupChat();
    assert.equal((await dispatch(startInGroup(chat, f.code.toLowerCase()))).kind, "group_intro");
    const again = await dispatch(startInGroup(groupChat(), f.code));
    assert.equal(again.kind === "reply" && again.reply.text, refusal);
    assert.equal((await open(chat)).length, 1);
  });

  test("AC-10: anyone but the trip's main organizer binds nothing and does not spend the code: a stranger, a member, a secondary organizer", async () => {
    const f = await fixture();
    const member = await mkUser(pool, "Noa"); await mkMember(pool, f.tripId, member, "member");
    const secondaryTg = 7_100_000_003;
    const secondary = await mkUser(pool, "Sec"); await mkMember(pool, f.tripId, secondary, "organizer");
    await pool.query(
      "INSERT INTO control_plane.telegram_organizer_trip_links(id,user_id,trip_id,telegram_subject_digest,verified_via) VALUES ($1,$2,$3,$4,'enrollment_redemption')",
      [`otl_${randomBytes(16).toString("hex")}`, secondary, f.tripId, digestTelegramId(String(secondaryTg))]);
    // A traveller with a Telegram identity on this trip (a participant person link), and the main organizer of ANOTHER trip.
    const participantTg = 7_100_000_004;
    await pool.query(
      `INSERT INTO control_plane.trip_person_links(id,trip_id,telegram_user_id,participant_username,display_name,role,verified_via)
       VALUES ($1,$2,$3,'noa','Noa','participant','interview_chat')`,
      [`tpl_${randomBytes(16).toString("hex")}`, f.tripId, String(participantTg)]);
    const otherTrip = await mkTrip(pool, { title: "Elsewhere" });
    const otherOwnerTg = 7_100_000_005;
    const otherOwner = await mkUser(pool, "Other"); await mkMember(pool, otherTrip, otherOwner, "owner");
    await pool.query(
      "INSERT INTO control_plane.telegram_organizer_trip_links(id,user_id,trip_id,telegram_subject_digest,verified_via) VALUES ($1,$2,$3,$4,'enrollment_redemption')",
      [`otl_${randomBytes(16).toString("hex")}`, otherOwner, otherTrip, digestTelegramId(String(otherOwnerTg))]);
    for (const [label, from] of [["stranger", STRANGER_TG], ["secondary organizer", secondaryTg], ["participant", participantTg], ["another trip's owner", otherOwnerTg]] as const) {
      const chat = groupChat();
      const d = await dispatch(startInGroup(chat, f.code, from));
      assert.equal(d.kind === "reply" && d.reply.text, refusal, label);
      assert.equal((await open(chat)).length, 0, label);
    }
    assert.equal((await codeRow(f.code)).state, "issued", "a forwarded link did not use the owner's code up");
    const chat = groupChat();
    assert.equal((await dispatch(startInGroup(chat, f.code, OWNER_TG))).kind, "group_intro", "the owner can still use it");
  });

  test("AC-10: an expired code, an unknown code, a retired trip and an issuer who is no longer the owner are refused with the same sentence and bind nothing", async () => {
    const f = await fixture();
    await pool.query("UPDATE control_plane.chat_binding_codes SET expires_at = now() - interval '1 minute' WHERE code_digest = $1", [chatBindingCodeDigest(f.code)]);
    const expired = groupChat(), unknown = groupChat();
    assert.equal((await dispatch(startInGroup(expired, f.code))).kind === "reply", true);
    const d1 = await dispatch(startInGroup(expired, f.code));
    const d2 = await dispatch(startInGroup(unknown, "KWA-ZZZZZZZZ"));
    for (const d of [d1, d2]) assert.equal(d.kind === "reply" && d.reply.text, refusal);

    const retiredCode = await f.mint();
    await pool.query("UPDATE control_plane.trips SET slug = 'retired-' || slug || '-20261127' WHERE id = $1", [f.tripId]);
    const retired = groupChat();
    assert.equal((await dispatch(startInGroup(retired, retiredCode))).kind === "reply", true);
    assert.equal((await open(retired)).length, 0);
    await pool.query("UPDATE control_plane.trips SET slug = replace(replace(slug, 'retired-', ''), '-20261127', '') WHERE id = $1", [f.tripId]);

    // The owner who minted it is demoted: the sender is no longer the trip's main organizer either, so nothing binds.
    const lateCode = await f.mint();
    await pool.query("UPDATE control_plane.trip_memberships SET role = 'member', dashboard_access = false WHERE trip_id = $1 AND user_id = $2", [f.tripId, f.ownerId]);
    const late = groupChat();
    const d3 = await dispatch(startInGroup(late, lateCode));
    assert.equal(d3.kind === "reply" && d3.reply.text, refusal);
    assert.equal((await open(late)).length, 0);
    for (const chat of [expired, unknown]) assert.equal((await open(chat)).length, 0);
  });

  test("AC-9/AC-10: a group of another trip is MOVED only by someone who is main organizer of both; otherwise the move refusal, and the code is kept", async () => {
    const f = await fixture();
    const otherTrip = await mkTrip(pool, { title: "Elsewhere" });
    const otherOwner = await mkUser(pool, "Other"); await mkMember(pool, otherTrip, otherOwner, "owner");
    const chat = groupChat();
    const theirBinding = await openBinding(pool, { tripId: otherTrip, chatId: chat });
    const refused = await dispatch(startInGroup(chat, f.code));
    assert.equal(refused.kind === "reply" && refused.reply.text, uiString("groupMoveNotOrganizer", "en"));
    assert.deepEqual((await open(chat)).map((r) => r.id), [theirBinding], "the other trip keeps its group");
    assert.equal((await codeRow(f.code)).state, "issued");
    // The same owner is also the main organizer of the other trip: now the move is theirs to make.
    await mkMember(pool, otherTrip, f.ownerId, "owner");
    await pool.query(
      "INSERT INTO control_plane.telegram_organizer_trip_links(id,user_id,trip_id,telegram_subject_digest,verified_via) VALUES ($1,$2,$3,$4,'enrollment_redemption')",
      [`otl_${randomBytes(16).toString("hex")}`, f.ownerId, otherTrip, digestTelegramId(String(OWNER_TG))]);
    const moved = await dispatch(startInGroup(chat, f.code));
    assert.equal(moved.kind, "group_intro");
    assert.deepEqual((await open(chat)).map((r) => r.trip_id), [f.tripId]);
    assert.equal((await pool.query("SELECT closed_reason FROM control_plane.telegram_chat_bindings WHERE id = $1", [theirBinding])).rows[0].closed_reason, "group_moved");
  });

  test("AC-9: a group already bound to this trip is re-bound and greeted again, and the code is spent", async () => {
    const f = await fixture();
    const chat = groupChat();
    const existing = await openBinding(pool, { tripId: f.tripId, chatId: chat });
    assert.equal((await dispatch(startInGroup(chat, f.code))).kind, "group_intro");
    assert.deepEqual((await open(chat)).map((r) => r.id), [existing]);
    assert.deepEqual(await codeRow(f.code), { state: "redeemed", binding_id: existing });
  });

  test("a private chat binds nothing (NOT_A_GROUP) and a WhatsApp code is not a Telegram code, nor the reverse (AC-11)", async () => {
    const f = await fixture();
    assert.deepEqual(await redeemTelegramGroupCode(pool, f.code, String(OWNER_TG), String(OWNER_TG)), { ok: false, reason: "NOT_A_GROUP" });
    assert.equal((await codeRow(f.code)).state, "issued");
    // a WhatsApp group code, as the dashboard mints it
    // (the WhatsApp switch is off here, so the issuer would refuse: write the row the way the issuer does)
    const waCode = "KWA-WAWAWAWA";
    await pool.query("INSERT INTO control_plane.chat_binding_codes(id,trip_id,platform,kind,issued_by_user_id,code_digest,expires_at) VALUES ($1,$2,'whatsapp','group',$3,$4,now() + interval '10 minutes')",
      [`cbc_${randomBytes(16).toString("hex")}`, f.tripId, f.ownerId, chatBindingCodeDigest(waCode)]);
    assert.deepEqual(await redeemTelegramGroupCode(pool, waCode, groupChat(), String(OWNER_TG)), { ok: false, reason: "NOT_FOUND" });
    const reverse = await redeemChatBindingCode(pool, { code: f.code, chatId: waGroupId(), senderId: `wa_${randomBytes(16).toString("hex")}`, transportAddress: waGroupAddress() });
    assert.equal(reverse.ok, false);
    assert.equal(!reverse.ok && reverse.reason, "NOT_FOUND");
    assert.equal((await codeRow(f.code)).state, "issued", "the WhatsApp redeemer did not touch the Telegram code");
  });

  test("AC-12: the group's name is recorded when it is bound, change-only, and a later message of the bound group with a new title renames it", async () => {
    const f = await fixture();
    const chat = groupChat();
    await dispatch(startInGroup(chat, f.code, OWNER_TG, "Family \n chat"));
    assert.equal((await open(chat))[0].chat_title, "Family chat");
    assert.equal(await recordTelegramGroupTitle(pool, chat, "Family chat"), false, "unchanged: no write");
    assert.equal(await recordTelegramGroupTitle(pool, chat, "Family 2027"), true);
    assert.equal(await recordTelegramGroupTitle(pool, chat, "\u0000​ "), false, "nothing but control characters is no title");
    assert.equal(await recordTelegramGroupTitle(pool, "123456789", "A private chat"), false, "never a private chat");
    // A group bound before titles were kept gains its name at its next message.
    const oldChat = groupChat();
    await openBinding(pool, { tripId: f.tripId, chatId: oldChat });
    assert.equal((await open(oldChat))[0].chat_title, null);
    await dispatch({ update_id: 97, message: { message_id: 11, chat: { id: oldChat, type: "supergroup", title: "Old gang" }, from: { id: STRANGER_TG, is_bot: false, first_name: "Noa" }, text: "hello everyone" } } as never);
    assert.equal((await open(oldChat))[0].chat_title, "Old gang");
  });

  test("the list and Unlink: groups by name and day, and a closed group disappears and can be bound again", async () => {
    const f = await fixture();
    const chat = groupChat();
    await dispatch(startInGroup(chat, f.code, OWNER_TG, "Family"));
    const listed = await listTelegramGroups(pool, f.tripId);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, "Family");
    assert.ok(!Number.isNaN(Date.parse(listed[0].connectedAt)));
    assert.deepEqual(await removeTelegramGroup(pool, { tripId: f.tripId, bindingId: listed[0].bindingId }), { ok: true });
    assert.deepEqual(await listTelegramGroups(pool, f.tripId), []);
    assert.deepEqual(await removeTelegramGroup(pool, { tripId: f.tripId, bindingId: listed[0].bindingId }), { ok: false, reason: "NOT_FOUND" });
    // nothing was sent: the closed row says why, and a fresh code binds the same group again
    assert.equal((await pool.query("SELECT closed_reason FROM control_plane.telegram_chat_bindings WHERE id = $1", [listed[0].bindingId])).rows[0].closed_reason, "dashboard_removed");
    assert.equal((await dispatch(startInGroup(chat, await f.mint()))).kind, "group_intro");
    assert.equal((await listTelegramGroups(pool, f.tripId)).length, 1);
  });

  test("AC-13: /group and the greeting are unchanged: one reusable KIN- token per trip, still bound to its issuer, and a dashboard mint never replaces it", async () => {
    const f = await fixture();
    const first = await issueGroupBindingToken(pool, f.tripId, String(OWNER_TG), { ttlSeconds: 3600 });
    if (!first.ok) throw new Error("issue failed");
    await f.mint(); await f.mint();
    for (const chat of [groupChat(), groupChat()]) {
      const d = await dispatch(startInGroup(chat, first.token));
      assert.equal(d.kind, "group_intro", "the token still binds, as many groups as the owner likes");
    }
    const stranger = await dispatch(startInGroup(groupChat(), first.token, STRANGER_TG));
    assert.equal(stranger.kind === "reply" && stranger.reply.text, refusal);
  });
});
