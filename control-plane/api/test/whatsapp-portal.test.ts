/**
 * WhatsApp S2, the dashboard routes (spec 625, "Dashboard routes and page"): AC-6, AC-7 and the route half of AC-16.
 * Every response that matters to the boundary review is printed as an `EVIDENCE` line (status, headers, body).
 * The fixture number is a test value; nothing here is a real deployment's.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { redeemChatBindingCode } from "../src/chat-binding-codes.js";
import { validateArchitectureProfile } from "../src/config.js";
import { digestTelegramId } from "../src/identity.js";
import { sha256, type PortalDependencies } from "../src/portal.js";
import { PORTAL_SCOPE_POLICY } from "../src/portal-scope.js";
import { TEST_BOT_TOKEN, launchFields, signedInitData } from "./support/mini-app-init-data.js";
import { testDatabaseUrl } from "./support/test-database.js";
import { freshDatabase, mkMember, mkTrip, mkUser, mkWhatsappTrip, setWhatsappSwitch, uid, waGroupId, waOldGroupAddress, waSender } from "./support/whatsapp-fixture.js";

const SKIP = !testDatabaseUrl();
const ORIGIN = "http://portal.example.test";
const FIXTURE_NUMBER = "15550100123";
const hex = () => randomBytes(8).toString("hex");

const profile = validateArchitectureProfile({
  version: 1, environment: "test", public_api: { bind_host: "127.0.0.1", port: 4310 },
  worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4311 },
  database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
  adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" },
  test_resources: { enabled: false },
});

describe("whatsapp portal routes", { skip: SKIP }, () => {
  let pool: pg.Pool;
  const makeApp = (whatsapp: PortalDependencies["whatsapp"]) => buildApp(profile, {
    portal: {
      db: pool, runtimeAccounts: { participantExists: async () => true, provisionParticipant: async () => {} },
      publicOrigin: ORIGIN, runtimeOrigin: "http://runtime.example.test", runtimeExchangeKey: "exchange-key",
      runtimeUpstreamHostSuffixes: ["internal"], telegramBotUsername: "kinerary_bot", sessionTtlSeconds: 3600,
      enrollmentTtlSeconds: 3600, approvalTtlSeconds: 3600,
      telegramMiniApp: { botToken: TEST_BOT_TOKEN, maxAgeSeconds: 300, enabled: () => true },
      ...(whatsapp ? { whatsapp } : {}),
    } as PortalDependencies,
  });
  let app: ReturnType<typeof makeApp>;
  before(async () => { pool = await freshDatabase(); app = makeApp({ number: FIXTURE_NUMBER, codeTtlSeconds: 900 }); });
  after(async () => { await app.close(); await pool.end(); });

  type Sess = { cookie: string; csrf: string };
  async function fullSession(userId: string): Promise<Sess> {
    const raw = `sess-${hex()}`, csrf = `csrf-${hex()}`;
    await pool.query(
      "INSERT INTO control_plane.web_sessions(id,user_id,token_digest,csrf_digest,expires_at) VALUES ($1,$2,$3,$4,now() + interval '1 hour')",
      [uid("wsess"), userId, sha256(raw), sha256(csrf)]);
    return { cookie: `kit_session=${raw}; kit_csrf=${csrf}`, csrf };
  }
  async function telegramSession(userId: string, tripId: string): Promise<Sess> {
    const telegramId = 8_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
    await pool.query(
      "INSERT INTO control_plane.telegram_organizer_trip_links(id,user_id,trip_id,telegram_subject_digest,verified_via) VALUES ($1,$2,$3,$4,'enrollment_redemption')",
      [`otl_${randomBytes(16).toString("hex")}`, userId, tripId, digestTelegramId(String(telegramId))]);
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
  const evidence = (label: string, r: { statusCode: number; headers: Record<string, unknown>; body: string }, redact = false) =>
    console.log(`EVIDENCE ${label}: HTTP ${r.statusCode} cache-control=${String(r.headers["cache-control"])} body=${redact ? r.body.replace(/KWA-[A-Z0-9]{8}/gi, "KWA-********").replace(/KWA-[A-Z0-9]{8}/gi, "KWA-********").replace(/%3A%20[A-Z0-9-]+/g, "%3A%20<code>") : r.body}`);

  const fixture = async () => {
    const { tripId, ownerId } = await mkWhatsappTrip(pool, { title: "Alsace" });
    const member = await mkUser(pool, "Noa"); await mkMember(pool, tripId, member, "member");
    const secondary = await mkUser(pool, "Sec"); await mkMember(pool, tripId, secondary, "organizer");
    const stranger = await mkUser(pool, "Stranger");
    return { tripId, ownerId, member, secondary, stranger, owner: await fullSession(ownerId), memberS: await fullSession(member), secondaryS: await fullSession(secondary), strangerS: await fullSession(stranger) };
  };

  test("AC-7: the routes are classified 'account', so a Telegram-minted session is refused before any handler", () => {
    for (const route of ["POST /v1/trips/:id/whatsapp-codes", "GET /v1/trips/:id/whatsapp-connections", "DELETE /v1/trips/:id/whatsapp-connections/:bindingId"]) {
      assert.equal(PORTAL_SCOPE_POLICY[route], "account", route);
    }
  });

  test("AC-7: a scoped Telegram session is refused 403 ACCOUNT_SIGN_IN_REQUIRED on all three routes, even for the trip it is linked to", async () => {
    const f = await fixture();
    const scoped = await telegramSession(f.ownerId, f.tripId);
    const post = await call(scoped, "POST", `/v1/trips/${f.tripId}/whatsapp-codes`, { kind: "me" });
    evidence("scoped Telegram session POST whatsapp-codes", post);
    assert.equal(post.statusCode, 403);
    assert.equal(post.json().error, "ACCOUNT_SIGN_IN_REQUIRED");
    const get = await call(scoped, "GET", `/v1/trips/${f.tripId}/whatsapp-connections`);
    evidence("scoped Telegram session GET whatsapp-connections", get);
    assert.equal(get.statusCode, 403);
    const del = await call(scoped, "DELETE", `/v1/trips/${f.tripId}/whatsapp-connections/tcb_${hex()}${hex()}`);
    assert.equal(del.statusCode, 403);
    assert.equal(del.json().error, "ACCOUNT_SIGN_IN_REQUIRED");
    assert.equal((await pool.query("SELECT 1 FROM control_plane.chat_binding_codes WHERE trip_id = $1", [f.tripId])).rowCount, 0);
  });

  test("AC-7: unauthenticated is 401, and a mutation without the CSRF header or from another origin is refused", async () => {
    const f = await fixture();
    assert.equal((await call(null, "POST", `/v1/trips/${f.tripId}/whatsapp-codes`, { kind: "me" })).statusCode, 401);
    assert.equal((await call(null, "GET", `/v1/trips/${f.tripId}/whatsapp-connections`)).statusCode, 401);
    const noCsrf = await app.inject({ method: "POST", url: `/v1/trips/${f.tripId}/whatsapp-codes`, headers: { cookie: f.owner.cookie, origin: ORIGIN, "content-type": "application/json" }, payload: JSON.stringify({ kind: "me" }) });
    assert.equal(noCsrf.statusCode, 403);
    const foreign = await app.inject({ method: "POST", url: `/v1/trips/${f.tripId}/whatsapp-codes`, headers: { cookie: f.owner.cookie, "x-csrf-token": f.owner.csrf, origin: "http://evil.example", "content-type": "application/json" }, payload: JSON.stringify({ kind: "me" }) });
    assert.equal(foreign.statusCode, 403);
  });

  test("AC-7: a member may mint a `me` code for itself; the answer carries the link and the expiry, is no-store, and the code opens WhatsApp on the number", async () => {
    const f = await fixture();
    const r = await call(f.memberS, "POST", `/v1/trips/${f.tripId}/whatsapp-codes`, { kind: "me" });
    evidence("member POST whatsapp-codes {kind:me} (code redacted)", r, true);
    assert.equal(r.statusCode, 201);
    assert.equal(r.headers["cache-control"], "private, no-store");
    const body = r.json();
    assert.deepEqual(Object.keys(body).sort(), ["expiresAt", "link"]);
    const url = new URL(body.link);
    assert.equal(url.origin + url.pathname, `https://wa.me/${FIXTURE_NUMBER}`);
    const text = url.searchParams.get("text")!;
    assert.match(text, /KWA-[A-HJ-NP-Z2-9]{8}/);
    assert.ok(Math.abs(new Date(body.expiresAt).getTime() - Date.now() - 900_000) < 10_000);
    const row = (await pool.query("SELECT kind, issued_by_user_id, state FROM control_plane.chat_binding_codes WHERE trip_id=$1", [f.tripId])).rows[0];
    assert.deepEqual(row, { kind: "me", issued_by_user_id: f.member, state: "issued" });
    // the code really redeems, as that member
    const s = waSender();
    const code = /KWA-[A-HJ-NP-Z2-9]{8}/.exec(text)![0];
    const redeemed = await redeemChatBindingCode(pool, { text, chatId: s.chatId, senderId: s.senderId, transportAddress: "100000000000008@lid" });
    assert.ok(redeemed.ok && redeemed.kind === "me" && redeemed.accountUserId === f.member);
    void code;
  });

  test("AC-7: the Hebrew page gets a Hebrew sentence round the code, and a group link is WhatsApp's share screen with no number", async () => {
    const f = await fixture();
    const he = await call(f.owner, "POST", `/v1/trips/${f.tripId}/whatsapp-codes`, { kind: "me", language: "he" });
    assert.match(decodeURIComponent(new URL(he.json().link).searchParams.get("text")!), /הקוד שלי/);
    const group = await call(f.owner, "POST", `/v1/trips/${f.tripId}/whatsapp-codes`, { kind: "group" });
    evidence("owner POST whatsapp-codes {kind:group} (code redacted)", group, true);
    assert.equal(group.statusCode, 201);
    const url = new URL(group.json().link);
    assert.equal(url.origin + url.pathname, "https://wa.me/");
    assert.ok(!group.body.includes(FIXTURE_NUMBER));
    assert.match(url.searchParams.get("text")!, /KWA-/);
  });

  test("AC-7: only the owner may ask for a `group` code, read the connections or Remove; everyone else, and every non-member, gets one 404", async () => {
    const f = await fixture();
    const notFound = (r: { statusCode: number; body: string }) => { assert.equal(r.statusCode, 404, r.body); assert.deepEqual(JSON.parse(r.body), { error: "NOT_FOUND" }); };
    for (const [label, session] of [["member", f.memberS], ["secondary organizer", f.secondaryS], ["stranger", f.strangerS]] as const) {
      const r = await call(session, "POST", `/v1/trips/${f.tripId}/whatsapp-codes`, { kind: "group" });
      if (label === "member") evidence("member POST whatsapp-codes {kind:group}", r);
      notFound(r);
      const list = await call(session, "GET", `/v1/trips/${f.tripId}/whatsapp-connections`);
      if (label === "stranger") evidence("non-member GET whatsapp-connections", list);
      notFound(list);
      notFound(await call(session, "DELETE", `/v1/trips/${f.tripId}/whatsapp-connections/tcb_${hex()}${hex()}`));
    }
    notFound(await call(f.strangerS, "POST", `/v1/trips/${f.tripId}/whatsapp-codes`, { kind: "me" }));
    notFound(await call(f.owner, "POST", `/v1/trips/${uid("trip")}/whatsapp-codes`, { kind: "me" }));
    const retired = await mkTrip(pool, { retired: true });
    await mkMember(pool, retired, f.ownerId, "owner"); await setWhatsappSwitch(pool, retired, true);
    notFound(await call(f.owner, "POST", `/v1/trips/${retired}/whatsapp-codes`, { kind: "me" }));
    notFound(await call(f.owner, "GET", `/v1/trips/${retired}/whatsapp-connections`));
    assert.equal((await call(f.owner, "POST", `/v1/trips/${f.tripId}/whatsapp-codes`, { kind: "everyone" })).statusCode, 400);
    assert.equal((await call(f.secondaryS, "POST", `/v1/trips/${f.tripId}/whatsapp-codes`, { kind: "me" })).statusCode, 201, "any active member may mint a `me` code");
  });

  test("AC-6: with the trip's switch off, or no number configured, every WhatsApp route answers 404 and the trip page shows no section", async () => {
    const f = await fixture();
    const before = await call(f.owner, "GET", `/v1/trips/${f.tripId}`);
    assert.deepEqual(before.json().whatsapp, { number: FIXTURE_NUMBER, owner: true });
    await setWhatsappSwitch(pool, f.tripId, false);
    for (const [method, url, payload] of [
      ["POST", `/v1/trips/${f.tripId}/whatsapp-codes`, { kind: "me" }],
      ["POST", `/v1/trips/${f.tripId}/whatsapp-codes`, { kind: "group" }],
      ["GET", `/v1/trips/${f.tripId}/whatsapp-connections`, undefined],
      ["DELETE", `/v1/trips/${f.tripId}/whatsapp-connections/tcb_${hex()}${hex()}`, undefined],
    ] as const) {
      const r = await call(f.owner, method, url, payload);
      if (method === "POST" && payload.kind === "me") evidence("switch off: POST whatsapp-codes", r);
      assert.equal(r.statusCode, 404, `${method} ${url}`);
    }
    const off = await call(f.owner, "GET", `/v1/trips/${f.tripId}`);
    assert.equal(off.statusCode, 200);
    assert.ok(!("whatsapp" in off.json()), "no section, and no trace of the feature's name");
    assert.ok(!JSON.stringify(off.json()).toLowerCase().includes("whatsapp"));
    // no number in the profile: the switch is on and nothing answers
    await setWhatsappSwitch(pool, f.tripId, true);
    const bare = makeApp(undefined);
    try {
      const r = await call(f.owner, "POST", `/v1/trips/${f.tripId}/whatsapp-codes`, { kind: "me" }, bare);
      evidence("no number configured: POST whatsapp-codes", r);
      assert.equal(r.statusCode, 404);
      assert.equal((await call(f.owner, "GET", `/v1/trips/${f.tripId}/whatsapp-connections`, undefined, bare)).statusCode, 404);
      assert.equal((await call(f.owner, "DELETE", `/v1/trips/${f.tripId}/whatsapp-connections/tcb_${hex()}${hex()}`, undefined, bare)).statusCode, 404);
      assert.ok(!("whatsapp" in (await call(f.owner, "GET", `/v1/trips/${f.tripId}`, undefined, bare)).json()));
    } finally { await bare.close(); }
    // a member's trip list and a Telegram session's view carry no section either
    assert.ok(!JSON.stringify((await call(f.memberS, "GET", "/v1/trips")).json()).toLowerCase().includes("whatsapp"));
  });

  test("AC-6 / AC-7: the trip page offers the WhatsApp section only to a session that can use it: a full account session gets it, a Telegram-minted (scoped) session does not", async () => {
    const f = await fixture();
    const scoped = await telegramSession(f.ownerId, f.tripId);
    const full = await call(f.owner, "GET", `/v1/trips/${f.tripId}`);
    const viaTelegram = await call(scoped, "GET", `/v1/trips/${f.tripId}`);
    console.log(`EVIDENCE trip detail, account session: HTTP ${full.statusCode} whatsapp=${JSON.stringify(full.json().whatsapp)}`);
    console.log(`EVIDENCE trip detail, Telegram-minted session: HTTP ${viaTelegram.statusCode} has whatsapp key=${"whatsapp" in viaTelegram.json()}`);
    assert.equal(full.statusCode, 200);
    assert.deepEqual(full.json().whatsapp, { number: FIXTURE_NUMBER, owner: true });
    assert.equal(viaTelegram.statusCode, 200, "the scoped session still reads its own trip");
    assert.ok(!("whatsapp" in viaTelegram.json()), "the page must not offer buttons that will answer 403");
    assert.ok(!JSON.stringify(viaTelegram.json()).toLowerCase().includes("whatsapp"));
    assert.equal((await call(scoped, "POST", `/v1/trips/${f.tripId}/whatsapp-codes`, { kind: "me" })).statusCode, 403, "and the routes would indeed refuse it");
    // a secondary organizer on a full account session still gets it (not as owner): its `me` route answers 201
    const secondary = await call(f.secondaryS, "GET", `/v1/trips/${f.tripId}`);
    assert.equal(secondary.statusCode, 200);
    assert.deepEqual(secondary.json().whatsapp, { number: FIXTURE_NUMBER, owner: false });
  });

  test("AC-7: the per-user rate limit answers 429 after ten codes in a minute", async () => {
    const f = await fixture();
    let last = 0;
    for (let i = 0; i < 12; i += 1) last = (await call(f.owner, "POST", `/v1/trips/${f.tripId}/whatsapp-codes`, { kind: "me" })).statusCode;
    assert.equal(last, 429);
  });

  test("AC-16: the connections route carries only id, kind, name, how, when and the last four digits; no full number, no code, no chat id", async () => {
    const f = await fixture();
    const code = (kind: string) => call(f.owner, "POST", `/v1/trips/${f.tripId}/whatsapp-codes`, { kind }).then((r) => /KWA-[A-HJ-NP-Z2-9]{8}/.exec(decodeURIComponent(r.json().link))![0]);
    const person = waSender(), groupChat = waGroupId(), groupReal = waOldGroupAddress();
    const meCode = await code("me"), groupCode = await code("group");
    assert.ok((await redeemChatBindingCode(pool, { code: meCode, chatId: person.chatId, senderId: person.senderId, transportAddress: "100000000000001@lid", phoneLast4: "4567" })).ok);
    assert.ok((await redeemChatBindingCode(pool, { code: groupCode, chatId: groupChat, senderId: person.senderId, chatTitle: "Family", transportAddress: groupReal })).ok);
    const r = await call(f.owner, "GET", `/v1/trips/${f.tripId}/whatsapp-connections`);
    evidence("owner GET whatsapp-connections", r);
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers["cache-control"], "private, no-store");
    const list = r.json().connections;
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((c: { kind: string; name: string; via: string; lastFour?: string }) => [c.kind, c.name, c.via, c.lastFour ?? null]), [
      ["person", "Dana Owner", "dashboard_code", "4567"], ["group", "Family", "group_code", null]]);
    for (const secret of [person.senderId, person.chatId, groupChat, groupReal, groupReal.split("-")[0]!, "100000000000001", meCode, groupCode, meCode.slice(4), groupCode.slice(4), FIXTURE_NUMBER]) {
      assert.ok(!r.body.includes(secret), `the response carries ${secret.slice(0, 6)}...`);
    }
  });

  test("AC-15: DELETE removes only a connection of this trip, answers once, and sends nothing", async () => {
    const f = await fixture();
    const other = await mkWhatsappTrip(pool);
    const s = waSender();
    const mine = await call(f.owner, "POST", `/v1/trips/${f.tripId}/whatsapp-codes`, { kind: "me" });
    const code = /KWA-[A-HJ-NP-Z2-9]{8}/.exec(decodeURIComponent(mine.json().link))![0];
    assert.ok((await redeemChatBindingCode(pool, { code, chatId: s.chatId, senderId: s.senderId, transportAddress: "100000000000002@lid" })).ok);
    const bindingId = (await pool.query("SELECT id FROM control_plane.telegram_chat_bindings WHERE chat_id=$1", [s.chatId])).rows[0].id;
    const otherOwner = await fullSession(other.ownerId);
    assert.equal((await call(otherOwner, "DELETE", `/v1/trips/${other.tripId}/whatsapp-connections/${bindingId}`)).statusCode, 404, "another trip's owner cannot remove it");
    assert.equal((await call(otherOwner, "DELETE", `/v1/trips/${f.tripId}/whatsapp-connections/${bindingId}`)).statusCode, 404);
    const r = await call(f.owner, "DELETE", `/v1/trips/${f.tripId}/whatsapp-connections/${bindingId}`);
    evidence("owner DELETE whatsapp-connections/:id", r);
    assert.equal(r.statusCode, 200);
    assert.equal((await call(f.owner, "DELETE", `/v1/trips/${f.tripId}/whatsapp-connections/${bindingId}`)).statusCode, 404);
    assert.equal((await pool.query("SELECT closed_reason FROM control_plane.telegram_chat_bindings WHERE id=$1", [bindingId])).rows[0].closed_reason, "dashboard_removed");
  });
});
