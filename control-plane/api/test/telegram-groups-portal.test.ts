/**
 * Telegram groups from the dashboard (#690, docs/specs/sprint-9/690-dashboard-chat-parity.md): AC-1 to AC-8, the three owner-only routes.
 * Every response that matters to the boundary review is printed as an `EVIDENCE` line (status, cache header, body, with codes redacted).
 * Nothing here switches the `whatsapp` feature on: these routes answer to no switch (spec D5), and the first test proves it.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";
import { digestTelegramId } from "../src/identity.js";
import { sha256, type PortalDependencies } from "../src/portal.js";
import { PORTAL_SCOPE_POLICY } from "../src/portal-scope.js";
import { TEST_BOT_TOKEN, launchFields, signedInitData } from "./support/mini-app-init-data.js";
import { testDatabaseUrl } from "./support/test-database.js";
import { freshDatabase, mkMember, mkTrip, mkUser, openBinding, uid, waGroupId } from "./support/whatsapp-fixture.js";

const SKIP = !testDatabaseUrl();
const ORIGIN = "http://portal.example.test";
const hex = () => randomBytes(8).toString("hex");

const profile = validateArchitectureProfile({
  version: 1, environment: "test", public_api: { bind_host: "127.0.0.1", port: 4310 },
  worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4311 },
  database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
  adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" },
  test_resources: { enabled: false },
});

describe("telegram groups: dashboard routes", { skip: SKIP }, () => {
  let pool: pg.Pool;
  // What the bot was told to leave, in order, and how it answers: the portal's `telegramGroups.leaveChat` is a seam, so what the
  // route asks of Telegram is asserted here and the adapter's own call is asserted in telegram-leave-chat.test.ts.
  const leaves: { chat: string; closedAtThatMoment: boolean }[] = [];
  let leaveFails = false;
  const logLines: string[] = [];
  const makeApp = (botUsername = "kinerary_bot", withLeave = true) => buildApp(profile, {
    portal: {
      db: pool, runtimeAccounts: { participantExists: async () => true, provisionParticipant: async () => {} },
      publicOrigin: ORIGIN, runtimeOrigin: "http://runtime.example.test", runtimeExchangeKey: "exchange-key",
      runtimeUpstreamHostSuffixes: ["internal"], telegramBotUsername: botUsername, sessionTtlSeconds: 3600,
      enrollmentTtlSeconds: 3600, approvalTtlSeconds: 3600, emailAuthLog: (line: string) => { logLines.push(line); },
      telegramMiniApp: { botToken: TEST_BOT_TOKEN, maxAgeSeconds: 300, enabled: () => true },
      ...(withLeave ? {
        telegramGroups: {
          leaveChat: async (chat: string) => {
            const open = await pool.query("SELECT 1 FROM control_plane.telegram_chat_bindings WHERE chat_id = $1 AND closed_at IS NULL", [chat]);
            leaves.push({ chat, closedAtThatMoment: open.rowCount === 0 });
            if (leaveFails) throw Object.assign(new Error("telegram leaveChat failed: HTTP 403"), { httpStatus: 403 });
          },
        },
      } : {}),
    } as PortalDependencies,
  });
  let app: ReturnType<typeof makeApp>;
  before(async () => { pool = await freshDatabase(); app = makeApp(); });
  after(async () => { await app.close(); await pool.end(); });

  type Sess = { cookie: string; csrf: string };
  async function fullSession(userId: string): Promise<Sess> {
    const raw = `sess-${hex()}`, csrf = `csrf-${hex()}`;
    await pool.query(
      "INSERT INTO control_plane.web_sessions(id,user_id,token_digest,csrf_digest,expires_at) VALUES ($1,$2,$3,$4,now() + interval '1 hour')",
      [uid("wsess"), userId, sha256(raw), sha256(csrf)]);
    return { cookie: `kit_session=${raw}; kit_csrf=${csrf}`, csrf };
  }
  /** A live per-trip Telegram link for the account: the proof the dashboard asks for before it mints. Returns the Telegram id. */
  async function linkTelegram(userId: string, tripId: string): Promise<number> {
    const telegramId = 8_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
    await pool.query(
      "INSERT INTO control_plane.telegram_organizer_trip_links(id,user_id,trip_id,telegram_subject_digest,verified_via) VALUES ($1,$2,$3,$4,'enrollment_redemption')",
      [`otl_${randomBytes(16).toString("hex")}`, userId, tripId, digestTelegramId(String(telegramId))]);
    return telegramId;
  }
  async function telegramSession(telegramId: number, tripId: string): Promise<Sess> {
    const initData = signedInitData(launchFields(telegramId, Date.now(), { query_id: `AA${hex()}`, start_param: tripId }));
    const response = await app.inject({ method: "POST", url: "/v1/auth/telegram-mini-app", headers: { "content-type": "application/json", origin: ORIGIN }, payload: JSON.stringify({ initData }) });
    assert.equal(response.statusCode, 200, response.body);
    const cookies = ([] as string[]).concat(response.headers["set-cookie"] as string[]);
    const pick = (name: string) => decodeURIComponent(cookies.find((c) => c.startsWith(`${name}=`))!.split(";")[0]!.slice(name.length + 1));
    const csrf = pick("kit_csrf");
    return { cookie: `kit_session=${pick("kit_session")}; kit_csrf=${csrf}`, csrf };
  }
  const call = (session: Sess | null, method: string, url: string, payload?: unknown, a = app) => a.inject({
    method: method as "GET", url,
    headers: { ...(session ? { cookie: session.cookie, "x-csrf-token": session.csrf } : {}), origin: ORIGIN, ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
  });
  const evidence = (label: string, r: { statusCode: number; headers: Record<string, unknown>; body: string }) =>
    console.log(`EVIDENCE ${label}: HTTP ${r.statusCode} cache-control=${String(r.headers["cache-control"])} body=${r.body.replace(/KWA-[A-Z0-9]{8}/gi, "KWA-********")}`);
  const notFound = (r: { statusCode: number; body: string }) => { assert.equal(r.statusCode, 404, r.body); assert.deepEqual(JSON.parse(r.body), { error: "NOT_FOUND" }); };
  const groupChat = () => `-100${Math.floor(1e9 + Math.random() * 8e9)}`;
  const codes = async (tripId: string) => (await pool.query("SELECT platform, kind, issued_by_user_id, state FROM control_plane.chat_binding_codes WHERE trip_id = $1 ORDER BY created_at", [tripId])).rows;

  /** An owner with Telegram linked, a member, a co-organizer, a stranger, and a second trip with its own owner. NO switch is set. */
  const fixture = async () => {
    const tripId = await mkTrip(pool, { title: "Alsace" });
    const ownerId = await mkUser(pool, "Dana Owner"); await mkMember(pool, tripId, ownerId, "owner");
    const ownerTelegram = await linkTelegram(ownerId, tripId);
    const member = await mkUser(pool, "Noa"); await mkMember(pool, tripId, member, "member");
    const secondary = await mkUser(pool, "Sec"); await mkMember(pool, tripId, secondary, "organizer");
    const stranger = await mkUser(pool, "Stranger");
    const otherTrip = await mkTrip(pool, { title: "Elsewhere" });
    const otherOwner = await mkUser(pool, "Other Owner"); await mkMember(pool, otherTrip, otherOwner, "owner");
    return {
      tripId, ownerId, ownerTelegram, otherTrip, otherOwner,
      owner: await fullSession(ownerId), memberS: await fullSession(member), secondaryS: await fullSession(secondary),
      strangerS: await fullSession(stranger), otherOwnerS: await fullSession(otherOwner),
    };
  };

  test("the routes are classified 'account', so a Telegram-minted session is refused before any handler", () => {
    for (const route of ["POST /v1/trips/:id/telegram-group-link", "GET /v1/trips/:id/telegram-groups", "DELETE /v1/trips/:id/telegram-groups/:bindingId"]) {
      assert.equal(PORTAL_SCOPE_POLICY[route], "account", route);
    }
  });

  test("AC-1: the owner gets a ready link with the code in it; no switch is needed, the answer is no-store, and the KIN- token is untouched", async () => {
    const f = await fixture();
    const kin = `gbt_${randomBytes(16).toString("hex")}`;
    await pool.query("INSERT INTO control_plane.telegram_group_binding_tokens(id,trip_id,token_digest,issued_to_telegram_user_id,expires_at) VALUES ($1,$2,$3,'777', now() + interval '1 day')", [kin, f.tripId, `sha256:${hex()}`]);
    const r = await call(f.owner, "POST", `/v1/trips/${f.tripId}/telegram-group-link`);
    evidence("owner POST telegram-group-link", r);
    assert.equal(r.statusCode, 201);
    assert.equal(r.headers["cache-control"], "private, no-store");
    const body = r.json();
    assert.deepEqual(Object.keys(body).sort(), ["expiresAt", "link"]);
    assert.match(body.link, /^https:\/\/t\.me\/kinerary_bot\?startgroup=KWA-[A-HJ-NP-Z2-9]{8}&admin=change_info\+pin_messages\+invite_users$/);
    assert.ok(Math.abs(new Date(body.expiresAt).getTime() - Date.now() - 900_000) < 10_000);
    assert.deepEqual(await codes(f.tripId), [{ platform: "telegram", kind: "group", issued_by_user_id: f.ownerId, state: "issued" }]);
    assert.equal((await pool.query("SELECT 1 FROM control_plane.telegram_group_binding_tokens WHERE id = $1 AND issued_to_telegram_user_id = '777'", [kin])).rowCount, 1, "the /group token was not replaced");
    // the digest is all that is stored, never the code
    assert.ok(!JSON.stringify((await pool.query("SELECT * FROM control_plane.chat_binding_codes WHERE trip_id = $1", [f.tripId])).rows).includes(/KWA-[A-HJ-NP-Z2-9]{8}/.exec(body.link)![0]));
  });

  test("AC-2: a member, a co-organizer, another trip's owner, a stranger, a trip that does not exist and a retired trip all get one 404, and nothing is written", async () => {
    const f = await fixture();
    for (const [label, session] of [["member", f.memberS], ["co-organizer", f.secondaryS], ["other trip's owner", f.otherOwnerS], ["stranger", f.strangerS]] as const) {
      const mint = await call(session, "POST", `/v1/trips/${f.tripId}/telegram-group-link`);
      evidence(`${label} POST telegram-group-link`, mint); notFound(mint);
      const list = await call(session, "GET", `/v1/trips/${f.tripId}/telegram-groups`);
      evidence(`${label} GET telegram-groups`, list); notFound(list);
      const del = await call(session, "DELETE", `/v1/trips/${f.tripId}/telegram-groups/tcb_${hex()}${hex()}`);
      evidence(`${label} DELETE telegram-groups/<id>`, del); notFound(del);
    }
    notFound(await call(f.owner, "POST", `/v1/trips/${uid("trip")}/telegram-group-link`));
    const retired = await mkTrip(pool, { retired: true });
    await mkMember(pool, retired, f.ownerId, "owner"); await linkTelegram(f.ownerId, retired);
    notFound(await call(f.owner, "POST", `/v1/trips/${retired}/telegram-group-link`));
    notFound(await call(f.owner, "GET", `/v1/trips/${retired}/telegram-groups`));
    assert.deepEqual(await codes(f.tripId), []);
    assert.deepEqual(await codes(retired), []);
  });

  test("AC-2: the owner of another trip cannot list or Unlink THIS trip's group by naming its binding id on their own trip", async () => {
    const f = await fixture();
    const chat = groupChat();
    const mine = await openBinding(pool, { tripId: f.tripId, chatId: chat, title: "Family" });
    const viaOtherTrip = await call(f.otherOwnerS, "DELETE", `/v1/trips/${f.otherTrip}/telegram-groups/${mine}`);
    evidence("other owner DELETE own-trip path with this trip's binding id", viaOtherTrip); notFound(viaOtherTrip);
    const list = await call(f.otherOwnerS, "GET", `/v1/trips/${f.otherTrip}/telegram-groups`);
    assert.deepEqual(list.json(), { groups: [] });
    assert.equal((await pool.query("SELECT closed_at FROM control_plane.telegram_chat_bindings WHERE id = $1", [mine])).rows[0].closed_at, null);
  });

  test("AC-2/AC-7: every non-owner session, and the scoped one, naming this trip's REAL group, private-chat and WhatsApp binding ids, on this trip's path and on their own trip's, changes nothing", async () => {
    const f = await fixture();
    leaves.length = 0;
    const group = await openBinding(pool, { tripId: f.tripId, chatId: groupChat(), title: "Family" });
    const dm =await openBinding(pool, { tripId: f.tripId, chatId: String(100000000 + Math.floor(Math.random() * 800000000)) });
    const wa = await openBinding(pool, { tripId: f.tripId, chatId: waGroupId(), platform: "whatsapp" });
    // a member and a co-organizer who each own ANOTHER trip, so "their own trip's path" is a trip they may use
    const both = await mkUser(pool, "Both"); await mkMember(pool, f.tripId, both, "member");
    const bothOwn = await mkTrip(pool); await mkMember(pool, bothOwn, both, "owner");
    const co = await mkUser(pool, "CoBoth"); await mkMember(pool, f.tripId, co, "organizer");
    const coOwn = await mkTrip(pool); await mkMember(pool, coOwn, co, "owner");
    const sessions = [
      ["member", f.memberS, f.tripId], ["co-organizer", f.secondaryS, f.tripId], ["other owner", f.otherOwnerS, f.otherTrip], ["stranger", f.strangerS, f.tripId],
      ["member who owns another trip, on their own trip's path", await fullSession(both), bothOwn],
      ["co-organizer who owns another trip, on their own trip's path", await fullSession(co), coOwn],
    ] as const;
    for (const [label, session, path] of sessions) {
      for (const [kind, id] of [["group", group], ["private chat", dm], ["WhatsApp group", wa]] as const) {
        const r = await call(session, "DELETE", `/v1/trips/${path}/telegram-groups/${id}`);
        evidence(`${label} DELETE real ${kind} binding id`, r);
        notFound(r);
      }
    }
    const scoped = await telegramSession(f.ownerTelegram, f.tripId);
    const rs = await call(scoped, "DELETE", `/v1/trips/${f.tripId}/telegram-groups/${group}`);
    evidence("scoped Telegram session DELETE real group binding id", rs);
    assert.equal(rs.statusCode, 403);
    const state = await pool.query("SELECT id, closed_at IS NOT NULL AS closed FROM control_plane.telegram_chat_bindings WHERE id = ANY($1::text[])", [[group, dm, wa]]);
    console.log(`EVIDENCE after every refused DELETE, binding rows: ${JSON.stringify(state.rows.map((r) => r.closed))}`);
    assert.deepEqual(state.rows.map((r) => r.closed), [false, false, false]);
    // And Telegram was never asked to do anything: nobody but the owner can make the bot leave a group.
    console.log(`EVIDENCE leaveChat calls after every refused non-owner and scoped DELETE: ${leaves.length}`);
    assert.deepEqual(leaves, []);
  });

  test("D6: Unlink closes the binding FIRST, then the bot leaves that one chat, once; the answer carries no chat id", async () => {
    const f = await fixture();
    leaves.length = 0; logLines.length = 0;
    const chat = groupChat();
    const other = groupChat();
    const binding = await openBinding(pool, { tripId: f.tripId, chatId: chat, title: "Family" });
    await openBinding(pool, { tripId: f.tripId, chatId: other });
    const r = await call(f.owner, "DELETE", `/v1/trips/${f.tripId}/telegram-groups/${binding}`);
    evidence("owner DELETE (the bot is told to leave)", r);
    assert.equal(r.statusCode, 200); assert.deepEqual(r.json(), { status: "removed" });
    assert.deepEqual(leaves, [{ chat, closedAtThatMoment: true }], "one leave, for that chat only, after the binding was already closed");
    assert.ok(!r.body.includes(chat));
    // a second Unlink of the same binding is not found and asks nothing of Telegram
    notFound(await call(f.owner, "DELETE", `/v1/trips/${f.tripId}/telegram-groups/${binding}`));
    assert.equal(leaves.length, 1);
    // the other group is untouched
    assert.equal((await pool.query("SELECT closed_at FROM control_plane.telegram_chat_bindings WHERE chat_id = $1", [other])).rows[0].closed_at, null);
  });

  test("D6: a leaveChat failure never undoes Unlink: 200, the binding is closed, one warn line, and no chat id anywhere in the log", async () => {
    const f = await fixture();
    leaves.length = 0; logLines.length = 0;
    const chat = groupChat();
    const binding = await openBinding(pool, { tripId: f.tripId, chatId: chat });
    leaveFails = true;
    try {
      const r = await call(f.owner, "DELETE", `/v1/trips/${f.tripId}/telegram-groups/${binding}`);
      evidence("owner DELETE while Telegram refuses the leave", r);
      assert.equal(r.statusCode, 200); assert.deepEqual(r.json(), { status: "removed" });
    } finally { leaveFails = false; }
    assert.equal(leaves.length, 1, "tried once, not retried");
    assert.equal((await pool.query("SELECT closed_reason FROM control_plane.telegram_chat_bindings WHERE id = $1", [binding])).rows[0].closed_reason, "dashboard_removed");
    const warn = logLines.filter((l) => l.includes("telegram_groups.leave_failed"));
    console.log(`EVIDENCE leave failure log line: ${warn.join(" | ")}`);
    assert.equal(warn.length, 1, logLines.join("\n"));
    assert.ok(warn[0].includes("403"));
    assert.ok(!logLines.join("\n").includes(chat), "the chat id is not logged");
  });

  test("D6: with no Telegram adapter to leave through, Unlink still closes the binding and says so in the log", async () => {
    const f = await fixture();
    logLines.length = 0;
    const bare = makeApp("kinerary_bot", false);
    try {
      const binding = await openBinding(pool, { tripId: f.tripId, chatId: groupChat() });
      const r = await call(f.owner, "DELETE", `/v1/trips/${f.tripId}/telegram-groups/${binding}`, undefined, bare);
      assert.equal(r.statusCode, 200);
      assert.equal((await pool.query("SELECT closed_at IS NOT NULL AS closed FROM control_plane.telegram_chat_bindings WHERE id = $1", [binding])).rows[0].closed, true);
      assert.ok(logLines.some((l) => l.includes("telegram_groups.leave_unavailable")), logLines.join("\n"));
    } finally { await bare.close(); }
  });

  test("AC-3: a scoped Telegram session is refused 403 ACCOUNT_SIGN_IN_REQUIRED on all three routes, even for the trip it is linked to", async () => {
    const f = await fixture();
    const scoped = await telegramSession(f.ownerTelegram, f.tripId);
    const post = await call(scoped, "POST", `/v1/trips/${f.tripId}/telegram-group-link`);
    evidence("scoped Telegram session POST telegram-group-link", post);
    assert.equal(post.statusCode, 403); assert.equal(post.json().error, "ACCOUNT_SIGN_IN_REQUIRED");
    const get = await call(scoped, "GET", `/v1/trips/${f.tripId}/telegram-groups`);
    evidence("scoped Telegram session GET telegram-groups", get);
    assert.equal(get.statusCode, 403);
    const del = await call(scoped, "DELETE", `/v1/trips/${f.tripId}/telegram-groups/tcb_${hex()}${hex()}`);
    assert.equal(del.statusCode, 403); assert.equal(del.json().error, "ACCOUNT_SIGN_IN_REQUIRED");
    assert.deepEqual(await codes(f.tripId), []);
  });

  test("unauthenticated is 401; a mutation without the CSRF header or from another origin is refused", async () => {
    const f = await fixture();
    assert.equal((await call(null, "POST", `/v1/trips/${f.tripId}/telegram-group-link`)).statusCode, 401);
    assert.equal((await call(null, "GET", `/v1/trips/${f.tripId}/telegram-groups`)).statusCode, 401);
    const noCsrf = await app.inject({ method: "POST", url: `/v1/trips/${f.tripId}/telegram-group-link`, headers: { cookie: f.owner.cookie, origin: ORIGIN } });
    assert.equal(noCsrf.statusCode, 403);
    const foreign = await app.inject({ method: "DELETE", url: `/v1/trips/${f.tripId}/telegram-groups/tcb_${hex()}${hex()}`, headers: { cookie: f.owner.cookie, "x-csrf-token": f.owner.csrf, origin: "http://evil.example" } });
    assert.equal(foreign.statusCode, 403);
  });

  test("AC-4: an owner with no Telegram link gets 409 TELEGRAM_NOT_LINKED and nothing is written; a revoked link counts as none", async () => {
    const f = await fixture();
    await pool.query("UPDATE control_plane.telegram_organizer_trip_links SET revoked_at = now(), revoked_reason = 'owner_unlinked' WHERE trip_id = $1", [f.tripId]);
    const r = await call(f.owner, "POST", `/v1/trips/${f.tripId}/telegram-group-link`);
    evidence("owner without a live Telegram link POST telegram-group-link", r);
    assert.equal(r.statusCode, 409); assert.equal(r.json().error, "TELEGRAM_NOT_LINKED");
    assert.deepEqual(await codes(f.tripId), []);
  });

  test("AC-4: a deployment with no bot username answers 503 and logs, never a link with an empty handle", async () => {
    const f = await fixture();
    const bare = makeApp("");
    try {
      const r = await call(f.owner, "POST", `/v1/trips/${f.tripId}/telegram-group-link`, undefined, bare);
      evidence("no bot username: POST telegram-group-link", r);
      assert.equal(r.statusCode, 503); assert.equal(r.json().error, "TELEGRAM_BOT_UNAVAILABLE");
      assert.ok(!r.body.includes("t.me"));
    } finally { await bare.close(); }
  });

  test("AC-5: ten codes a minute per user, then 429; and ten live codes per trip AND platform: a Telegram mint never expires a WhatsApp code", async () => {
    const f = await fixture();
    const wa = `cbc_${randomBytes(16).toString("hex")}`;
    await pool.query("INSERT INTO control_plane.chat_binding_codes(id,trip_id,platform,kind,issued_by_user_id,code_digest,expires_at) VALUES ($1,$2,'whatsapp','group',$3,$4,now() + interval '10 minutes')", [wa, f.tripId, f.ownerId, `sha256:${"a".repeat(64)}`]);
    for (let i = 0; i < 11; i += 1) {
      const r = await call(f.owner, "POST", `/v1/trips/${f.tripId}/telegram-group-link`);
      if (i < 10) assert.equal(r.statusCode, 201, `mint ${i}`);
      else { evidence("eleventh mint in a minute", r); assert.equal(r.statusCode, 429); assert.equal(r.headers["retry-after"], "60"); }
    }
    const live = await pool.query("SELECT platform, count(*)::int AS n FROM control_plane.chat_binding_codes WHERE trip_id = $1 AND state = 'issued' GROUP BY platform ORDER BY platform", [f.tripId]);
    assert.deepEqual(live.rows, [{ platform: "telegram", n: 10 }, { platform: "whatsapp", n: 1 }]);
    assert.equal((await pool.query("SELECT state FROM control_plane.chat_binding_codes WHERE id = $1", [wa])).rows[0].state, "issued");
  });

  test("AC-6: the list is the trip's open Telegram GROUPS only: not a private chat, not a WhatsApp binding, not a closed or another trip's binding; name and date only", async () => {
    const f = await fixture();
    const g1 = await openBinding(pool, { tripId: f.tripId, chatId: groupChat(), title: "Family   chat\n" });
    const g2 = await openBinding(pool, { tripId: f.tripId, chatId: groupChat() });
    await openBinding(pool, { tripId: f.tripId, chatId: String(100000000 + Math.floor(Math.random() * 800000000)) });
    await openBinding(pool, { tripId: f.tripId, chatId: waGroupId(), platform: "whatsapp", title: "WA group" });
    await openBinding(pool, { tripId: f.otherTrip, chatId: groupChat(), title: "Not mine" });
    const closed = await openBinding(pool, { tripId: f.tripId, chatId: groupChat(), title: "Gone" });
    await pool.query("UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'group_moved' WHERE id = $1", [closed]);
    const r = await call(f.owner, "GET", `/v1/trips/${f.tripId}/telegram-groups`);
    evidence("owner GET telegram-groups", r);
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers["cache-control"], "private, no-store");
    const { groups } = r.json();
    assert.deepEqual(groups.map((g: { bindingId: string }) => g.bindingId), [g1, g2]);
    assert.deepEqual(Object.keys(groups[0]).sort(), ["bindingId", "connectedAt", "name"]);
    assert.equal(groups[0].name, "Family chat");
    assert.equal(groups[1].name, null);
    assert.ok(!r.body.includes("-100"), "no chat id in the answer");
  });

  test("AC-7: Unlink closes THIS trip's Telegram group binding (dashboard_removed), says removed, and writes nothing else", async () => {
    const f = await fixture();
    const chat = groupChat();
    const binding = await openBinding(pool, { tripId: f.tripId, chatId: chat, title: "Family" });
    const r = await call(f.owner, "DELETE", `/v1/trips/${f.tripId}/telegram-groups/${binding}`);
    evidence("owner DELETE telegram-groups/<own binding>", r);
    assert.equal(r.statusCode, 200); assert.deepEqual(r.json(), { status: "removed" });
    const row = (await pool.query("SELECT closed_at IS NOT NULL AS closed, closed_reason FROM control_plane.telegram_chat_bindings WHERE id = $1", [binding])).rows[0];
    assert.deepEqual(row, { closed: true, closed_reason: "dashboard_removed" });
    assert.deepEqual((await call(f.owner, "GET", `/v1/trips/${f.tripId}/telegram-groups`)).json(), { groups: [] });
    notFound(await call(f.owner, "DELETE", `/v1/trips/${f.tripId}/telegram-groups/${binding}`));
    // the chat is free again: a new open binding is allowed (the partial unique index)
    await openBinding(pool, { tripId: f.tripId, chatId: chat });
  });

  test("AC-7: Unlink cannot reach another trip's group, this trip's private chat, a WhatsApp binding, or a malformed id; none of them changes", async () => {
    const f = await fixture();
    const theirs = await openBinding(pool, { tripId: f.otherTrip, chatId: groupChat() });
    const dm = await openBinding(pool, { tripId: f.tripId, chatId: String(100000000 + Math.floor(Math.random() * 800000000)) });
    const wa = await openBinding(pool, { tripId: f.tripId, chatId: waGroupId(), platform: "whatsapp" });
    for (const [label, id] of [["another trip's group", theirs], ["this trip's private chat", dm], ["this trip's WhatsApp group", wa], ["not an id", "x"], ["injection", "tcb_x'; DROP TABLE a;--"]] as const) {
      const r = await call(f.owner, "DELETE", `/v1/trips/${f.tripId}/telegram-groups/${encodeURIComponent(id)}`);
      evidence(`owner DELETE ${label}`, r);
      notFound(r);
    }
    for (const id of [theirs, dm, wa]) {
      assert.equal((await pool.query("SELECT closed_at FROM control_plane.telegram_chat_bindings WHERE id = $1", [id])).rows[0].closed_at, null);
    }
  });

  test("AC-8: the trip page carries telegram.groups for an organizer-side viewer on a full session, with owner true only for the owner, and for nobody else", async () => {
    const f = await fixture();
    const own = await call(f.owner, "GET", `/v1/trips/${f.tripId}`);
    assert.deepEqual(own.json().telegram.groups, { owner: true });
    assert.deepEqual((await call(f.secondaryS, "GET", `/v1/trips/${f.tripId}`)).json().telegram.groups, { owner: false });
    const member = await call(f.memberS, "GET", "/v1/trips");
    assert.equal(member.statusCode, 200);
    const memberTrip = member.json().trips.find((t: { id: string }) => t.id === f.tripId);
    assert.ok(memberTrip, "the member sees the trip in its list");
    assert.ok(!("groups" in (memberTrip.telegram ?? {})), "a plain member is shown no group section");
    const ownerList = (await call(f.owner, "GET", "/v1/trips")).json().trips.find((t: { id: string }) => t.id === f.tripId);
    assert.deepEqual(ownerList.telegram.groups, { owner: true }, "the trip card's menu reads the same fact from the list");
    const scoped = await call(await telegramSession(f.ownerTelegram, f.tripId), "GET", `/v1/trips/${f.tripId}`);
    assert.ok(!("groups" in (scoped.json().telegram ?? {})), "a Telegram-minted session is shown no group section: its routes would 403");
    // and the WhatsApp section stays absent: nothing here switched it on
    assert.ok(!("whatsapp" in own.json()));
  });
});

// New code on the old schema (every migration but the chat-binding one): the routes answer as if the feature were not there, with one
// warn line naming the event, and never a 500 carrying the database's own words. A second describe: it rebuilds the same database.
describe("telegram groups: dashboard routes on a database without the chat-binding migration", { skip: SKIP }, () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;
  const lines: string[] = [];
  before(async () => {
    pool = await freshDatabase({ oldSchema: true });
    app = buildApp(profile, {
      portal: {
        db: pool, runtimeAccounts: { participantExists: async () => true, provisionParticipant: async () => {} },
        publicOrigin: ORIGIN, runtimeOrigin: "http://runtime.example.test", runtimeExchangeKey: "exchange-key",
        runtimeUpstreamHostSuffixes: ["internal"], telegramBotUsername: "kinerary_bot", sessionTtlSeconds: 3600,
        enrollmentTtlSeconds: 3600, approvalTtlSeconds: 3600, emailAuthLog: (line: string) => { lines.push(line); },
        telegramMiniApp: { botToken: TEST_BOT_TOKEN, maxAgeSeconds: 300, enabled: () => true },
      } as PortalDependencies,
    });
  });
  after(async () => { await app.close(); await pool.end(); });

  test("list, mint and Unlink answer 404 with a warn line, not a 500", async () => {
    const tripId = await mkTrip(pool); const ownerId = await mkUser(pool, "Owner"); await mkMember(pool, tripId, ownerId, "owner");
    await pool.query(
      "INSERT INTO control_plane.telegram_organizer_trip_links(id,user_id,trip_id,telegram_subject_digest,verified_via) VALUES ($1,$2,$3,$4,'enrollment_redemption')",
      [`otl_${randomBytes(16).toString("hex")}`, ownerId, tripId, digestTelegramId("7100000009")]);
    const raw = `sess-${hex()}`, csrf = `csrf-${hex()}`;
    await pool.query(
      "INSERT INTO control_plane.web_sessions(id,user_id,token_digest,csrf_digest,expires_at) VALUES ($1,$2,$3,$4,now() + interval '1 hour')",
      [uid("wsess"), ownerId, sha256(raw), sha256(csrf)]);
    const headers = { cookie: `kit_session=${raw}; kit_csrf=${csrf}`, "x-csrf-token": csrf, origin: ORIGIN };
    for (const [method, url] of [
      ["POST", `/v1/trips/${tripId}/telegram-group-link`],
      ["GET", `/v1/trips/${tripId}/telegram-groups`],
      ["DELETE", `/v1/trips/${tripId}/telegram-groups/tcb_${hex()}${hex()}`],
    ] as const) {
      const r = await app.inject({ method, url, headers });
      console.log(`EVIDENCE old schema ${method} ${url.replace(tripId, "<trip>")}: HTTP ${r.statusCode} body=${r.body}`);
      assert.equal(r.statusCode, 404, `${method} ${url}: ${r.body}`);
      assert.deepEqual(r.json(), { error: "NOT_FOUND" });
    }
    assert.ok(lines.some((l) => l.includes("telegram_groups.schema_missing")), lines.join("\n"));
  });
});
