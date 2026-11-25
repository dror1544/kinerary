import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { TelegramNotificationAdapter } from "../src/adapters/telegram.js";
import { setFeatureSwitch } from "../src/feature-switches.js";
import { createGroupPhotoReporter, foldOutcomes, mayChangeGroupPhoto } from "../src/group-photo.js";
import { claimSchema, pollGroupPhotosOnce, requestKeyFor, type GroupPhotoPollerDeps } from "../src/group-photo-poller.js";
import { applyMigrations } from "../src/migrations.js";
import { dispatchPendingTripNotifications, type DispatchOptions } from "../src/outbox-dispatcher.js";
import { bindGroup, seedTrip, tripKeyFor } from "./support/plan-change-site.js";
import {
  BOT_ID, BOT_TOKEN, TINY_PNG_BASE64, startFakeTelegram, startPhotoGateway, startStubPhotoSite,
  type FakeTelegram, type PhotoGateway, type StubPhotoSite,
} from "./support/group-photo-stand-ins.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

// The trip group's photo (docs/specs/sprint-9/x-trip-group-photo.md), the control plane's half, over a real Postgres:
// AC-1, AC-2, AC-3, AC-5, AC-6 and the CP side of AC-7. The site is a stub (the real one is tests/group-photo-site.test.js),
// the gateway a stand-in with the real one's behaviour (runtime-gateway/test/group-photo.test.js), and Telegram a recording
// fake with the real adapter in front of it: what the adapter sends over HTTP is what is asserted.
const databaseUrl = testDatabaseUrl();
const skip = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

const KEY = "test-exchange-key-not-a-real-one";
const GROUP = "-1001000000011";
const GROUP_2 = "-1001000000022";
const CLAIM_AT = "2026-12-03T10:00:00Z";
const TOKEN_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_B = "bbbbbbbbbbbbbbbbbbbbbbbb";

let pool: pg.Pool;
let site: StubPhotoSite;
let gateway: PhotoGateway;
let telegram: FakeTelegram;
let adapter: TelegramNotificationAdapter;
let tripId: string;
let logs: string[];

const claimAnswer = (id = 7, over: Record<string, unknown> = {}) => ({
  request: { id, attempt: 1, claim_token: TOKEN_A, logo_hash: "0123456789abcdef", requested_at: CLAIM_AT },
  photo: { content_type: "image/png", base64: TINY_PNG_BASE64 },
  ...over,
});
const deps = (over: Partial<GroupPhotoPollerDeps> = {}): GroupPhotoPollerDeps => ({
  db: pool, exchangeKey: KEY, runtimeOrigin: gateway.origin, upstreamHostSuffixes: ["localhost"],
  report: createGroupPhotoReporter({ exchangeKey: KEY, runtimeOrigin: gateway.origin }),
  log: (line) => logs.push(line), ...over,
});
const options = (over: Partial<NonNullable<DispatchOptions["groupPhoto"]>> = {}): DispatchOptions => ({
  groupPhoto: {
    api: adapter,
    report: createGroupPhotoReporter({ exchangeKey: KEY, runtimeOrigin: gateway.origin }),
    switchOn: async () => true,
    ...over,
  },
});
const poll = () => pollGroupPhotosOnce(deps());
const dispatch = (opts: DispatchOptions = options()) => dispatchPendingTripNotifications(pool, adapter, (line) => logs.push(line), opts);
const rows = async () => (await pool.query<{ id: string; state: string; attempt: number; target: string | null; recipient: string | null; binding_id: string; payload: Record<string, unknown>; dedupe_key: string }>(
  "SELECT id, state, attempt, target, recipient, binding_id, payload, dedupe_key FROM control_plane.notification_outbox WHERE notification_type = 'trip_group_photo' ORDER BY created_at, id",
)).rows;
const reported = () => site.results.map((r) => ({ id: r.body.request_id, status: r.body.status, detail: r.body.detail }));
const tokensReported = () => site.results.map((r) => r.body.claim_token);
const admin = { status: "administrator", can_change_info: true };

describe("the trip group's photo (control plane)", { skip }, () => {
  before(async () => {
    pool = testPool();
    const client = await pool.connect();
    try {
      await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
      await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
      await applyMigrations(client, migrationsDir);
    } finally { client.release(); }
    telegram = await startFakeTelegram();
    gateway = await startPhotoGateway(KEY, () => site.origin, tripKeyFor);
  });
  after(async () => {
    await site?.close(); await gateway?.close(); await telegram?.close();
    const client = await pool.connect();
    try {
      await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
      await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    } finally { client.release(); await pool.end(); }
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE control_plane.notification_outbox, control_plane.telegram_chat_bindings, control_plane.runtime_routes, control_plane.jobs, control_plane.plans, control_plane.feature_switch_settings, control_plane.trips CASCADE");
    await site?.close();
    site = await startStubPhotoSite();
    gateway.requests.length = 0; gateway.failResults = false;
    telegram.calls.length = 0; telegram.members.clear(); telegram.photoError = null;
    adapter = new TelegramNotificationAdapter({ botToken: BOT_TOKEN, superAdminChatId: "1", db: pool, apiRoot: telegram.root, log: (line) => logs.push(line) });
    tripId = await seedTrip(pool, "colmar-photo", site.origin);
    await bindGroup(pool, tripId, GROUP);
    const on = await setFeatureSwitch(pool, { switch: "trip_group_photo", enabled: true, scope: "trip", trip: tripId, live: true, by: "test" });
    assert.equal(on.ok, true);
    telegram.members.set(GROUP, admin);
    logs = [];
  });

  // ── AC-1 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  test("AC-1: a claimed request becomes one targeted row; the dispatcher checks the bot, sets the photo, and the site is told done", async () => {
    site.claimAnswers.push(claimAnswer());
    assert.deepEqual(await poll(), { polled: 1, enqueued: 1, answered: 0, failed: 0 });
    const [row] = await rows();
    assert.equal(row!.state, "pending");
    assert.equal(row!.target, "trip_group");
    assert.equal(row!.recipient, null, "a targeted row has no recipient: nobody names a chat");
    assert.equal(telegram.calls.length, 0, "the poller sends nothing to Telegram");

    assert.equal(await dispatch(), 1);
    // The bot asked who it is, then what it is in THAT group, then set the photo, in that order.
    assert.deepEqual(telegram.calls.map((c) => c.method), ["getMe", "getChatMember", "setChatPhoto"]);
    assert.equal(telegram.calls[1]!.userId, BOT_ID);
    assert.equal(telegram.calls[1]!.chatId, GROUP);
    const set = telegram.calls[2]!;
    assert.equal(set.chatId, GROUP);
    assert.deepEqual(set.photo, Buffer.from(TINY_PNG_BASE64, "base64"), "the bytes the site gave arrive as the multipart file");
    assert.equal(set.photoName, "logo.png");
    assert.deepEqual(reported(), [{ id: 7, status: "done", detail: null }]);
    assert.deepEqual(tokensReported(), [TOKEN_A], "the result carries the claim's own token back");
    const [done] = await rows();
    assert.equal(done!.state, "sent");
    assert.deepEqual(done!.payload.result, { status: "done", detail: null });
    assert.equal("photo_base64" in done!.payload, false, "the photo is not kept once the row has ended");
  });

  test("AC-1: the road is the gateway with the control-plane key; the site is read with the trip's own key and a body of just its id", async () => {
    site.claimAnswers.push(claimAnswer());
    await poll();
    await dispatch();
    assert.ok(gateway.requests.length >= 2 && gateway.requests.every((r) => r.apiKey === KEY));
    assert.deepEqual(gateway.requests.map((r) => r.url), [`/internal/t/${tripId}/group-photo/claim`, `/internal/t/${tripId}/group-photo/result`]);
    assert.deepEqual(site.claims.map((c) => [c.apiKey, c.body]), [[tripKeyFor(tripId), { tripId }]]);
    assert.ok(site.results.every((r) => r.apiKey === tripKeyFor(tripId)), "the site never saw the control-plane key");
  });

  test("a creator may set it too", async () => {
    telegram.members.set(GROUP, { status: "creator" });
    site.claimAnswers.push(claimAnswer());
    await poll(); await dispatch();
    assert.equal(telegram.count("setChatPhoto"), 1);
    assert.deepEqual(reported().map((r) => r.status), ["done"]);
  });

  // ── AC-2 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  const lacking: Array<[string, import("./support/group-photo-stand-ins.js").Member]> = [
    ["a plain member", { status: "member" }],
    ["an administrator without can_change_info", { status: "administrator", can_change_info: false }],
    ["an administrator whose can_change_info is absent", { status: "administrator" }],
    ["an administrator whose can_change_info is the STRING true", { status: "administrator", can_change_info: "true" }],
    ["an administrator whose can_change_info is 1", { status: "administrator", can_change_info: 1 }],
    ["a restricted member", { status: "restricted", can_change_info: true }],
    ["a member who left", { status: "left" }],
    ["a kicked bot", { status: "kicked" }],
    ["a status Telegram has not told us about", { status: "something_new", can_change_info: true }],
    ["a bot Telegram will not answer for (403)", { error: 403, description: "Forbidden: bot was kicked from the supergroup chat" }],
    ["a chat Telegram cannot find (400)", { error: 400, description: "Bad Request: chat not found" }],
  ];
  for (const [label, member] of lacking) {
    test(`AC-2: ${label}: setChatPhoto is never called and the request reads bot_lacks_rights`, async () => {
      telegram.members.set(GROUP, member);
      site.claimAnswers.push(claimAnswer());
      await poll(); await dispatch();
      assert.equal(telegram.count("setChatPhoto"), 0, "nothing was sent to setChatPhoto");
      assert.deepEqual(reported().map((r) => [r.id, r.status]), [[7, "bot_lacks_rights"]]);
      assert.ok(typeof reported()[0]!.detail === "string" && (reported()[0]!.detail as string).length > 0, "with a reason");
      const [row] = await rows();
      assert.equal(row!.state, "skipped");
      assert.equal("photo_base64" in row!.payload, false);
      assert.equal(await dispatch(), 0);
      assert.equal(telegram.count("setChatPhoto"), 0);
    });
  }

  test("AC-2 (evidence): the Bot API's own log for a bot that is a member, then one that is an admin without the right, then one that may", async () => {
    const trace: string[] = [];
    for (const [label, member] of [["member", { status: "member" }], ["administrator, can_change_info false", { status: "administrator", can_change_info: false }], ["administrator, can_change_info true", admin]] as const) {
      telegram.calls.length = 0; site.results.length = 0;
      telegram.members.set(GROUP, member);
      // A fresh request each time (a different instant), the way a second ask is.
      site.claimAnswers.push(claimAnswer(100 + trace.length, { request: { id: 100 + trace.length, attempt: 1, claim_token: TOKEN_A, logo_hash: "0123456789abcdef", requested_at: `2026-12-03T1${trace.length}:00:00Z` } }));
      await poll(); await dispatch();
      trace.push(`bot is: ${label}`);
      for (const call of telegram.calls) trace.push(`  Bot API <- ${call.method}${call.chatId ? ` chat_id=<the bound group>${call.chatId === GROUP ? "" : " (WRONG CHAT)"}` : ""}${call.userId ? ` user_id=<the bot>${call.userId === BOT_ID ? "" : " (WRONG USER)"}` : ""}${call.photo ? ` photo=${call.photo.length} bytes` : ""}`);
      trace.push(`  setChatPhoto calls: ${telegram.count("setChatPhoto")}; the site was told: ${JSON.stringify(site.results.map((r) => r.body.status))}`);
    }
    console.log(trace.join("\n"));
    assert.match(trace.join("\n"), /member\n.*getMe\n.*getChatMember[^\n]*\n  setChatPhoto calls: 0; the site was told: \["bot_lacks_rights"\]/);
    assert.match(trace.join("\n"), /can_change_info true\n[^\n]*getChatMember[^\n]*\n[^\n]*setChatPhoto[^\n]*\n  setChatPhoto calls: 1; the site was told: \["done"\]/);
  });

  test("AC-2: the decision itself is closed: only the literal true on an administrator, or the creator", () => {
    assert.equal(mayChangeGroupPhoto({ status: "creator" }), true);
    assert.equal(mayChangeGroupPhoto({ status: "administrator", can_change_info: true }), true);
    for (const member of [{ status: "administrator" }, { status: "administrator", can_change_info: false }, { status: "member", can_change_info: true }, { status: "" }, { status: "unavailable" }]) {
      assert.equal(mayChangeGroupPhoto(member), false, JSON.stringify(member));
    }
  });

  // ── AC-3 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  test("AC-3: a trip with no open group is answered no_group at once; nothing is queued and Telegram is never asked", async () => {
    await pool.query("UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'test' WHERE trip_id = $1", [tripId]);
    site.claimAnswers.push(claimAnswer());
    assert.deepEqual(await poll(), { polled: 1, enqueued: 0, answered: 1, failed: 0 });
    assert.deepEqual(reported(), [{ id: 7, status: "no_group", detail: null }]);
    assert.deepEqual(await rows(), []);
    assert.equal(telegram.calls.length, 0);
  });

  test("AC-3: a trip whose only group is a WhatsApp one has no Telegram group either", async () => {
    await pool.query("UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'test' WHERE trip_id = $1", [tripId]);
    await pool.query(
      `INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile, platform, transport_address)
       VALUES ('tcb_whatsappgroup0001', $1, $2, 'profile', 'whatsapp', '120363000000000000@g.us')`,
      [`wa_${"0123456789abcdef".repeat(2)}@g`, tripId],
    );
    site.claimAnswers.push(claimAnswer());
    await poll();
    assert.deepEqual(reported().map((r) => r.status), ["no_group"]);
    assert.equal(telegram.calls.length, 0);
  });

  // ── AC-5 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  test("AC-5: the chat is the trip's own binding's, whatever the site's answer says; no chat id is in the row's payload", async () => {
    telegram.members.set("-100999", admin);
    site.claimAnswers.push(claimAnswer(7, { chat_id: "-100999", request: { id: 7, attempt: 1, claim_token: TOKEN_A, logo_hash: "0123456789abcdef", requested_at: CLAIM_AT, chat_id: "-100999" } }));
    await poll(); await dispatch();
    assert.deepEqual(telegram.calls.filter((c) => c.method !== "getMe").map((c) => c.chatId), [GROUP, GROUP]);
    assert.ok(!JSON.stringify((await rows())[0]!.payload).includes("-100"), "no chat id anywhere in the payload");
  });

  test("AC-5: the binding is re-read at send time: a group that left after the enqueue gets nothing, and the request reads no_group", async () => {
    site.claimAnswers.push(claimAnswer());
    await poll();
    await pool.query("UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'test' WHERE trip_id = $1", [tripId]);
    await dispatch();
    assert.equal(telegram.calls.length, 0, "not even a question to Telegram");
    assert.deepEqual(reported().map((r) => r.status), ["no_group"]);
    assert.ok(logs.some((line) => line.includes("outbox.targeted_skipped") && line.includes("binding_closed")));
  });

  test("AC-5: a row addressed to ANOTHER trip's binding sends nothing", async () => {
    site.claimAnswers.push(claimAnswer());
    await poll();
    const other = await seedTrip(pool, "someone-elses", site.origin);
    const foreign = await bindGroup(pool, other, GROUP_2);
    telegram.members.set(GROUP_2, admin);
    await pool.query("UPDATE control_plane.notification_outbox SET binding_id = $1 WHERE notification_type = 'trip_group_photo'", [foreign]);
    await dispatch();
    assert.equal(telegram.calls.length, 0);
    assert.deepEqual(reported().map((r) => r.status), ["no_group"]);
  });

  test("AC-5: only the poller makes these rows: the database refuses a targeted row with a recipient", async () => {
    await assert.rejects(
      pool.query(
        `INSERT INTO control_plane.notification_outbox (id, trip_id, kind, recipient, payload, signup_request_id, notification_type, adapter, state, target, binding_id)
         VALUES ('notif_aaaaaaaaaaaaaaaa', $1, 'trip_group_photo', '-100123', '{}', NULL, 'trip_group_photo', 'control-plane', 'pending', 'trip_group', NULL)`, [tripId]),
      /notification_outbox_target_no_recipient_check/,
    );
  });

  // ── AC-6 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  test("AC-6: Telegram refuses the photo: the outbox retries as it retries any send (three tries in all), then the request reads failed with Telegram's words", async () => {
    telegram.photoError = { status: 400, description: "Bad Request: PHOTO_INVALID_DIMENSIONS" };
    site.claimAnswers.push(claimAnswer());
    await poll();
    assert.equal(await dispatch(), 0);
    assert.equal((await rows())[0]!.state, "pending");
    assert.deepEqual(reported(), [], "not reported while it can still be retried");
    await dispatch();
    assert.equal(reported().length, 0);
    await dispatch();
    assert.equal(telegram.count("setChatPhoto"), 3, "exactly max_attempts tries");
    assert.deepEqual(reported(), [{ id: 7, status: "failed", detail: "Telegram said: Bad Request: PHOTO_INVALID_DIMENSIONS" }]);
    const [row] = await rows();
    assert.equal(row!.state, "failed");
    assert.equal(row!.attempt, 3);
    // Never a loop: more ticks change nothing.
    await dispatch(); await dispatch(); await poll();
    assert.equal(telegram.count("setChatPhoto"), 3);
    assert.equal(site.results.length, 1);
  });

  test("AC-6: a rate limit is retried and a later success is done", async () => {
    telegram.photoError = { status: 429, description: "Too Many Requests: retry after 5" };
    site.claimAnswers.push(claimAnswer());
    await poll(); await dispatch();
    telegram.photoError = null;
    await dispatch();
    assert.equal(telegram.count("setChatPhoto"), 2);
    assert.deepEqual(reported().map((r) => r.status), ["done"]);
  });

  test("AC-6: Telegram unreachable: the detail is a fixed phrase, never the URL (which carries the token)", async () => {
    const dead = new TelegramNotificationAdapter({ botToken: BOT_TOKEN, superAdminChatId: "1", db: pool, apiRoot: "http://127.0.0.1:9", log: (line) => logs.push(line) });
    site.claimAnswers.push(claimAnswer());
    await poll();
    for (let i = 0; i < 3; i++) await dispatchPendingTripNotifications(pool, dead, (line) => logs.push(line), options({ api: dead }));
    assert.deepEqual(reported().map((r) => [r.status, r.detail]), [["failed", "Telegram said: Telegram could not be reached"]]);
    assert.ok(!logs.join("\n").includes(BOT_TOKEN) && !JSON.stringify(reported()).includes(BOT_TOKEN));
  });

  // ── AC-7 (control plane side) ─────────────────────────────────────────────────────────────────────────────────────
  test("AC-7: a report that never arrived is made again from the row when the site hands the request out again: the photo is not sent twice", async () => {
    site.claimAnswers.push(claimAnswer());
    await poll();
    gateway.failResults = true;
    await dispatch();
    assert.equal(telegram.count("setChatPhoto"), 1);
    assert.deepEqual(site.results, [], "the site heard nothing");
    assert.ok(logs.some((line) => line.includes("group_photo.report_failed")));
    // Ten minutes on, the site puts the request back and the poller is handed it again (same request, second attempt).
    gateway.failResults = false;
    site.claimAnswers.push(claimAnswer(7, { request: { id: 7, attempt: 2, claim_token: TOKEN_B, logo_hash: "0123456789abcdef", requested_at: CLAIM_AT } }));
    assert.deepEqual(await poll(), { polled: 1, enqueued: 0, answered: 1, failed: 0 });
    assert.equal(telegram.count("setChatPhoto"), 1, "still one");
    assert.deepEqual(reported(), [{ id: 7, status: "done", detail: null }]);
    assert.deepEqual(tokensReported(), [TOKEN_B], "answered for the claim the site holds out NOW, not the one that was lost");
    assert.equal((await rows()).length, 1);
  });

  test("AC-7: handed out again while its row is still waiting to be sent: nothing is reported early and nothing is queued twice", async () => {
    site.claimAnswers.push(claimAnswer(), claimAnswer());
    await poll();
    assert.deepEqual(await poll(), { polled: 1, enqueued: 0, answered: 0, failed: 0 });
    assert.deepEqual(site.results, []);
    assert.equal((await rows()).length, 1);
  });

  test("AC-7: a second request (a different instant) is a new one, with its own row, and its own photo", async () => {
    site.claimAnswers.push(claimAnswer());
    await poll(); await dispatch();
    site.claimAnswers.push(claimAnswer(8, { request: { id: 8, attempt: 1, claim_token: TOKEN_A, logo_hash: "fedcba9876543210", requested_at: "2026-12-03T11:00:00Z" } }));
    await poll(); await dispatch();
    assert.equal(telegram.count("setChatPhoto"), 2);
    assert.deepEqual(reported().map((r) => r.id), [7, 8]);
    assert.notEqual(requestKeyFor(tripId, 7, CLAIM_AT), requestKeyFor(tripId, 7, "2026-12-03T11:00:00Z"));
  });

  // ── Several groups, switches, the poller's gate ───────────────────────────────────────────────────────────────────
  test("two groups: done only when both are; one that refused makes the answer the refusal, and says how many got the photo", async () => {
    await bindGroup(pool, tripId, GROUP_2);
    telegram.members.set(GROUP_2, { status: "member" });
    site.claimAnswers.push(claimAnswer());
    assert.equal((await poll()).enqueued, 1);
    assert.equal((await rows()).length, 2);
    await dispatch();
    assert.equal(telegram.count("setChatPhoto"), 1, "only the group where the bot may");
    assert.equal(reported().length, 1, "one answer for one request");
    assert.equal(reported()[0]!.status, "bot_lacks_rights");
    assert.match(String(reported()[0]!.detail), /^The photo was set in 1 of 2 groups\./);
  });

  test("the contract with the site: the poller's schema takes exactly the keys tests/group-photo-site.test.js pins the site's claim to", () => {
    // Restated on purpose. The site's test asserts the claim's keys are these, and this fails if the schema stops matching.
    const site = { request: { id: 7, attempt: 1, claim_token: TOKEN_A, logo_hash: "0123456789abcdef", requested_at: CLAIM_AT }, photo: { content_type: "image/png", base64: TINY_PNG_BASE64 } };
    assert.equal(claimSchema.safeParse(site).success, true);
    assert.equal(claimSchema.safeParse({ request: null }).success, true);
    for (const missing of ["id", "attempt", "claim_token", "logo_hash", "requested_at"] as const) {
      const { [missing]: _gone, ...rest } = site.request;
      assert.equal(claimSchema.safeParse({ ...site, request: rest }).success, false, `${missing} is required`);
    }
    assert.equal(claimSchema.safeParse({ request: site.request }).success, false, "a request with no photo is refused");
    assert.equal(claimSchema.safeParse({ ...site, photo: { ...site.photo, content_type: "image/svg+xml" } }).success, false);
    // A key the site adds later is dropped, never forwarded.
    const parsed = claimSchema.parse({ ...site, request: { ...site.request, chat_id: "-100" } });
    assert.equal(JSON.stringify(parsed).includes("-100"), false);
  });

  // ── Claim identity and supersession (boundary review of #664: F2, F3) ─────────────────────────────────────────────
  test("F2: a request handed out again while its row waits moves the row onto the NEW claim's token, so the answer is for the claim the site holds out", async () => {
    site.claimAnswers.push(claimAnswer());
    await poll();
    site.claimAnswers.push(claimAnswer(7, { request: { id: 7, attempt: 2, claim_token: TOKEN_B, logo_hash: "0123456789abcdef", requested_at: CLAIM_AT } }));
    assert.deepEqual(await poll(), { polled: 1, enqueued: 0, answered: 0, failed: 0 });
    assert.equal((await rows())[0]!.payload.claim_token, TOKEN_B);
    await dispatch();
    assert.deepEqual(tokensReported(), [TOKEN_B]);
  });

  test("F3: a newer claim of the same site request (another instant) ends the older unsent row as superseded: one setChatPhoto, the newer photo, one answer", async () => {
    const pngWith = (tail: string) => Buffer.concat([Buffer.from(TINY_PNG_BASE64, "base64"), Buffer.from(tail)]).toString("base64");
    site.claimAnswers.push(claimAnswer(7, { photo: { content_type: "image/png", base64: pngWith("-first") } }));
    await poll();
    site.claimAnswers.push(claimAnswer(7, {
      request: { id: 7, attempt: 1, claim_token: TOKEN_B, logo_hash: "fedcba9876543210", requested_at: "2026-12-03T11:00:00Z" },
      photo: { content_type: "image/png", base64: pngWith("-second") },
    }));
    assert.equal((await poll()).enqueued, 1);
    const all = await rows();
    assert.equal(all.length, 2);
    const [older, newer] = all;
    assert.equal(older!.state, "skipped");
    assert.equal("photo_base64" in older!.payload, false, "the older photo is not kept");
    assert.equal(older!.payload.superseded_by, newer!.payload.request_key);
    assert.equal(newer!.state, "pending");
    assert.equal(await dispatch(), 1);
    assert.equal(telegram.count("setChatPhoto"), 1, "one photo into the group, not two");
    assert.ok(telegram.calls.find((c) => c.method === "setChatPhoto")!.photo!.toString("latin1").endsWith("-second"), "the newer one");
    assert.deepEqual(reported(), [{ id: 7, status: "done", detail: null }]);
    assert.deepEqual(tokensReported(), [TOKEN_B]);
    assert.equal(await dispatch(), 0);
    assert.equal(telegram.count("setChatPhoto"), 1);
  });

  test("F3: a row that was read for sending and superseded meanwhile is not sent (its state is re-read before Telegram is asked)", async () => {
    site.claimAnswers.push(claimAnswer());
    await poll();
    // The dispatcher has selected the row; before it reaches Telegram, a newer claim supersedes it (switchOn runs in between).
    const supersede = async () => {
      await pool.query("UPDATE control_plane.notification_outbox SET state = 'skipped' WHERE notification_type = 'trip_group_photo'");
      return true;
    };
    assert.equal(await dispatch(options({ switchOn: supersede })), 0);
    assert.equal(telegram.calls.length, 0, "nothing was asked of Telegram");
    assert.deepEqual(site.results, [], "and nothing was answered for a request a newer claim now owns");
  });

  test("foldOutcomes: waits for every row; all done is done; a send failure outranks missing rights outranks no group", () => {
    const o = (status: "done" | "failed" | "bot_lacks_rights" | "no_group") => ({ status, detail: null });
    assert.equal(foldOutcomes([]), null);
    assert.equal(foldOutcomes([o("done"), null]), null);
    assert.deepEqual(foldOutcomes([o("done"), o("done")]), { status: "done", detail: null });
    assert.equal(foldOutcomes([o("no_group"), o("bot_lacks_rights")])!.status, "bot_lacks_rights");
    assert.equal(foldOutcomes([o("bot_lacks_rights"), o("failed"), o("done")])!.status, "failed");
  });

  test("the switch off: the poller asks the trip nothing at all", async () => {
    await setFeatureSwitch(pool, { switch: "trip_group_photo", enabled: false, scope: "trip", trip: tripId, live: true, by: "test" });
    site.claimAnswers.push(claimAnswer());
    assert.deepEqual(await poll(), { polled: 0, enqueued: 0, answered: 0, failed: 0 });
    assert.deepEqual(gateway.requests, []);
    assert.deepEqual(site.claims, []);
  });

  test("a switch that cannot be read is off, and a trip that was never switched is off", async () => {
    site.claimAnswers.push(claimAnswer());
    assert.equal((await pollGroupPhotosOnce(deps({ switchOn: async () => { throw new Error("db down"); } }))).polled, 0);
    assert.equal((await pollGroupPhotosOnce(deps({ switchOn: async () => ("true" as unknown as boolean) }))).polled, 0);
    await pool.query("TRUNCATE control_plane.feature_switch_settings");
    assert.equal((await poll()).polled, 0);
    assert.deepEqual(gateway.requests, []);
  });

  test("the switch is re-read when the row is sent: switched off between the claim and the send, nothing goes to Telegram and the site is told", async () => {
    site.claimAnswers.push(claimAnswer());
    await poll();
    await dispatch(options({ switchOn: async () => false }));
    assert.equal(telegram.calls.length, 0);
    assert.deepEqual(reported().map((r) => r.status), ["failed"]);
    assert.match(String(reported()[0]!.detail), /switched off/);
  });

  test("a dispatcher with no group-photo support ends the row failed, loudly, and sends nothing", async () => {
    site.claimAnswers.push(claimAnswer());
    await poll();
    await dispatch({});
    assert.equal(telegram.calls.length, 0);
    assert.equal((await rows())[0]!.state, "failed");
    assert.ok(logs.some((line) => line.includes("outbox.group_photo_unconfigured")));
  });

  test("a site that answers nonsense, or is not reachable, is a logged code and nothing is queued", async () => {
    site.claimAnswers.push({ request: { id: "x" } });
    assert.deepEqual(await poll(), { polled: 1, enqueued: 0, answered: 0, failed: 1 });
    site.claimAnswers.push({ request: { id: 7, attempt: 1, claim_token: TOKEN_A, logo_hash: "h", requested_at: CLAIM_AT }, photo: { content_type: "image/svg+xml", base64: "PHN2Zz4=PHN2Zz4=" } });
    assert.equal((await poll()).failed, 1);
    assert.deepEqual(await rows(), []);
    const bad = await pollGroupPhotosOnce(deps({ exchangeKey: "not-the-key" }));
    assert.equal(bad.failed, 1);
    assert.ok(logs.some((line) => line.includes("SITE_HTTP_401")));
  });

  test("a photo that is not a PNG never reaches Telegram", async () => {
    site.claimAnswers.push(claimAnswer(7, { photo: { content_type: "image/png", base64: Buffer.from("<svg>not a png</svg>").toString("base64") } }));
    await poll(); await dispatch();
    assert.equal(telegram.calls.length, 0);
    assert.deepEqual(reported().map((r) => r.status), ["failed"]);
  });

  test("no key, token or chat id in any log line", async () => {
    site.claimAnswers.push(claimAnswer());
    await poll(); await dispatch();
    telegram.photoError = { status: 400, description: "Bad Request: nope" };
    site.claimAnswers.push(claimAnswer(9, { request: { id: 9, attempt: 1, claim_token: TOKEN_A, logo_hash: "h", requested_at: "2026-12-04T10:00:00Z" } }));
    await poll(); await dispatch(); await dispatch(); await dispatch();
    const text = logs.join("\n");
    for (const secret of [KEY, BOT_TOKEN, GROUP, telegram.root, gateway.origin, site.origin]) assert.ok(!text.includes(secret), `a log line carries ${secret.slice(0, 12)}…`);
  });
});
