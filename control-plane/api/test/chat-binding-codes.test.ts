/**
 * WhatsApp S2 (docs/specs/sprint-9/625-whatsapp-via-relay.md): code issuing, redemption, person lookup, the membership
 * close, Remove, the owner notice, the lock order. No transport: every function is called with a chat id, an opaque sender
 * id and a text. Test names start with their criterion. Fixture addresses and last-four digits are test values.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type pg from "pg";
import {
  CHAT_BINDING_CODE_PATTERN, CLOSE_REASONS, CodeAttemptLimiter, MAX_LIVE_CODES_PER_TRIP, closeIfMembershipEnded,
  composeWhatsAppGroupIntroduction, extractChatBindingCode, handleCodeMessage, issueChatBindingCode, listWhatsAppConnections,
  notifyOwnersOfNewBinding, redeemChatBindingCode, redeemReplyLine, removeWhatsAppConnection, resolveWhatsAppPerson,
  whatsappConnectionNoticeText, type RedeemResult,
} from "../src/chat-binding-codes.js";
import { redeemGroupBindingToken, issueGroupBindingToken } from "../src/group-binding.js";
import { removeMember } from "../src/member-removal.js";
import { FakeNotificationAdapter } from "../src/adapters/notification.js";
import { dispatchPendingTripNotifications } from "../src/outbox-dispatcher.js";
import { testDatabaseUrl } from "./support/test-database.js";
import {
  FIXTURE_ADDRESS, FIXTURE_PHONE_LAST4, freshDatabase, mkMember, mkTrip, mkUser, mkWhatsappTrip, openBinding, setWhatsappSwitch, uid,
  waGroupAddress, waGroupId, waOldGroupAddress, waSender,
} from "./support/whatsapp-fixture.js";

const SKIP = !testDatabaseUrl();

describe("AC-12: what counts as a code attempt (no database)", () => {
  test("AC-12: only a token of exactly the code shape, anywhere in the text, is an attempt", () => {
    assert.equal(extractChatBindingCode("here: KWA-ABCD2345 thanks"), "KWA-ABCD2345");
    assert.equal(extractChatBindingCode("kwa-abcd2345"), "KWA-ABCD2345");
    assert.equal(extractChatBindingCode("KWA-ABCD2345\n"), "KWA-ABCD2345");
    for (const text of ["KIN-ABCD2345", "KWA-ABCD234", "KWA-ABCD23456", "xKWA-ABCD2345", "KWA-ABCI2345", "KWA-ABCO2345", "https://x.example/KWA-ABCD2345", "KWA ABCD2345", "", null, undefined, "KWA-ABCD2345-extra"]) {
      assert.equal(extractChatBindingCode(text as never), null, String(text));
    }
    assert.ok(CHAT_BINDING_CODE_PATTERN.flags.includes("i"));
  });

  test("AC-12: more than N failures from one chat silence that chat for the rest of the hour; the global count alerts and silences nothing", () => {
    let now = 1_000_000;
    const lines: string[] = [];
    const limiter = new CodeAttemptLimiter({ perChatPerHour: 5, now: () => now, log: (l) => lines.push(l) });
    for (let i = 0; i < 5; i += 1) { assert.equal(limiter.silenced("chat-a"), false); limiter.recordFailure("chat-a"); }
    assert.equal(limiter.silenced("chat-a"), false, "five failures are allowed");
    limiter.recordFailure("chat-a");
    assert.equal(limiter.silenced("chat-a"), true, "the sixth failure silences it");
    assert.equal(limiter.silenced("chat-b"), false, "another chat is untouched");
    now += 3_599_000;
    assert.equal(limiter.silenced("chat-a"), true, "still silent late in the hour");
    now += 2_000;
    assert.equal(limiter.silenced("chat-a"), false, "the hour is over");
    // 50 failures across all chats: one alert line, nobody silenced
    now += 4_000_000;
    const g = new CodeAttemptLimiter({ perChatPerHour: 5, now: () => now, log: (l) => lines.push(l) });
    lines.length = 0;
    for (let i = 0; i < 80; i += 1) g.recordFailure(`chat-${i}`);
    assert.equal(lines.filter((l) => l.includes("whatsapp.code_failures_high")).length, 1);
    assert.equal(g.silenced("chat-3"), false);
    assert.doesNotMatch(lines.join("\n"), /chat-3/);
  });
});

describe("chat binding codes against PostgreSQL", { skip: SKIP }, () => {
  let pool: pg.Pool;
  before(async () => { pool = await freshDatabase(); });
  after(async () => { await pool.end(); });

  const bindingsOf = async (chatId: string) =>
    (await pool.query("SELECT * FROM control_plane.telegram_chat_bindings WHERE chat_id = $1 ORDER BY created_at", [chatId])).rows;
  const linksOf = async (tripId: string) =>
    (await pool.query("SELECT * FROM control_plane.trip_person_links WHERE trip_id = $1 AND platform = 'whatsapp'", [tripId])).rows;
  const issue = async (tripId: string, userId: string, kind: "me" | "group") => {
    const r = await issueChatBindingCode(pool, { tripId, userId, kind });
    assert.equal(r.ok, true, JSON.stringify(r));
    return (r as { code: string }).code;
  };
  // The relay passes the chat's REAL address for a group as well as a private chat (it is required); a default for tests that do not care.
  const redeem = (code: string, chatId: string, senderId: string, extra: Record<string, unknown> = {}) =>
    redeemChatBindingCode(pool, { text: `my code ${code}`, chatId, senderId, transportAddress: chatId.endsWith("@g") ? waGroupAddress() : FIXTURE_ADDRESS, ...extra });
  const codeRow = async (code: string) =>
    (await pool.query("SELECT * FROM control_plane.chat_binding_codes WHERE code_digest = $1 ORDER BY created_at DESC", [`sha256:${createHash("sha256").update(code).digest("hex")}`])).rows[0];

  describe("AC-7: issuing (the data half; the routes are in whatsapp-portal.test.ts)", () => {
    test("AC-7: a code is stored only as a digest, expires after its TTL, and the default is 900 seconds", async () => {
      const { tripId, ownerId } = await mkWhatsappTrip(pool);
      const r = await issueChatBindingCode(pool, { tripId, userId: ownerId, kind: "me" });
      assert.ok(r.ok);
      const row = await codeRow(r.code);
      assert.equal(row.state, "issued");
      assert.equal(row.kind, "me");
      assert.ok(Math.abs(new Date(row.expires_at).getTime() - Date.now() - 900_000) < 5_000);
      const all = JSON.stringify((await pool.query("SELECT * FROM control_plane.chat_binding_codes WHERE trip_id = $1", [tripId])).rows);
      assert.ok(!all.includes(r.code.slice(4)), "the plaintext code is nowhere in the table");
      const custom = await issueChatBindingCode(pool, { tripId, userId: ownerId, kind: "me", ttlSeconds: 120 });
      assert.ok(custom.ok);
      assert.ok(Math.abs(custom.expiresAt.getTime() - Date.now() - 120_000) < 5_000);
    });

    test("AC-7: any active member may ask for a `me` code; only the owner for a `group` code; every refusal is the same NOT_FOUND", async () => {
      const { tripId, ownerId } = await mkWhatsappTrip(pool);
      const member = await mkUser(pool); await mkMember(pool, tripId, member, "member");
      const secondary = await mkUser(pool); await mkMember(pool, tripId, secondary, "organizer");
      const stranger = await mkUser(pool);
      const gone = await mkUser(pool); await mkMember(pool, tripId, gone, "member", "revoked");
      assert.ok((await issueChatBindingCode(pool, { tripId, userId: member, kind: "me" })).ok);
      assert.ok((await issueChatBindingCode(pool, { tripId, userId: secondary, kind: "me" })).ok);
      assert.ok((await issueChatBindingCode(pool, { tripId, userId: ownerId, kind: "group" })).ok);
      for (const [userId, kind] of [[member, "group"], [secondary, "group"], [stranger, "me"], [stranger, "group"], [gone, "me"]] as const) {
        assert.deepEqual(await issueChatBindingCode(pool, { tripId, userId, kind }), { ok: false, reason: "NOT_FOUND" }, `${userId} ${kind}`);
      }
      assert.deepEqual(await issueChatBindingCode(pool, { tripId: uid("trip"), userId: ownerId, kind: "me" }), { ok: false, reason: "NOT_FOUND" });
      assert.deepEqual(await issueChatBindingCode(pool, { tripId, userId: ownerId, kind: "everyone" }), { ok: false, reason: "INVALID_KIND" });
      assert.deepEqual(await issueChatBindingCode(pool, { tripId, userId: stranger, kind: "everyone" }), { ok: false, reason: "NOT_FOUND" }, "a stranger learns nothing from a malformed kind");
    });

    test("AC-7 / AC-6: a retired trip, and a trip with the switch off, issue nothing", async () => {
      const off = await mkWhatsappTrip(pool, { switchOn: false });
      assert.deepEqual(await issueChatBindingCode(pool, { tripId: off.tripId, userId: off.ownerId, kind: "me" }), { ok: false, reason: "NOT_FOUND" });
      const retired = await mkTrip(pool, { retired: true });
      const user = await mkUser(pool); await mkMember(pool, retired, user, "owner"); await setWhatsappSwitch(pool, retired, true);
      assert.deepEqual(await issueChatBindingCode(pool, { tripId: retired, userId: user, kind: "me" }), { ok: false, reason: "NOT_FOUND" });
    });

    test("AC-7: earlier codes stay valid, at most ten are live per trip, and the oldest is expired to make room", async () => {
      const { tripId, ownerId } = await mkWhatsappTrip(pool);
      const codes: string[] = [];
      for (let i = 0; i < MAX_LIVE_CODES_PER_TRIP; i += 1) codes.push(await issue(tripId, ownerId, "me"));
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM control_plane.chat_binding_codes WHERE trip_id=$1 AND state='issued'", [tripId])).rows[0].n, 10);
      for (const c of codes) assert.equal((await codeRow(c)).state, "issued");
      const eleventh = await issue(tripId, ownerId, "me");
      assert.equal((await codeRow(codes[0]!)).state, "expired", "the oldest was expired");
      assert.equal((await codeRow(codes[1]!)).state, "issued");
      assert.equal((await codeRow(eleventh)).state, "issued");
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM control_plane.chat_binding_codes WHERE trip_id=$1 AND state='issued'", [tripId])).rows[0].n, 10);
      // concurrent issuers never exceed ten
      await Promise.all(Array.from({ length: 6 }, () => issue(tripId, ownerId, "me")));
      assert.ok((await pool.query("SELECT count(*)::int AS n FROM control_plane.chat_binding_codes WHERE trip_id=$1 AND state='issued'", [tripId])).rows[0].n <= 10);
    });
  });

  describe("AC-8 / AC-9: a `me` code in a private chat", () => {
    test("AC-8: one transaction spends the code, opens one WhatsApp binding with the trip's profile, writes one person link for the account, and the reply names the trip", async () => {
      const { tripId, ownerId } = await mkWhatsappTrip(pool, { title: "Alsace" });
      const s = waSender();
      const code = await issue(tripId, ownerId, "me");
      const r = await redeem(code, s.chatId, s.senderId, { transportAddress: FIXTURE_ADDRESS, phoneLast4: FIXTURE_PHONE_LAST4 });
      assert.ok(r.ok && r.kind === "me");
      const bindings = await bindingsOf(s.chatId);
      assert.equal(bindings.length, 1);
      assert.equal(bindings[0].platform, "whatsapp");
      assert.equal(bindings[0].trip_id, tripId);
      assert.equal(bindings[0].closed_at, null);
      const profile = (await pool.query("SELECT hermes_profile FROM control_plane.trips WHERE id=$1", [tripId])).rows[0].hermes_profile;
      assert.equal(bindings[0].hermes_profile, profile);
      assert.equal(bindings[0].transport_address, FIXTURE_ADDRESS);
      const links = await linksOf(tripId);
      assert.equal(links.length, 1);
      assert.equal(links[0].telegram_user_id, s.senderId);
      assert.equal(links[0].account_user_id, ownerId);
      assert.equal(links[0].role, "participant");
      assert.equal(links[0].verified_via, "dashboard_code");
      assert.equal(links[0].participant_username, null, "an owner with no traveller carries none");
      const spent = await codeRow(code);
      assert.equal(spent.state, "redeemed");
      assert.equal(spent.binding_id, bindings[0].id);
      const line = redeemReplyLine(r);
      assert.match(line!, /Alsace/);
      assert.ok(!line!.includes("\n"));
      // single use
      const again = await redeem(code, waSender().chatId, waSender().senderId);
      assert.equal(again.ok, false);
    });

    test("AC-8: the account's traveller (its redeemed site invite) goes on the link", async () => {
      const { tripId } = await mkWhatsappTrip(pool);
      const member = await mkUser(pool, "Noa"); await mkMember(pool, tripId, member, "member");
      await pool.query(
        `INSERT INTO control_plane.site_invites (id, trip_id, created_by, intended_display_name, runtime_username, token_digest, state, expires_at, redeemed_by, redeemed_at)
         VALUES ($1,$2,$3,'Noa Levi','noa',$4,'redeemed',now()+interval '1 day',$3,now())`,
        [`invite_${uid("x").slice(2)}`, tripId, member, `sha256:${"a".repeat(64)}`]);
      const s = waSender();
      const r = await redeem(await issue(tripId, member, "me"), s.chatId, s.senderId);
      assert.ok(r.ok && r.kind === "me");
      assert.deepEqual(r.traveller, { username: "noa", displayName: "Noa Levi" });
      const link = (await linksOf(tripId))[0];
      assert.equal(link.participant_username, "noa");
      assert.equal(link.display_name, "Noa Levi");
    });

    test("AC-8: an open binding of the same chat is closed (rebound_by_code), whatever trip it was for, and its person link deleted", async () => {
      const a = await mkWhatsappTrip(pool, { title: "Rome" });
      const b = await mkWhatsappTrip(pool, { title: "Oslo" });
      const s = waSender();
      const first = await redeem(await issue(a.tripId, a.ownerId, "me"), s.chatId, s.senderId, { transportAddress: FIXTURE_ADDRESS });
      assert.ok(first.ok);
      const second = await redeem(await issue(b.tripId, b.ownerId, "me"), s.chatId, s.senderId, { transportAddress: FIXTURE_ADDRESS });
      assert.ok(second.ok && second.kind === "me");
      assert.deepEqual(second.closedBindingIds, [(first as { bindingId: string }).bindingId]);
      const rows = await bindingsOf(s.chatId);
      assert.equal(rows.length, 2);
      const closed = rows.find((r) => r.trip_id === a.tripId)!;
      assert.equal(closed.closed_reason, CLOSE_REASONS.reboundByCode);
      assert.equal(closed.transport_address, null);
      assert.equal(rows.filter((r) => r.closed_at === null).length, 1);
      assert.equal((await linksOf(a.tripId)).length, 0, "the old trip's link is gone");
      assert.equal((await linksOf(b.tripId)).length, 1);
    });

    test("AC-9: another WhatsApp link of the trip naming the same account, or the same traveller, is deleted and its chat closed", async () => {
      const { tripId, ownerId } = await mkWhatsappTrip(pool);
      const noa = await mkUser(pool, "Noa"); await mkMember(pool, tripId, noa, "member");
      await pool.query(
        `INSERT INTO control_plane.site_invites (id, trip_id, created_by, intended_display_name, runtime_username, token_digest, state, expires_at, redeemed_by, redeemed_at)
         VALUES ($1,$2,$3,'Noa','noa',$4,'redeemed',now()+interval '1 day',$3,now())`, [`invite_${uid("y").slice(2)}`, tripId, noa, `sha256:${"b".repeat(64)}`]);
      // the same ACCOUNT connects from a second number
      const oldPhone = waSender(), newPhone = waSender();
      assert.ok((await redeem(await issue(tripId, ownerId, "me"), oldPhone.chatId, oldPhone.senderId, { transportAddress: FIXTURE_ADDRESS })).ok);
      assert.ok((await redeem(await issue(tripId, ownerId, "me"), newPhone.chatId, newPhone.senderId, { transportAddress: FIXTURE_ADDRESS })).ok);
      assert.equal((await bindingsOf(oldPhone.chatId))[0].closed_reason, "rebound_by_code");
      assert.equal((await bindingsOf(newPhone.chatId))[0].closed_at, null);
      assert.deepEqual((await linksOf(tripId)).map((l) => l.telegram_user_id), [newPhone.senderId]);
      // a claim made from the group on traveller `noa`, replaced by Noa's own `me` connection
      const claimant = waSender();
      await pool.query(
        `INSERT INTO control_plane.trip_person_links (id, trip_id, telegram_user_id, participant_username, role, verified_via, platform)
         VALUES ($1,$2,$3,'noa','participant','group_membership','whatsapp')`, [uid("tpl"), tripId, claimant.senderId]);
      await openBinding(pool, { tripId, chatId: claimant.chatId, platform: "whatsapp", transportAddress: FIXTURE_ADDRESS });
      const noaPhone = waSender();
      assert.ok((await redeem(await issue(tripId, noa, "me"), noaPhone.chatId, noaPhone.senderId, { transportAddress: FIXTURE_ADDRESS })).ok);
      assert.equal((await bindingsOf(claimant.chatId))[0].closed_reason, "rebound_by_code");
      assert.equal((await bindingsOf(claimant.chatId))[0].transport_address, null);
      const left = await linksOf(tripId);
      assert.deepEqual(left.map((l) => l.telegram_user_id).sort(), [newPhone.senderId, noaPhone.senderId].sort());
    });

    test("AC-9: the two partial unique indexes hold under concurrent redemptions of one account's codes", async () => {
      const { tripId, ownerId } = await mkWhatsappTrip(pool);
      const phones = Array.from({ length: 4 }, () => waSender());
      const codes = await Promise.all(phones.map(() => issue(tripId, ownerId, "me")));
      const results = await Promise.all(phones.map((p, i) => redeem(codes[i]!, p.chatId, p.senderId, { transportAddress: FIXTURE_ADDRESS })));
      for (const r of results) assert.ok(r.ok || r.reason === "CONFLICT", JSON.stringify(r));
      assert.ok(results.some((r) => r.ok));
      const links = await linksOf(tripId);
      assert.equal(links.length, 1, "one account, one WhatsApp number per trip");
      const open = (await pool.query("SELECT chat_id FROM control_plane.telegram_chat_bindings WHERE trip_id=$1 AND platform='whatsapp' AND closed_at IS NULL", [tripId])).rows;
      assert.equal(open.length, 1);
      assert.equal(open[0].chat_id, `${links[0].telegram_user_id}@p`, "the surviving binding is the surviving link's chat");
      // a CONFLICT leaves its code unspent
      for (let i = 0; i < results.length; i += 1) {
        if (!results[i]!.ok) assert.equal((await codeRow(codes[i]!)).state, "issued");
      }
    });
  });

  describe("AC-10: a `group` code in a group", () => {
    test("AC-10: the code is spent, one binding opens with the title, and the introduction never carries the site password", async () => {
      const { tripId, ownerId } = await mkWhatsappTrip(pool, { title: "Alsace" });
      await pool.query(
        "UPDATE control_plane.trips SET companion_intro = $2::jsonb WHERE id = $1",
        [tripId, JSON.stringify({ assistant_name: "Ziv", trip_title: "Alsace", private_url: "https://trip.example/alsace", language: "en", login_password: "hunter2-secret", organizer: "Dana", login_usernames: [{ name: "Dana", username: "dana" }] })]);
      const group = waGroupId(), real = waGroupAddress();
      const stranger = waSender();
      const code = await issue(tripId, ownerId, "group");
      const r = await redeem(code, group, stranger.senderId, { chatTitle: "  Family\ntrip  ", transportAddress: real });
      assert.ok(r.ok && r.kind === "group" && !r.alreadyConnected, "who sends it does not matter");
      const rows = await bindingsOf(group);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].platform, "whatsapp");
      assert.equal(rows[0].chat_title, "Family trip");
      assert.equal(rows[0].chat_id, group, "the alias is the chat id; the real id is never stored there");
      assert.equal(rows[0].transport_address, real, "the real id rests in transport_address on a group too");
      assert.equal((await codeRow(code)).state, "redeemed");
      assert.equal(redeemReplyLine(r), null, "the introduction, not a reply line, answers a new group");
      const intro = (await composeWhatsAppGroupIntroduction(pool, tripId))!;
      assert.match(intro, /Ziv/);
      assert.match(intro, /reads? this group's messages|read this group's messages/);
      assert.doesNotMatch(intro, /hunter2-secret/);
      assert.doesNotMatch(intro, /KWA-/);
      assert.equal(await composeWhatsAppGroupIntroduction(pool, await mkTrip(pool)), null, "no stored facts, nothing to introduce");
    });

    test("AC-10 / AC-11: an OLD group (its real id carries its creator's number) binds behind its alias, and the number never reaches chat_id, the title or any response", async () => {
      const { tripId, ownerId } = await mkWhatsappTrip(pool);
      const group = waGroupId(), old = waOldGroupAddress();
      assert.match(old, /^[0-9]{12}-[0-9]{10}@g\.us$/);
      const r = await redeem(await issue(tripId, ownerId, "group"), group, waSender().senderId, { transportAddress: old });
      assert.ok(r.ok && r.kind === "group", JSON.stringify(r));
      const row = (await bindingsOf(group))[0];
      assert.equal(row.transport_address, old);
      assert.ok(!row.chat_id.includes(old.split("-")[0]!));
      const listed = JSON.stringify(await listWhatsAppConnections(pool, tripId));
      assert.ok(!listed.includes(old) && !listed.includes(old.split("-")[0]!), "the real id is not in the list");
      assert.deepEqual((await listWhatsAppConnections(pool, tripId)).map((c) => c.name), [null], "a group with no title shows no name, never its address");
      // Remove clears the address on a group too
      const [conn] = await listWhatsAppConnections(pool, tripId);
      assert.deepEqual(await removeWhatsAppConnection(pool, { tripId, bindingId: conn!.bindingId }), { ok: true });
      assert.equal((await bindingsOf(group))[0].transport_address, null);
    });

    test("AC-10: the Hebrew introduction carries the disclosure line too and no password", async () => {
      const { tripId } = await mkWhatsappTrip(pool);
      await pool.query("UPDATE control_plane.trips SET companion_intro = $2::jsonb WHERE id = $1",
        [tripId, JSON.stringify({ assistant_name: "זיו", language: "he", private_url: "https://t.example", login_password: "סיסמה-סודית" })]);
      const intro = (await composeWhatsAppGroupIntroduction(pool, tripId))!;
      assert.match(intro, /אני קורא את ההודעות בקבוצה/);
      assert.doesNotMatch(intro, /סיסמה-סודית/);
    });
  });

  describe("AC-11: what binds nothing, and whether the code is spent", () => {
    const expectRefused = (r: RedeemResult, reason: string, spent: boolean) => {
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal((r as { reason: string }).reason, reason);
      assert.equal((r as { spent: boolean }).spent, spent);
      const line = redeemReplyLine(r);
      assert.ok(line === null || (!line.includes("\n") && !/KWA-/.test(line)), "at most one fixed line, never the code");
    };

    test("AC-11: a code of the wrong kind for the chat is not spent and binds nothing; the right chat then works", async () => {
      const { tripId, ownerId } = await mkWhatsappTrip(pool);
      const me = await issue(tripId, ownerId, "me"), grp = await issue(tripId, ownerId, "group");
      const g = waGroupId(), p = waSender();
      expectRefused(await redeem(grp, p.chatId, p.senderId), "WRONG_KIND", false);
      expectRefused(await redeem(me, g, p.senderId), "WRONG_KIND", false);
      assert.equal((await codeRow(me)).state, "issued");
      assert.equal((await codeRow(grp)).state, "issued");
      assert.equal((await bindingsOf(g)).length + (await bindingsOf(p.chatId)).length, 0);
      assert.ok((await redeem(me, p.chatId, p.senderId)).ok);
      assert.ok((await redeem(grp, g, p.senderId)).ok);
    });

    test("AC-11: a wrong, an expired and an already used code bind nothing", async () => {
      const { tripId, ownerId } = await mkWhatsappTrip(pool);
      const p = waSender();
      expectRefused(await redeem("KWA-ABCD2345", p.chatId, p.senderId), "NOT_FOUND", false);
      const expired = await issue(tripId, ownerId, "me");
      await pool.query("UPDATE control_plane.chat_binding_codes SET expires_at = now() - interval '1 second' WHERE code_digest = $1", [`sha256:${createHash("sha256").update(expired).digest("hex")}`]);
      expectRefused(await redeem(expired, p.chatId, p.senderId), "EXPIRED", false);
      const used = await issue(tripId, ownerId, "me");
      assert.ok((await redeem(used, p.chatId, p.senderId)).ok);
      const q = waSender();
      expectRefused(await redeem(used, q.chatId, q.senderId), "NOT_FOUND", false);
      assert.equal((await bindingsOf(q.chatId)).length, 0);
    });

    test("AC-11: a group code in a group bound to a DIFFERENT trip binds nothing and is spent; the same trip answers 'already connected'", async () => {
      const a = await mkWhatsappTrip(pool, { title: "Rome" });
      const b = await mkWhatsappTrip(pool, { title: "Oslo" });
      const g = waGroupId(), s = waSender();
      assert.ok((await redeem(await issue(a.tripId, a.ownerId, "group"), g, s.senderId)).ok);
      const other = await issue(b.tripId, b.ownerId, "group");
      expectRefused(await redeem(other, g, s.senderId), "GROUP_BOUND_ELSEWHERE", true);
      assert.equal((await codeRow(other)).state, "expired");
      assert.equal((await bindingsOf(g)).filter((r) => r.closed_at === null)[0].trip_id, a.tripId, "the group stayed on its trip");
      const same = await issue(a.tripId, a.ownerId, "group");
      const r = await redeem(same, g, s.senderId);
      assert.ok(r.ok && r.kind === "group" && r.alreadyConnected);
      assert.match(redeemReplyLine(r)!, /already connected/);
      assert.equal((await codeRow(same)).state, "redeemed");
      assert.equal((await bindingsOf(g)).length, 1);
    });

    test("AC-11: a group whose REAL id is not of an accepted shape (or a chat with no address) binds nothing and spends nothing", async () => {
      const { tripId, ownerId } = await mkWhatsappTrip(pool);
      const code = await issue(tripId, ownerId, "group");
      const s = waSender();
      for (const bad of ["-1001234567", "100000000000001@lid", "120363025246125486@s.whatsapp.net", "123@g.us", "12345678901-@g.us", "12345678901-1234567890-5@g.us", "abc@g.us", "", "x".repeat(300)]) {
        expectRefused(await redeem(code, waGroupId(), s.senderId, { transportAddress: bad }), "BAD_CHAT_ID", false);
      }
      expectRefused(await redeem(code, waGroupId(), s.senderId, { transportAddress: null }), "BAD_CHAT_ID", false);
      // a raw real id is never a chat id, and a malformed alias is not one either
      for (const bad of [waGroupAddress(), waOldGroupAddress(), `wa_${"a".repeat(31)}@g`, `wa_${"a".repeat(32)}@x`, "-100123"]) {
        expectRefused(await redeem(code, bad, s.senderId), "BAD_CHAT_ID", false);
      }
      const me = await issue(tripId, ownerId, "me");
      expectRefused(await redeem(me, `${waSender().senderId}@p`, s.senderId), "BAD_CHAT_ID", false);
      expectRefused(await redeem(me, s.chatId, s.senderId, { transportAddress: null }), "BAD_CHAT_ID", false);
      assert.equal((await codeRow(code)).state, "issued");
      assert.equal((await codeRow(me)).state, "issued");
      // and both styles of a real group id are accepted
      assert.ok((await redeem(code, waGroupId(), s.senderId, { transportAddress: waOldGroupAddress() })).ok);
    });

    test("AC-11: a trip retired, or switched off, at that moment binds nothing; the code was of the right kind so it is spent", async () => {
      const off = await mkWhatsappTrip(pool);
      const code = await issue(off.tripId, off.ownerId, "me");
      await setWhatsappSwitch(pool, off.tripId, false);
      const s = waSender();
      expectRefused(await redeem(code, s.chatId, s.senderId), "TRIP_UNAVAILABLE", true);
      const ret = await mkWhatsappTrip(pool);
      const code2 = await issue(ret.tripId, ret.ownerId, "group");
      await pool.query("UPDATE control_plane.trips SET slug = 'retired-' || slug WHERE id = $1", [ret.tripId]);
      const g = waGroupId();
      expectRefused(await redeem(code2, g, s.senderId), "TRIP_UNAVAILABLE", true);
      assert.equal((await bindingsOf(g)).length + (await bindingsOf(s.chatId)).length, 0);
    });

    test("AC-11: an issuing account that is no longer a member binds nothing (fail closed)", async () => {
      const { tripId } = await mkWhatsappTrip(pool);
      const member = await mkUser(pool); await mkMember(pool, tripId, member, "member");
      const code = await issue(tripId, member, "me");
      await pool.query("UPDATE control_plane.trip_memberships SET status = 'revoked' WHERE trip_id = $1 AND user_id = $2", [tripId, member]);
      const s = waSender();
      expectRefused(await redeem(code, s.chatId, s.senderId), "ISSUER_NOT_ENTITLED", true);
      assert.equal((await bindingsOf(s.chatId)).length, 0);
    });

    test("AC-11: a Telegram group token is refused for a WhatsApp id, and a WhatsApp code is not a Telegram token", async () => {
      const { tripId, ownerId } = await mkWhatsappTrip(pool);
      await issueGroupBindingToken(pool, tripId, "424242", { ttlSeconds: 600 });
      const tok = await pool.query("SELECT 1 FROM control_plane.telegram_group_binding_tokens WHERE trip_id=$1", [tripId]);
      assert.equal(tok.rowCount, 1);
      assert.deepEqual(await redeemGroupBindingToken(pool, "KIN-ABCD2345", waGroupId(), "424242"), { ok: false, reason: "NOT_A_GROUP" });
      assert.equal(extractChatBindingCode("KIN-ABCD2345"), null);
      void ownerId;
    });

    test("AC-12: handleCodeMessage reads no database for a message with no code, silences a noisy chat, and counts only failures", async () => {
      const { tripId, ownerId } = await mkWhatsappTrip(pool);
      const limiter = new CodeAttemptLimiter({ perChatPerHour: 2 });
      const s = waSender();
      assert.deepEqual(await handleCodeMessage(pool, limiter, { text: "hello there", chatId: s.chatId, senderId: s.senderId, transportAddress: FIXTURE_ADDRESS }), { handled: false });
      for (let i = 0; i < 3; i += 1) {
        const out = await handleCodeMessage(pool, limiter, { text: "KWA-ABCD2345", chatId: s.chatId, senderId: s.senderId, transportAddress: FIXTURE_ADDRESS });
        assert.ok(out.handled && !out.silenced && out.reply);
      }
      const silent = await handleCodeMessage(pool, limiter, { text: await issue(tripId, ownerId, "me"), chatId: s.chatId, senderId: s.senderId, transportAddress: FIXTURE_ADDRESS });
      assert.deepEqual(silent, { handled: true, silenced: true, reply: null }, "even a correct code is not handled once silenced");
      const other = waSender();
      const good = await handleCodeMessage(pool, limiter, { text: `code ${await issue(tripId, ownerId, "me")}`, chatId: other.chatId, senderId: other.senderId, transportAddress: FIXTURE_ADDRESS });
      assert.ok(good.handled && !good.silenced && good.result.ok);
    });
  });

  describe("AC-13: who a sender is", () => {
    test("AC-13: the role is derived from the account's membership now, never read from the stored column", async () => {
      const { tripId, ownerId } = await mkWhatsappTrip(pool);
      const secondary = await mkUser(pool); await mkMember(pool, tripId, secondary, "organizer");
      const member = await mkUser(pool); await mkMember(pool, tripId, member, "member");
      const ended = await mkUser(pool); await mkMember(pool, tripId, ended, "owner", "revoked");
      const link = async (userId: string | null, name: string | null) => {
        const s = waSender();
        await pool.query(
          `INSERT INTO control_plane.trip_person_links (id, trip_id, telegram_user_id, participant_username, display_name, role, verified_via, platform, account_user_id)
           VALUES ($1,$2,$3,$4,$4,'participant','dashboard_code','whatsapp',$5)`, [uid("tpl"), tripId, s.senderId, name, userId]);
        return s.senderId;
      };
      const rows: [string, string | null, string][] = [
        ["owner", await link(ownerId, "dana"), "organizer"],
        ["secondary organizer", await link(secondary, "sec"), "secondary_organizer"],
        ["member", await link(member, "mem"), "participant"],
        ["ended membership", await link(ended, "old"), "participant"],
        ["no account", await link(null, "claimed"), "participant"],
      ];
      for (const [label, sender, role] of rows) {
        const person = await resolveWhatsAppPerson(pool, tripId, sender!);
        assert.equal(person?.role, role, label);
      }
      assert.equal(await resolveWhatsAppPerson(pool, tripId, waSender().senderId), null, "a sender with no link is nobody");
      assert.equal(await resolveWhatsAppPerson(pool, uid("trip"), rows[0]![1]!), null, "a link of another trip does not resolve here");
      assert.equal(await resolveWhatsAppPerson(pool, tripId, "424242"), null, "only an opaque sender id resolves");
      // demoting the owner changes the answer with no write to the link
      await pool.query("UPDATE control_plane.trip_memberships SET status = 'revoked' WHERE trip_id = $1 AND user_id = $2", [tripId, ownerId]);
      assert.equal((await resolveWhatsAppPerson(pool, tripId, rows[0]![1]!))?.role, "participant");
      assert.equal((await resolveWhatsAppPerson(pool, tripId, rows[4]![1]!))?.username, "claimed");
    });
  });

  describe("AC-14: a membership that ends ends the chat", () => {
    const connected = async () => {
      const { tripId, ownerId } = await mkWhatsappTrip(pool);
      const member = await mkUser(pool, "Noa"); await mkMember(pool, tripId, member, "member");
      const s = waSender();
      assert.ok((await redeem(await issue(tripId, member, "me"), s.chatId, s.senderId, { transportAddress: FIXTURE_ADDRESS, phoneLast4: FIXTURE_PHONE_LAST4 })).ok);
      return { tripId, ownerId, member, s };
    };

    test("AC-14: removeMember closes the binding (membership_ended), clears the address and deletes the link, in its transaction", async () => {
      const { tripId, ownerId, member, s } = await connected();
      assert.deepEqual(await removeMember(pool, { tripId, actorUserId: ownerId, targetUserId: member }), { ok: true });
      const b = (await bindingsOf(s.chatId))[0];
      assert.equal(b.closed_reason, "membership_ended");
      assert.equal(b.transport_address, null);
      assert.equal(b.phone_last4, null);
      assert.equal((await linksOf(tripId)).length, 0);
      assert.equal((await resolveWhatsAppPerson(pool, tripId, s.senderId)), null);
    });

    test("AC-14: the check before each private turn closes it for every other way a membership can end", async () => {
      const { tripId, member, s } = await connected();
      assert.deepEqual(await closeIfMembershipEnded(pool, s.chatId), { closed: false }, "an active member's chat stays open");
      await pool.query("UPDATE control_plane.trip_memberships SET status = 'revoked' WHERE trip_id = $1 AND user_id = $2", [tripId, member]);
      assert.deepEqual(await closeIfMembershipEnded(pool, s.chatId), { closed: true });
      assert.equal((await bindingsOf(s.chatId))[0].closed_reason, "membership_ended");
      assert.equal((await linksOf(tripId)).length, 0);
      assert.deepEqual(await closeIfMembershipEnded(pool, s.chatId), { closed: false }, "idempotent");
    });

    test("AC-14: a link with no account (a claim from the group) is not touched by the check", async () => {
      const { tripId } = await mkWhatsappTrip(pool);
      const s = waSender();
      await pool.query(
        `INSERT INTO control_plane.trip_person_links (id, trip_id, telegram_user_id, participant_username, role, verified_via, platform)
         VALUES ($1,$2,$3,'ella','participant','group_membership','whatsapp')`, [uid("tpl"), tripId, s.senderId]);
      await openBinding(pool, { tripId, chatId: s.chatId, platform: "whatsapp", transportAddress: FIXTURE_ADDRESS });
      assert.deepEqual(await closeIfMembershipEnded(pool, s.chatId), { closed: false });
    });
  });

  describe("AC-15 / AC-16: Remove and the connection list", () => {
    test("AC-15: Remove closes the binding (dashboard_removed), clears the address, deletes the person link and tells the chat nothing", async () => {
      const { tripId, ownerId } = await mkWhatsappTrip(pool);
      const s = waSender(), g = waGroupId();
      assert.ok((await redeem(await issue(tripId, ownerId, "me"), s.chatId, s.senderId, { transportAddress: FIXTURE_ADDRESS, phoneLast4: FIXTURE_PHONE_LAST4 })).ok);
      assert.ok((await redeem(await issue(tripId, ownerId, "group"), g, s.senderId, { chatTitle: "Family" })).ok);
      const [person, group] = await listWhatsAppConnections(pool, tripId);
      assert.deepEqual(await removeWhatsAppConnection(pool, { tripId, bindingId: person!.bindingId }), { ok: true });
      const b = (await bindingsOf(s.chatId))[0];
      assert.equal(b.closed_reason, "dashboard_removed");
      assert.equal(b.transport_address, null);
      assert.equal((await linksOf(tripId)).length, 0);
      assert.deepEqual(await removeWhatsAppConnection(pool, { tripId, bindingId: person!.bindingId }), { ok: false, reason: "NOT_FOUND" }, "already removed");
      assert.deepEqual(await removeWhatsAppConnection(pool, { tripId: uid("trip"), bindingId: group!.bindingId }), { ok: false, reason: "NOT_FOUND" }, "not this trip's");
      assert.deepEqual(await removeWhatsAppConnection(pool, { tripId, bindingId: "garbage" }), { ok: false, reason: "NOT_FOUND" });
      assert.deepEqual(await removeWhatsAppConnection(pool, { tripId, bindingId: group!.bindingId }), { ok: true });
      assert.equal((await bindingsOf(g))[0].closed_reason, "dashboard_removed");
      // a later message from that chat is an unbound chat again, and the person can connect again
      assert.deepEqual((await pool.query("SELECT 1 FROM control_plane.telegram_chat_bindings WHERE chat_id=$1 AND closed_at IS NULL", [s.chatId])).rowCount, 0);
      assert.ok((await redeem(await issue(tripId, ownerId, "me"), s.chatId, s.senderId)).ok);
    });

    test("AC-15: Remove cannot close a Telegram binding", async () => {
      const { tripId } = await mkWhatsappTrip(pool);
      const id = await openBinding(pool, { tripId, chatId: "-100424242" });
      assert.deepEqual(await removeWhatsAppConnection(pool, { tripId, bindingId: id }), { ok: false, reason: "NOT_FOUND" });
    });

    test("AC-16: each row carries only binding id, kind, name, how, when and the last four digits; never a chat id, address, sender id or code", async () => {
      const { tripId, ownerId } = await mkWhatsappTrip(pool);
      const noa = await mkUser(pool, "Noa Levi"); await mkMember(pool, tripId, noa, "member");
      const p1 = waSender(), p2 = waSender(), g1 = waGroupId(), g2 = waGroupId(), g1Real = waOldGroupAddress();
      const gcode = await issue(tripId, ownerId, "group");
      assert.ok((await redeem(gcode, g1, p1.senderId, { chatTitle: "Family <b>group</b>", transportAddress: g1Real })).ok);
      await openBinding(pool, { tripId, chatId: g2, platform: "whatsapp", title: "Added by the owner" });
      const mecode = await issue(tripId, noa, "me");
      assert.ok((await redeem(mecode, p1.chatId, p1.senderId, { transportAddress: FIXTURE_ADDRESS, phoneLast4: FIXTURE_PHONE_LAST4 })).ok);
      await pool.query(
        `INSERT INTO control_plane.trip_person_links (id, trip_id, telegram_user_id, participant_username, display_name, role, verified_via, platform)
         VALUES ($1,$2,$3,'ella','Ella','participant','group_membership','whatsapp')`, [uid("tpl"), tripId, p2.senderId]);
      await openBinding(pool, { tripId, chatId: p2.chatId, platform: "whatsapp", transportAddress: FIXTURE_ADDRESS });
      const list = await listWhatsAppConnections(pool, tripId);
      assert.deepEqual(list.map((c) => [c.kind, c.name, c.via, c.lastFour ?? null]), [
        ["group", "Family <b>group</b>", "group_code", null],
        ["group", "Added by the owner", "added_to_group", null],
        ["person", "Noa Levi", "dashboard_code", FIXTURE_PHONE_LAST4],
        ["person", "Ella", "group_membership", null],
      ]);
      for (const c of list) assert.deepEqual(Object.keys(c).filter((k) => !["bindingId", "kind", "name", "via", "connectedAt", "lastFour"].includes(k)), []);
      const text = JSON.stringify(list);
      for (const secret of [p1.senderId, p2.senderId, p1.chatId, g1, g2, g1Real, g1Real.split("-")[0]!, FIXTURE_ADDRESS, mecode, gcode, mecode.slice(4)]) assert.ok(!text.includes(secret), `leaked ${secret}`);
      // other trips' connections are not listed
      assert.deepEqual(await listWhatsAppConnections(pool, (await mkWhatsappTrip(pool)).tripId), []);
    });
  });

  describe("AC-18: the owner is told", () => {
    const sink = () => {
      const sent: { chatId: string; text: string }[] = [];
      return { sent, sendWhatsApp: async (chatId: string, text: string) => { sent.push({ chatId, text }); } };
    };
    const connectOwner = async (tripId: string, ownerId: string) => {
      const s = waSender();
      const r = await redeem(await issue(tripId, ownerId, "me"), s.chatId, s.senderId, { transportAddress: FIXTURE_ADDRESS });
      assert.ok(r.ok);
      return s;
    };
    const connectGroup = async (tripId: string, ownerId: string, title: string) => {
      const g = waGroupId();
      const r = await redeem(await issue(tripId, ownerId, "group"), g, waSender().senderId, { chatTitle: title });
      assert.ok(r.ok);
      return (r as { bindingId: string }).bindingId;
    };

    test("AC-18: with the owner's WhatsApp private chat connected, the notice goes there, names the group's title and no number", async () => {
      const { tripId, ownerId } = await mkWhatsappTrip(pool, { title: "Alsace" });
      const ownerChat = await connectOwner(tripId, ownerId);
      const bindingId = await connectGroup(tripId, ownerId, "Family");
      const s = sink();
      const notices = await notifyOwnersOfNewBinding(pool, s, { bindingId });
      assert.deepEqual(notices, [{ userId: ownerId, channel: "whatsapp" }]);
      assert.equal(s.sent.length, 1);
      assert.equal(s.sent[0]!.chatId, ownerChat.chatId);
      assert.match(s.sent[0]!.text, /"Family"/);
      assert.doesNotMatch(s.sent[0]!.text, /\d{6,}/);
      assert.equal((await pool.query("SELECT 1 FROM control_plane.notification_outbox WHERE trip_id=$1 AND notification_type='whatsapp_connection_notice'", [tripId])).rowCount, 0);
    });

    test("AC-18: with no WhatsApp chat but a Telegram private chat, it goes through the existing outbox and nothing is sent on WhatsApp", async () => {
      const { tripId, ownerId } = await mkWhatsappTrip(pool);
      const tgId = "5550001";
      await pool.query(
        "INSERT INTO control_plane.telegram_organizer_links(id,user_id,telegram_subject_digest,verified_via) VALUES ($1,$2,$3,'enrollment_redemption')",
        [uid("otl"), ownerId, `sha256:${createHash("sha256").update(tgId).digest("hex")}`]);
      await openBinding(pool, { tripId, chatId: tgId });
      const noa = await mkUser(pool, "Noa"); await mkMember(pool, tripId, noa, "member");
      const p = waSender();
      const r = await redeem(await issue(tripId, noa, "me"), p.chatId, p.senderId, { transportAddress: FIXTURE_ADDRESS, phoneLast4: FIXTURE_PHONE_LAST4 });
      assert.ok(r.ok);
      const s = sink();
      assert.deepEqual(await notifyOwnersOfNewBinding(pool, s, { bindingId: (r as { bindingId: string }).bindingId }), [{ userId: ownerId, channel: "telegram" }]);
      assert.equal(s.sent.length, 0);
      const rows = (await pool.query("SELECT recipient, payload, state FROM control_plane.notification_outbox WHERE trip_id=$1 AND notification_type='whatsapp_connection_notice'", [tripId])).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].recipient, tgId);
      assert.equal(rows[0].state, "pending");
      assert.equal(rows[0].payload.name, "Noa");
      assert.ok(!JSON.stringify(rows[0].payload).includes(FIXTURE_PHONE_LAST4), "not even the last four digits");
      assert.match(whatsappConnectionNoticeText(rows[0].payload)!, /Noa connected their WhatsApp/);
    });

    test("AC-18: the Telegram fallback is actually SENT by the outbox dispatcher (not skipped), naming the group title or the traveller and never a number", async () => {
      const { tripId, ownerId } = await mkWhatsappTrip(pool, { title: "Alsace" });
      const tgId = "5550003";
      await pool.query(
        "INSERT INTO control_plane.telegram_organizer_links(id,user_id,telegram_subject_digest,verified_via) VALUES ($1,$2,$3,'enrollment_redemption')",
        [uid("otl"), ownerId, `sha256:${createHash("sha256").update(tgId).digest("hex")}`]);
      await openBinding(pool, { tripId, chatId: tgId });
      const noa = await mkUser(pool, "Noa"); await mkMember(pool, tripId, noa, "member");
      const person = waSender();
      const personBinding = ((await redeem(await issue(tripId, noa, "me"), person.chatId, person.senderId, { transportAddress: FIXTURE_ADDRESS, phoneLast4: FIXTURE_PHONE_LAST4 })) as { bindingId: string }).bindingId;
      const old = waOldGroupAddress();
      const groupBinding = ((await redeem(await issue(tripId, ownerId, "group"), waGroupId(), person.senderId, { chatTitle: "Family", transportAddress: old })) as { bindingId: string }).bindingId;
      const none = sink();
      for (const bindingId of [personBinding, groupBinding]) await notifyOwnersOfNewBinding(pool, none, { bindingId });
      assert.equal(none.sent.length, 0);
      const adapter = new FakeNotificationAdapter();
      const dispatched = await dispatchPendingTripNotifications(pool, adapter);
      assert.ok(dispatched >= 2, "both notices were dispatched (earlier tests may have left others pending)");
      const mine = adapter.messageCalls.filter((c) => c.chatId === tgId);
      assert.equal(mine.length, 2);
      const [first, second] = mine.map((c) => c.text);
      assert.match(first!, /Noa connected their WhatsApp to "Alsace"/);
      assert.match(second!, /"Family" was connected to "Alsace" on WhatsApp/);
      for (const text of [first!, second!]) {
        assert.ok(!text.includes(FIXTURE_PHONE_LAST4) && !text.includes(old.split("-")[0]!) && !/\d{5,}/.test(text), `a number in: ${text}`);
      }
      const states = (await pool.query("SELECT state FROM control_plane.notification_outbox WHERE trip_id=$1 AND notification_type='whatsapp_connection_notice'", [tripId])).rows;
      assert.deepEqual(states, [{ state: "sent" }, { state: "sent" }]);
    });

    test("AC-18: with neither, only the dashboard list shows it; and the owner's own `me` connection is not announced to them", async () => {
      const { tripId, ownerId } = await mkWhatsappTrip(pool);
      const bindingId = await connectGroup(tripId, ownerId, "Family");
      const s = sink();
      assert.deepEqual(await notifyOwnersOfNewBinding(pool, s, { bindingId }), [{ userId: ownerId, channel: "dashboard_only" }]);
      assert.equal(s.sent.length, 0);
      const t2 = await mkWhatsappTrip(pool);
      const own = waSender();
      const r = await redeem(await issue(t2.tripId, t2.ownerId, "me"), own.chatId, own.senderId, { transportAddress: FIXTURE_ADDRESS });
      assert.deepEqual(await notifyOwnersOfNewBinding(pool, s, { bindingId: (r as { bindingId: string }).bindingId }), []);
      assert.equal(s.sent.length, 0);
    });

    test("AC-18: a failed WhatsApp send falls back to Telegram instead of being lost, and is logged without the chat", async () => {
      const { tripId, ownerId } = await mkWhatsappTrip(pool);
      const ownerChat = await connectOwner(tripId, ownerId);
      const tgId = "5550002";
      await pool.query(
        "INSERT INTO control_plane.telegram_organizer_links(id,user_id,telegram_subject_digest,verified_via) VALUES ($1,$2,$3,'enrollment_redemption')",
        [uid("otl"), ownerId, `sha256:${createHash("sha256").update(tgId).digest("hex")}`]);
      await openBinding(pool, { tripId, chatId: tgId });
      const bindingId = await connectGroup(tripId, ownerId, "Family");
      const lines: string[] = [];
      const notices = await notifyOwnersOfNewBinding(pool, { sendWhatsApp: async () => { throw new Error("bridge down"); }, log: (l) => lines.push(l) }, { bindingId });
      assert.deepEqual(notices, [{ userId: ownerId, channel: "telegram" }]);
      assert.ok(lines.every((l) => !l.includes(ownerChat.chatId)));
    });
  });

  describe("AC-18, owner's decision 2026-11-23: an owner's own connection that REPLACES an earlier one is announced", () => {
    const ADDRESS_A = "100000000000071@lid";
    const ADDRESS_B = "100000000000072@lid";
    /** Both sinks: the alias-only one (an OPEN binding's chat) and the addressed one (a chat whose binding just closed). */
    const sinks = (opts: { addressed?: "ok" | "throws" | "absent" } = {}) => {
      const byAlias: { chatId: string; text: string }[] = [];
      const byAddress: { chatId: string; transportAddress: string; text: string }[] = [];
      return {
        byAlias, byAddress,
        sendWhatsApp: async (chatId: string, text: string) => { byAlias.push({ chatId, text }); },
        ...(opts.addressed === "absent" ? {} : {
          sendWhatsAppToAddress: async (target: { chatId: string; transportAddress: string }, text: string) => {
            if (opts.addressed === "throws") throw new Error("the old chat is unreachable");
            byAddress.push({ chatId: target.chatId, transportAddress: target.transportAddress, text });
          },
        }),
      };
    };
    const telegramFor = async (tripId: string, userId: string, tgId: string) => {
      await pool.query(
        "INSERT INTO control_plane.telegram_organizer_links(id,user_id,telegram_subject_digest,verified_via) VALUES ($1,$2,$3,'enrollment_redemption')",
        [uid("otl"), userId, `sha256:${createHash("sha256").update(tgId).digest("hex")}`]);
      await openBinding(pool, { tripId, chatId: tgId });
    };
    const meOk = async (tripId: string, userId: string, s: { chatId: string; senderId: string }, extra: Record<string, unknown>) => {
      const code = await issue(tripId, userId, "me");
      const r = await redeem(code, s.chatId, s.senderId, extra);
      assert.ok(r.ok && r.kind === "me", JSON.stringify(r));
      return { result: r as Extract<RedeemResult, { kind: "me" }>, code };
    };
    const noSecrets = (text: string, secrets: string[]) => {
      for (const secret of secrets) assert.ok(!text.includes(secret), `leaked ${secret} in: ${text}`);
      assert.doesNotMatch(text, /\d{5,}/, "never a full number");
    };

    test("replaced from another chat: the notice goes to the owner's PREVIOUS chat by its address, names the new number's last four, and never reaches the new chat", async () => {
      const { tripId, ownerId } = await mkWhatsappTrip(pool, { title: "Alsace" });
      const a = waSender(), b = waSender();
      const first = await meOk(tripId, ownerId, a, { transportAddress: ADDRESS_A });
      assert.equal(first.result.replacedOwnerChat, null, "a first connection replaced nothing");
      const second = await meOk(tripId, ownerId, b, { transportAddress: ADDRESS_B, phoneLast4: FIXTURE_PHONE_LAST4 });
      const replaced = second.result.replacedOwnerChat;
      assert.ok(replaced, "the redemption reports the chat it replaced");
      assert.equal(replaced.chatId, a.chatId);
      assert.equal(replaced.transportAddress, ADDRESS_A, "captured before the close cleared it from the row");
      assert.equal((await bindingsOf(a.chatId))[0].transport_address, null, "and the row itself no longer holds it");
      assert.ok(!JSON.stringify(second.result).includes(ADDRESS_A), "the address does not serialise with the result (a logged result carries no address)");
      assert.ok(!JSON.stringify(replaced).includes(ADDRESS_A));

      const s = sinks();
      const notices = await notifyOwnersOfNewBinding(pool, s, { bindingId: second.result.bindingId, replaced });
      assert.deepEqual(notices, [{ userId: ownerId, channel: "whatsapp" }]);
      assert.deepEqual(s.byAlias, [], "never the NEW chat: a stolen code's holder must not be the one told");
      assert.equal(s.byAddress.length, 1);
      assert.equal(s.byAddress[0]!.chatId, a.chatId);
      assert.equal(s.byAddress[0]!.transportAddress, ADDRESS_A);
      const text = s.byAddress[0]!.text;
      console.log(`EVIDENCE replaced owner connection, previous chat gets: ${text}`);
      assert.match(text, /WhatsApp connection to "Alsace" was replaced by a new one/);
      assert.match(text, new RegExp(`\\(the new number ends in ${FIXTURE_PHONE_LAST4}\\)`));
      noSecrets(text, [a.chatId, b.chatId, a.senderId, b.senderId, ADDRESS_A, ADDRESS_B, first.code, second.code, second.code.slice(4)]);
      assert.equal((await pool.query("SELECT 1 FROM control_plane.notification_outbox WHERE trip_id=$1 AND notification_type='whatsapp_connection_notice'", [tripId])).rowCount, 0);
    });

    test("replaced, and the previous chat cannot be reached (no addressed sink, or it fails): Telegram through the outbox with the last four only; with neither, the dashboard", async () => {
      for (const addressed of ["absent", "throws"] as const) {
        const { tripId, ownerId } = await mkWhatsappTrip(pool, { title: "Alsace" });
        const tgId = addressed === "absent" ? "5550071" : "5550072";
        await telegramFor(tripId, ownerId, tgId);
        const a = waSender(), b = waSender();
        await meOk(tripId, ownerId, a, { transportAddress: ADDRESS_A });
        const second = await meOk(tripId, ownerId, b, { transportAddress: ADDRESS_B, phoneLast4: FIXTURE_PHONE_LAST4 });
        const s = sinks({ addressed });
        const lines: string[] = [];
        const notices = await notifyOwnersOfNewBinding(pool, { ...s, log: (l) => lines.push(l) }, { bindingId: second.result.bindingId, replaced: second.result.replacedOwnerChat });
        assert.deepEqual(notices, [{ userId: ownerId, channel: "telegram" }], addressed);
        assert.deepEqual(s.byAlias, [], `${addressed}: never the new chat`);
        assert.deepEqual(s.byAddress, []);
        const rows = (await pool.query("SELECT recipient, payload FROM control_plane.notification_outbox WHERE trip_id=$1 AND notification_type='whatsapp_connection_notice'", [tripId])).rows;
        assert.equal(rows.length, 1);
        assert.equal(rows[0].recipient, tgId);
        assert.deepEqual(Object.keys(rows[0].payload).sort(), ["kind", "language", "last4", "trip_title"], "the payload carries the trip, the language and the last four, nothing else");
        assert.equal(rows[0].payload.kind, "replaced");
        noSecrets(JSON.stringify(rows[0].payload), [a.chatId, b.chatId, a.senderId, b.senderId, ADDRESS_A, ADDRESS_B]);
        for (const l of lines) noSecrets(l, [a.chatId, b.chatId, ADDRESS_A, ADDRESS_B]);
        if (addressed === "throws") assert.equal(lines.filter((l) => l.includes("whatsapp.owner_notice_failed")).length, 1);
      }
      const adapter = new FakeNotificationAdapter();
      await dispatchPendingTripNotifications(pool, adapter);
      const sent = adapter.messageCalls.filter((c) => c.chatId === "5550071" || c.chatId === "5550072");
      assert.equal(sent.length, 2, "the outbox dispatcher sends the replaced notice (it knows the kind)");
      for (const c of sent) {
        assert.match(c.text, /WhatsApp connection to "Alsace" was replaced by a new one \(the new number ends in 4567\)/);
        noSecrets(c.text, [ADDRESS_A, ADDRESS_B]);
      }

      const { tripId, ownerId } = await mkWhatsappTrip(pool);
      const a = waSender(), b = waSender();
      await meOk(tripId, ownerId, a, { transportAddress: ADDRESS_A });
      const second = await meOk(tripId, ownerId, b, { transportAddress: ADDRESS_B });
      const s = sinks({ addressed: "absent" });
      assert.deepEqual(await notifyOwnersOfNewBinding(pool, s, { bindingId: second.result.bindingId, replaced: second.result.replacedOwnerChat }), [{ userId: ownerId, channel: "dashboard_only" }]);
      assert.deepEqual(s.byAlias, []);
    });

    test("the new number's last four are named only when known, and the Hebrew trip gets Hebrew", () => {
      const en = whatsappConnectionNoticeText({ kind: "replaced", trip_title: "Alsace", language: "en" })!;
      assert.equal(en, `Your WhatsApp connection to "Alsace" was replaced by a new one. If that was not you, remove it on the trip's WhatsApp page.`);
      assert.match(whatsappConnectionNoticeText({ kind: "replaced", last4: "4567", trip_title: "Alsace" })!, /\(the new number ends in 4567\)/);
      for (const bad of ["12345", "45a7", "+4567", 4567, null]) {
        assert.doesNotMatch(whatsappConnectionNoticeText({ kind: "replaced", last4: bad, trip_title: "Alsace" })!, /ends in/, String(bad));
      }
      const he = whatsappConnectionNoticeText({ kind: "replaced", last4: "4567", trip_title: "אלזס", language: "he" })!;
      assert.match(he, /הוחלף/);
      assert.match(he, /4567/);
    });

    test("a FIRST owner connection (nothing replaced) stays unannounced, as the spec says", async () => {
      const { tripId, ownerId } = await mkWhatsappTrip(pool);
      await telegramFor(tripId, ownerId, "5550073");
      const a = waSender();
      const first = await meOk(tripId, ownerId, a, { transportAddress: ADDRESS_A, phoneLast4: FIXTURE_PHONE_LAST4 });
      assert.equal(first.result.replacedOwnerChat, null);
      const s = sinks();
      assert.deepEqual(await notifyOwnersOfNewBinding(pool, s, { bindingId: first.result.bindingId, replaced: first.result.replacedOwnerChat }), []);
      assert.deepEqual(await notifyOwnersOfNewBinding(pool, s, { bindingId: first.result.bindingId }), []);
      assert.deepEqual([s.byAlias, s.byAddress], [[], []]);
      assert.equal((await pool.query("SELECT 1 FROM control_plane.notification_outbox WHERE trip_id=$1 AND notification_type='whatsapp_connection_notice'", [tripId])).rowCount, 0);
    });

    test("the SAME chat sending a new owner code replaces the earlier connection too, so it is announced (to that same chat, by its address)", async () => {
      const { tripId, ownerId } = await mkWhatsappTrip(pool, { title: "Alsace" });
      const a = waSender();
      await meOk(tripId, ownerId, a, { transportAddress: ADDRESS_A });
      const again = await meOk(tripId, ownerId, a, { transportAddress: ADDRESS_A, phoneLast4: FIXTURE_PHONE_LAST4 });
      assert.equal(again.result.replacedOwnerChat?.chatId, a.chatId);
      const s = sinks();
      assert.deepEqual(await notifyOwnersOfNewBinding(pool, s, { bindingId: again.result.bindingId, replaced: again.result.replacedOwnerChat }), [{ userId: ownerId, channel: "whatsapp" }]);
      assert.equal(s.byAddress.length, 1);
      assert.deepEqual(s.byAlias, []);
    });

    test("unchanged: a member or a secondary organizer replacing their OWN connection gets no replaced-notice and no address; the owner is told \"<name> connected their WhatsApp\" as before, in the owner's own chat", async () => {
      const { tripId, ownerId } = await mkWhatsappTrip(pool, { title: "Alsace" });
      const ownerChat = waSender();
      await meOk(tripId, ownerId, ownerChat, { transportAddress: ADDRESS_A });
      for (const [role, name] of [["member", "Noa"], ["organizer", "Sec"]] as const) {
        const user = await mkUser(pool, name); await mkMember(pool, tripId, user, role);
        const a = waSender(), b = waSender();
        await meOk(tripId, user, a, { transportAddress: ADDRESS_B });
        const second = await meOk(tripId, user, b, { transportAddress: ADDRESS_B, phoneLast4: FIXTURE_PHONE_LAST4 });
        assert.equal(second.result.replacedOwnerChat, null, `${role}: the address is returned only for an owner's replaced chat`);
        assert.deepEqual(second.result.closedBindingIds.length, 1, `${role}: the earlier chat was still closed (AC-9)`);
        const s = sinks();
        assert.deepEqual(await notifyOwnersOfNewBinding(pool, s, { bindingId: second.result.bindingId, replaced: second.result.replacedOwnerChat }), [{ userId: ownerId, channel: "whatsapp" }], role);
        assert.deepEqual(s.byAddress, []);
        assert.equal(s.byAlias.length, 1);
        assert.equal(s.byAlias[0]!.chatId, ownerChat.chatId, "to the owner's own connected chat");
        assert.match(s.byAlias[0]!.text, new RegExp(`^${name} connected their WhatsApp to "Alsace"`));
      }
    });

    test("unchanged for a co-owner: another owner replacing their connection is told to the co-owner as \"<name> connected\", and the replaced notice goes only to the owner it concerns", async () => {
      const { tripId, ownerId } = await mkWhatsappTrip(pool, { title: "Alsace" });
      const coOwner = await mkUser(pool, "Dana"); await mkMember(pool, tripId, coOwner, "owner");
      const coChat = waSender();
      await meOk(tripId, coOwner, coChat, { transportAddress: ADDRESS_B });
      const a = waSender(), b = waSender();
      await meOk(tripId, ownerId, a, { transportAddress: ADDRESS_A });
      const second = await meOk(tripId, ownerId, b, { transportAddress: ADDRESS_A, phoneLast4: FIXTURE_PHONE_LAST4 });
      const s = sinks();
      const notices = await notifyOwnersOfNewBinding(pool, s, { bindingId: second.result.bindingId, replaced: second.result.replacedOwnerChat });
      assert.deepEqual([...notices].sort((x, y) => x.userId.localeCompare(y.userId)), [{ userId: ownerId, channel: "whatsapp" }, { userId: coOwner, channel: "whatsapp" }].sort((x, y) => x.userId.localeCompare(y.userId)));
      assert.deepEqual(s.byAddress.map((m) => m.chatId), [a.chatId], "the replaced notice: only the owner whose connection it was, in their previous chat");
      assert.deepEqual(s.byAlias.map((m) => m.chatId), [coChat.chatId], "the co-owner: the ordinary notice in the co-owner's chat");
      assert.match(s.byAlias[0]!.text, /connected their WhatsApp to "Alsace"/);
    });
  });

  describe("AC-14 / lock order: a membership removed while a redemption is in flight", () => {
    /** Waits until `n` backends of this database are waiting on a lock (a deterministic point, not a sleep). */
    const waitForLockWaiters = async (n: number) => {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const r = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
        if (r.rows[0].n >= n) return;
        if (Date.now() > deadline) throw new Error(`only ${r.rows[0].n} backends waiting on a lock`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const noOpenBindingForRevoked = async (tripId: string, userId: string) => {
      const rows = (await pool.query(
        `SELECT 1 FROM control_plane.trip_person_links l
           JOIN control_plane.telegram_chat_bindings b ON b.trip_id = l.trip_id AND b.chat_id = l.telegram_user_id || '@p' AND b.closed_at IS NULL
          WHERE l.trip_id = $1 AND l.account_user_id = $2 AND l.platform = 'whatsapp'
            AND NOT EXISTS (SELECT 1 FROM control_plane.trip_memberships m WHERE m.trip_id = l.trip_id AND m.user_id = l.account_user_id AND m.status = 'active')`,
        [tripId, userId])).rowCount;
      assert.equal(rows, 0, "a revoked membership with an open WhatsApp binding and link");
    };

    test("AC-14: the removal commits first, then the redemption that already issued its code fails as ISSUER_NOT_ENTITLED (the membership read is locked, not a stale check)", async () => {
      const { tripId, ownerId } = await mkWhatsappTrip(pool);
      const member = await mkUser(pool, "Noa"); await mkMember(pool, tripId, member, "member");
      const code = await issue(tripId, member, "me");
      const s = waSender();
      // A stands in for removeMember part-way through: it holds the member's row and has revoked it, uncommitted.
      const a = await pool.connect();
      try {
        await a.query("BEGIN");
        await a.query("SELECT 1 FROM control_plane.trip_memberships WHERE trip_id = $1 AND user_id = $2 FOR UPDATE", [tripId, member]);
        await a.query("UPDATE control_plane.trip_memberships SET status = 'revoked' WHERE trip_id = $1 AND user_id = $2", [tripId, member]);
        const redemption = redeem(code, s.chatId, s.senderId);
        await waitForLockWaiters(1);
        await a.query("COMMIT");
        const result = await redemption;
        assert.equal(result.ok, false);
        assert.equal((result as { reason: string }).reason, "ISSUER_NOT_ENTITLED");
      } finally { a.release(); }
      assert.equal((await bindingsOf(s.chatId)).length, 0);
      await noOpenBindingForRevoked(tripId, member);
      void ownerId;
    });

    test("AC-14: the redemption holds the membership first, so removeMember waits for it and then CLOSES the new binding: never a revoked member with an open binding", async () => {
      const { tripId, ownerId } = await mkWhatsappTrip(pool);
      const member = await mkUser(pool, "Noa"); await mkMember(pool, tripId, member, "member");
      const other = await mkWhatsappTrip(pool);
      const s = waSender();
      // The chat is already bound elsewhere, and B holds that binding's row: the redemption will pass its membership check
      // and then wait at the binding lock, which is exactly the window the race needs.
      await redeem(await issue(other.tripId, other.ownerId, "me"), s.chatId, s.senderId);
      const code = await issue(tripId, member, "me");
      const b = await pool.connect();
      try {
        await b.query("BEGIN");
        await b.query("SELECT 1 FROM control_plane.telegram_chat_bindings WHERE chat_id = $1 AND closed_at IS NULL FOR UPDATE", [s.chatId]);
        const redemption = redeem(code, s.chatId, s.senderId);
        await waitForLockWaiters(1);
        // removeMember starts now: it must queue behind the redemption's hold on the member's row.
        const removal = removeMember(pool, { tripId, actorUserId: ownerId, targetUserId: member });
        await waitForLockWaiters(2);
        await b.query("COMMIT");
        const [redeemed, removed] = await Promise.all([redemption, removal]);
        assert.ok(redeemed.ok, JSON.stringify(redeemed));
        assert.deepEqual(removed, { ok: true });
      } finally { b.release(); }
      const mine = (await bindingsOf(s.chatId)).find((r) => r.trip_id === tripId)!;
      assert.equal(mine.closed_reason, "membership_ended", "removeMember closed the binding the redemption opened");
      assert.equal(mine.transport_address, null);
      assert.equal((await linksOf(tripId)).length, 0);
      await noOpenBindingForRevoked(tripId, member);
    });
  });

  describe("Lock order (spec 'Lock order')", () => {
    /** The statements `teardown-trip.py`'s retire_in_db runs, in its order: codes first, then bindings, then the trip. */
    const teardown = async (tripId: string, pauseMs = 0) => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("UPDATE control_plane.chat_binding_codes SET state = 'expired' WHERE trip_id = $1 AND state = 'issued'", [tripId]);
        if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
        await c.query("UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'trip_destroyed', transport_address = NULL, phone_last4 = NULL WHERE trip_id = $1 AND closed_at IS NULL", [tripId]);
        await c.query("UPDATE control_plane.trips SET slug = 'retired-' || slug, updated_at = now() WHERE id = $1", [tripId]);
        await c.query("COMMIT");
      } catch (e) { await c.query("ROLLBACK").catch(() => undefined); throw e; } finally { c.release(); }
    };

    test("AC-17 / lock order: redemption racing teardown never deadlocks (40P01), and no code survives the teardown", async () => {
      for (let round = 0; round < 8; round += 1) {
        const { tripId, ownerId } = await mkWhatsappTrip(pool);
        const codes = await Promise.all([issue(tripId, ownerId, "me"), issue(tripId, ownerId, "group"), issue(tripId, ownerId, "me")]);
        const s1 = waSender(), s2 = waSender();
        const settled = await Promise.allSettled([
          redeem(codes[0]!, s1.chatId, s1.senderId, { transportAddress: FIXTURE_ADDRESS }),
          redeem(codes[1]!, waGroupId(), s1.senderId),
          redeem(codes[2]!, s2.chatId, s2.senderId, { transportAddress: FIXTURE_ADDRESS }),
          teardown(tripId, round % 3),
        ]);
        for (const r of settled) {
          if (r.status === "rejected") assert.notEqual((r.reason as { code?: string }).code, "40P01", "deadlock detected");
        }
        assert.equal(settled[3]!.status, "fulfilled");
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM control_plane.chat_binding_codes WHERE trip_id=$1 AND state='issued'", [tripId])).rows[0].n, 0);
      }
    });

    test("AC-17 / lock order: issuing racing teardown never deadlocks either", async () => {
      for (let round = 0; round < 8; round += 1) {
        const { tripId, ownerId } = await mkWhatsappTrip(pool);
        for (let i = 0; i < 9; i += 1) await issue(tripId, ownerId, "me");
        const settled = await Promise.allSettled([
          issueChatBindingCode(pool, { tripId, userId: ownerId, kind: "me" }),
          issueChatBindingCode(pool, { tripId, userId: ownerId, kind: "me" }),
          teardown(tripId, round % 3),
        ]);
        for (const r of settled) {
          if (r.status === "rejected") assert.notEqual((r.reason as { code?: string }).code, "40P01", "deadlock detected");
        }
        assert.equal(settled[2]!.status, "fulfilled");
      }
    });
  });
});
