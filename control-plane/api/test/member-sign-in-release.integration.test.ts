/**
 * A member's way into a trip ends, end to end: the control plane's real portal routes and the durable release, the REAL
 * `HttpRuntimeAccountAdapter`, the REAL runtime gateway (`control-plane/runtime-gateway/server.js`, as a child process) and the REAL trip
 * site (`server/server.js`, as a child process). Nothing between the organizer's click and the site's database is a stand-in; the
 * only fakes are Telegram (the harness's stand-in) and the model-free fixture trip.
 *
 *   (a) a GROUP CLAIM: claimed, the site exchange works; the organizer Releases it while the site is unreachable (the prompt attempt
 *       is lost, the record stays pending); the background pass lands it through the gateway; the record is done, a new site exchange
 *       for that account is refused and the token it held answers 401.
 *   (b) a PERSONAL INVITE: the organizer invites, the person redeems, their managed session is refused on `PUT /api/auth/password`, they
 *       connect an assistant (MCP); the organizer removes the member; the record is done, and the site token, the assistant's access
 *       token and its refresh token are dead, while the real traveller's own login and assistant (the same name, a plain password
 *       login) are untouched.
 *
 * The hand-run probes of the whole-branch verification, kept. No sleeps: the release pass is driven directly with a clock argument.
 * Needs the control-plane test database and installed `server/` and `mcp/` dependencies (the API job of the Control plane workflow has
 * both). The gateway has no dependencies.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { HttpRuntimeAccountAdapter } from "../src/portal.js";
import { runSiteReleasePass } from "../src/site-release-outbox.js";
import { api, startTestServer, stopTestServer } from "../../../tests/helpers/server.js";
import { freePort } from "../../../tests/helpers/port-guard.js";
import { ORIGIN, claim, initDataFor, launch, startHarness, tg, type Harness } from "./support/group-sign-in-harness.js";
import { seedTrip } from "./support/plan-change-site.js";
import { testDatabaseUrl } from "./support/test-database.js";

const skip = !testDatabaseUrl();
const KEY = "test-dedicated-exchange-key";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const REFUSAL = { error: "claimed_session_cannot_change_credentials" };
const gatewayJs = fileURLToPath(new URL("../../runtime-gateway/server.js", import.meta.url));
const siteSiteDir = fileURLToPath(new URL("../../../site", import.meta.url));

let h: Harness;
let temp: string;
let gateway: ChildProcess | undefined;
let controlPlane: ReturnType<Harness["newApp"]>;
let tripId: string;
let ownerId: string;
let ownerSession: { cookie: string; csrf: string };
let chatId: string;
let siteBase: string;
let real: HttpRuntimeAccountAdapter;
/** Where the release call goes: the real chain, or (to lose the prompt attempt) a door nobody is behind. */
let releaseVia: HttpRuntimeAccountAdapter;
const logs: string[] = [];

// ── the trip site, as the gateway talks to it ────────────────────────────────────────────────────────────────────────────
const siteInternal = (path: string, body: Record<string, unknown>) => api(`/api/internal/control-plane/${path}`, { method: "POST", apiKey: KEY, body: { tripId, ...body } });
const siteExchange = (userId: string, runtimeUsername: string | null, role = "member") => siteInternal("session", { userId, runtimeUsername, role });
const tokenOf = async (response: Response) => ((await response.json()) as { token: string }).token;
const siteMe = (token: string) => api("/api/auth/me", { token });
const sitePassword = (token: string, password: string) => api("/api/auth/password", { method: "PUT", token, body: { password } });
const siteLogin = (username: string, password: string) => api("/api/auth/login", { method: "POST", body: { username, password } });

// ── the assistant (MCP) connection flow, as an assistant's server would run it ──────────────────────────────────────────
const sha = (value: string) => createHash("sha256").update(value).digest("base64url");
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(siteBase + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const form = (path: string, body: Record<string, string>) => fetch(siteBase + path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
async function connect(session: string) {
  const registered = await post("/oauth/register", { client_name: "Claude", redirect_uris: [CALLBACK], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] });
  const client = (await registered.json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const decision = await post("/oauth/authorize/decision", {
    client_id: client.client_id, redirect_uri: CALLBACK, response_type: "code", code_challenge: sha(verifier), code_challenge_method: "S256", state: "s", resource: `${siteBase}/mcp`, decision: "allow",
  }, { origin: siteBase, authorization: `Bearer ${session}` });
  assert.equal(decision.status, 200, "consent");
  const code = new URL(((await decision.json()) as { redirect_to: string }).redirect_to).searchParams.get("code")!;
  const exchanged = await form("/oauth/token", { grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: CALLBACK });
  assert.equal(exchanged.status, 200, "token");
  return { client, tokens: (await exchanged.json()) as { access_token: string; refresh_token: string } };
}
const refreshWith = (client: { client_id: string }, refreshToken: string) => form("/oauth/token", { grant_type: "refresh_token", refresh_token: refreshToken, client_id: client.client_id });
const mcp = (accessToken: string) => fetch(`${siteBase}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${accessToken}` },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
});

// ── the control plane, as the organizer uses it ──────────────────────────────────────────────────────────────────────────
const ownerHeaders = () => ({ origin: ORIGIN, cookie: ownerSession.cookie, "x-csrf-token": ownerSession.csrf });
const outboxFor = async () => (await h.pool.query("SELECT user_id, runtime_username, invite_id, reason, state, outcome, attempts FROM control_plane.site_release_outbox WHERE trip_id = $1 ORDER BY id", [tripId])).rows as
  { user_id: string; runtime_username: string; invite_id: string | null; reason: string; state: string; outcome: string | null; attempts: number }[];
/** The background pass, once, through the real chain, on a clock an hour ahead (so nothing waits for a backoff). */
const runPass = () => runSiteReleasePass({ db: h.pool, releaser: real, log: (line) => logs.push(line), now: () => new Date(Date.now() + 3_600_000) });

before(async () => {
  if (skip) return;
  h = await startHarness();
  temp = mkdtempSync(join(tmpdir(), "member-sign-in-release-"));
  const [sitePort, gatewayPort, controlPlanePort] = [await freePort(), await freePort(), await freePort()];
  siteBase = `http://localhost:${sitePort}`;
  // The trip, with a ready route to the site (the gateway's route lookup answers from it).
  tripId = await seedTrip(h.pool, `integration-${randomBytes(4).toString("hex")}`, `http://localhost:${sitePort}`);
  ownerId = await h.mkUser("The Owner");
  await h.mkMember(tripId, ownerId, "owner");
  ownerSession = await h.webSession(ownerId, "owner");
  chatId = await h.bindGroup(tripId);
  await h.bindPrivate(tripId, tg());
  await h.switchOn(tripId);

  // The trip site: the fixture trip (alice the organizer, bob and eve), told who this trip is and who its owner is.
  const manifest = join(temp, "identity.json");
  writeFileSync(manifest, JSON.stringify({ version: 1, tripId, owner: { userId: ownerId, username: "alice" }, portalOrigin: ORIGIN }));
  await startTestServer({ PORT: sitePort, CONTROL_PLANE_EXCHANGE_KEY: KEY, CONTROL_PLANE_IDENTITY_FILE: manifest, SITE_DIR: siteSiteDir, TRIP_MCP_ENABLED: "1", PUBLIC_ORIGIN: siteBase });

  // The control plane's portal, listening, so the gateway can ask it which site a trip is on.
  real = new HttpRuntimeAccountAdapter(`http://127.0.0.1:${gatewayPort}`, KEY);
  releaseVia = real;
  controlPlane = h.newApp({
    runtimeExchangeKey: KEY, runtimeUpstreamHostSuffixes: ["localhost"], emailAuthLog: (line) => logs.push(line),
    runtimeAccounts: {
      participantExists: (input) => real.participantExists(input),
      listParticipants: (trip) => real.listParticipants(trip),
      provisionParticipant: (input) => real.provisionParticipant(input),
      adoptParticipant: (input) => real.adoptParticipant(input),
      releaseParticipant: (input) => releaseVia.releaseParticipant(input),
    },
  });
  await controlPlane.listen({ port: controlPlanePort, host: "127.0.0.1" });

  // The runtime gateway, as a child process (its configuration is read when it loads).
  gateway = spawn(process.execPath, [gatewayJs], {
    env: {
      ...process.env, NODE_ENV: "development", PORT: String(gatewayPort), BIND_HOST: "127.0.0.1",
      CONTROL_PLANE_INTERNAL_ORIGIN: `http://127.0.0.1:${controlPlanePort}`, RUNTIME_EXCHANGE_KEY: KEY, RUNTIME_COOKIE_SECRET: randomBytes(24).toString("hex"),
      PORTAL_ORIGIN: `http://localhost:${controlPlanePort}`, RUNTIME_ORIGIN: `http://localhost:${gatewayPort}`,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    gateway!.once("error", reject);
    gateway!.once("exit", (code) => reject(new Error(`the runtime gateway exited with ${code} before it was listening`)));
    gateway!.stdout!.on("data", (chunk: Buffer) => { if (chunk.toString().includes("Runtime gateway listening on")) resolve(); });
  });
  // The site seeds its users a moment after it listens: a login can arrive first and be refused. Ask until it is not.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await siteLogin("eve", "1234")).status === 200 && (await siteLogin("bob", "1234")).status === 200) return; } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the trip site never finished seeding its users");
});
after(async () => {
  if (skip) return;
  gateway?.kill("SIGTERM");
  stopTestServer();
  await controlPlane?.close();
  await h.stop();
  rmSync(temp, { recursive: true, force: true });
});

describe("a member's way in ends, through the real gateway and the real trip site", { skip }, () => {
  test("(a) a group claim: Release while the site is unreachable, then the pass lands it; the site exchange is refused and the old site token is dead", async () => {
    const person = tg();
    await h.telegram.member(chatId, person, "member");
    const offer = (await launch(controlPlane, initDataFor(person, { tripId }))).json() as { travellers: { claimId: string; name: string }[] };
    // the names come from the REAL site, through the gateway, and the organizer and the invited traveller are not among them
    assert.deepEqual(offer.travellers.map((t) => t.name).sort(), ["איב", "בוב"].sort());
    const claimed = await claim(controlPlane, initDataFor(person, { tripId }), tripId, offer.travellers.find((t) => t.name === "בוב")!.claimId);
    assert.equal(claimed.statusCode, 200, claimed.body);
    const claimRow = (await h.pool.query("SELECT id, user_id FROM control_plane.trip_participant_claims WHERE trip_id = $1 AND runtime_username = 'bob' AND released_at IS NULL", [tripId])).rows[0] as { id: string; user_id: string };

    // the site binds the claim: an exchange works and the token opens the trip
    const exchanged = await siteExchange(claimRow.user_id, "bob");
    assert.equal(exchanged.status, 200);
    const siteToken = await tokenOf(exchanged);
    assert.equal((await siteMe(siteToken)).status, 200, "the claimed member opens the trip");

    // the organizer Releases it; the prompt attempt goes to a door nobody is behind, so the record stays pending
    releaseVia = new HttpRuntimeAccountAdapter("http://127.0.0.1:1", KEY);
    const claimList = (await controlPlane.inject({ method: "GET", url: `/v1/trips/${tripId}/member-claims`, headers: { cookie: ownerSession.cookie } })).json() as { claims: { claimId: string }[] };
    const released = await controlPlane.inject({ method: "DELETE", url: `/v1/trips/${tripId}/member-claims/${claimList.claims[0]!.claimId}`, headers: ownerHeaders() });
    assert.equal(released.statusCode, 200, released.body);
    const pending = (await outboxFor()).filter((row) => row.user_id === claimRow.user_id);
    assert.deepEqual(pending.map((row) => [row.state, row.invite_id, row.attempts]), [["pending", null, 1]], "the lost prompt attempt left the release pending");
    assert.equal((await siteMe(siteToken)).status, 200, "and that is the window: the site still honours the token");

    // the pass, through the real adapter, gateway and site
    releaseVia = real;
    const result = await runPass();
    assert.equal(result.released >= 1, true, JSON.stringify(result));
    const landed = (await outboxFor()).filter((row) => row.user_id === claimRow.user_id);
    assert.deepEqual(landed.map((row) => [row.state, row.outcome]), [["done", "released"]]);
    assert.equal((await siteMe(siteToken)).status, 401, "the old site token is dead");
    const again = await siteExchange(claimRow.user_id, "bob");
    assert.notEqual(again.status, 200, "and the site will not mint another for that account");
    assert.ok(!(await again.text()).includes("token"));
    assert.equal((await siteLogin("bob", "1234")).status, 200, "the real traveller's own login is untouched");
  });

  test("(b) a personal invite: redeem, no site password, an assistant; the organizer removes the member: record done, site token, assistant and refresh dead; the real traveller's own login and assistant live", async () => {
    // R, the real traveller of 'eve': a plain login and an assistant connection approved the ordinary way, before any invite
    const rToken = ((await (await siteLogin("eve", "1234")).json()) as { token: string }).token;
    const r = await connect(rToken);
    assert.equal((await mcp(r.tokens.access_token)).status, 200);

    // the organizer invites (the name comes from the real site's list), the person redeems: the control plane asks the site, through the gateway
    const made = await controlPlane.inject({ method: "POST", url: `/v1/trips/${tripId}/site-invites`, headers: ownerHeaders(), payload: { runtimeUsername: "eve", displayName: "Eve" } });
    assert.equal(made.statusCode, 201, made.body);
    const { id: inviteId, joinUrl } = made.json() as { id: string; joinUrl: string };
    const redeemed = await controlPlane.inject({ method: "POST", url: "/v1/site-invites/redeem", payload: { token: new URL(joinUrl).hash.slice("#token=".length), method: "password", password: "a-long-enough-secret" } });
    assert.equal(redeemed.statusCode, 200, redeemed.body);
    const p = (await h.pool.query("SELECT redeemed_by FROM control_plane.site_invites WHERE id = $1", [inviteId])).rows[0].redeemed_by as string;

    // the invited person's managed site session: opens the trip, may NOT set a site password, may use the assistant
    const pToken = await tokenOf(await siteExchange(p, "eve"));
    assert.equal((await siteMe(pToken)).status, 200);
    const attempt = await sitePassword(pToken, "p-wants-a-direct-login");
    assert.equal(attempt.status, 403);
    assert.deepEqual(await attempt.json(), REFUSAL);
    assert.equal((await siteLogin("eve", "p-wants-a-direct-login")).status, 401, "no site login for the invited person exists");
    const pAssistant = await connect(pToken);
    assert.equal((await mcp(pAssistant.tokens.access_token)).status, 200, "the invited person's assistant works while they are a member");

    // the organizer removes the member: the control plane ends everything of its own, the record is written in the same transaction,
    // and the prompt attempt (the real chain) lands it
    const membership = (await h.pool.query("SELECT id FROM control_plane.trip_memberships WHERE trip_id = $1 AND user_id = $2", [tripId, p])).rows[0].id as string;
    const removed = await controlPlane.inject({ method: "DELETE", url: `/v1/trips/${tripId}/members/${membership}`, headers: ownerHeaders() });
    assert.equal(removed.statusCode, 200, removed.body);
    // the pass has nothing left to do for it: the prompt attempt already landed; running it must not disturb anything
    await runPass();
    const record = (await outboxFor()).filter((row) => row.user_id === p);
    assert.deepEqual(record.map((row) => [row.invite_id, row.reason, row.state, row.outcome]), [[inviteId, "invite_revoked", "done", "released"]]);

    assert.equal((await siteMe(pToken)).status, 401, "the invited person's site token is dead");
    assert.equal((await sitePassword(pToken, "too-late")).status, 401);
    assert.equal((await mcp(pAssistant.tokens.access_token)).status, 401, "their assistant's access token is dead");
    assert.equal((await refreshWith(pAssistant.client, pAssistant.tokens.refresh_token)).status, 400, "and its refresh token is refused");
    assert.notEqual((await siteExchange(p, "eve")).status, 200, "the site mints nothing more for that account");

    // R is untouched
    assert.equal((await siteLogin("eve", "1234")).status, 200, "the real traveller still logs in with their own password");
    assert.equal((await mcp(r.tokens.access_token)).status, 200, "their assistant still works");
    assert.equal((await refreshWith(r.client, r.tokens.refresh_token)).status, 200, "and its refresh still works");
  });
});
