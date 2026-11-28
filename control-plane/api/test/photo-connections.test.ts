/**
 * A user's photo-library connection (#699, docs/specs/sprint-9/699-user-photo-library.md, slice S1a): AC-1, AC-2, AC-3,
 * AC-5, AC-6 (the Immich half) and AC-19, through the portal's own session and CSRF handling, against a stand-in Immich
 * on a loopback port chosen at runtime (named in the deployment allow-list the way a home Immich would be). AC-4 has its
 * own suite (photo-library-address-guard.test.ts); here it is proved at the route: refused, and nothing stored.
 *
 * The stand-in is ADVERSARIAL about the key: it echoes whatever `x-api-key` it receives into its body and its headers,
 * so a route that passed a library's text or headers through would leak the key, and the scan would see it.
 *
 * DB-backed, like portal-db.test.ts: point CONTROL_PLANE_TEST_DATABASE_URL at your own `cptest_<name>` database.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { photoLibraryPortalSettings, validateArchitectureProfile } from "../src/config.js";
import { applyMigrations } from "../src/migrations.js";
import { credentialKeyFromSecret, credentialKeyId, decryptCredential, encryptCredential } from "../src/photo-credentials.js";
import { createImmichAdapter, PhotoLibraryNotImplementedError, type PhotoLibrarySettings } from "../src/photo-library.js";
import { sha256, type PortalDependencies } from "../src/portal.js";
import { structuredLog } from "../src/redaction.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const skip = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const ORIGIN = "http://portal.example.test";
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ids = { alice: `user_${suffix}a`, bob: `user_${suffix}b`, carol: `user_${suffix}c` };

const KEY_ENV = "KINERARY_TEST_PHOTO_CREDENTIAL_KEY";
const KEY_REF = `env://${KEY_ENV}`;
const sealingKey = randomBytes(32);
process.env[KEY_ENV] = sealingKey.toString("base64");

// The Immich keys the person types. Every one of them is a secret the scan looks for.
const GOOD = `immich-good-${randomBytes(16).toString("hex")}`;
const GOOD_2 = `immich-second-${randomBytes(16).toString("hex")}`;
const NO_PERMISSION = `immich-noperm-${randomBytes(16).toString("hex")}`;
const WRONG = `immich-wrong-${randomBytes(16).toString("hex")}`;
const SECRETS = [GOOD, GOOD_2, NO_PERMISSION, WRONG];
function secretForms(secret: string): string[] {
  const bytes = Buffer.from(secret, "utf8");
  return [secret, encodeURIComponent(secret), bytes.toString("base64"), bytes.toString("base64url"), bytes.toString("hex")];
}
function assertNoSecret(text: string, where: string): void {
  for (const secret of SECRETS) for (const form of secretForms(secret)) assert.ok(!text.includes(form), `${where} holds a test key (${form.slice(0, 18)}...)`);
}

// ── the stand-in Immich ───────────────────────────────────────────────────────────────────────────────────────────────

interface Hit { method: string; path: string; key: string | undefined }
const immichHits: Hit[] = [];
const validKeys = new Set([GOOD, GOOD_2]);
let immich: Server;
let immichUrl = "";
let notImmich: Server;
let notImmichUrl = "";
let closedUrl = "";

/** A key whose albums answer the stand-in holds back, to put a reconnect in the middle of a check. */
let slowKey: string | undefined;
function immichHandler(request: IncomingMessage, response: ServerResponse): void {
  const key = typeof request.headers["x-api-key"] === "string" ? request.headers["x-api-key"] : undefined;
  if (key !== undefined && key === slowKey && request.url === "/api/albums") { slowKey = undefined; setTimeout(() => immichHandler(request, response), 400); return; }
  immichHits.push({ method: request.method ?? "", path: request.url ?? "", key });
  const echo = { "x-echo-key": key ?? "", "content-type": "application/json" };
  if (request.url === "/api/server/ping") { response.writeHead(200, echo); response.end(JSON.stringify({ res: "pong" })); return; }
  if (request.url === "/api/albums" && request.method === "GET") {
    if (key && validKeys.has(key)) { response.writeHead(200, echo); response.end(JSON.stringify([{ id: "a1", albumName: `album for ${key}` }])); return; }
    if (key === NO_PERMISSION) {
      response.writeHead(403, echo);
      response.end(JSON.stringify({ message: "Missing required permission: album.read", error: "Forbidden", statusCode: 403, correlationId: key }));
      return;
    }
    response.writeHead(401, { ...echo, location: `http://example.test/?key=${key}` });
    response.end(JSON.stringify({ message: `Invalid API key: ${key}`, error: "Unauthorized", statusCode: 401 }));
    return;
  }
  response.writeHead(404, echo);
  response.end(JSON.stringify({ message: `Cannot ${request.method} ${request.url} with ${key}` }));
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// ── the portal ────────────────────────────────────────────────────────────────────────────────────────────────────────

let pool: pg.Pool;
const logLines: string[] = [];
const profile = validateArchitectureProfile({
  version: 1, environment: "test", public_api: { bind_host: "127.0.0.1", port: 4310 },
  worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4311 },
  database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
  adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" },
  test_resources: { enabled: false },
});

function settings(overrides: Partial<PhotoLibrarySettings> = {}): PhotoLibrarySettings {
  return { credentialKeySecretRef: KEY_REF, allowedPrivateHosts: ["127.0.0.1"], timeoutMs: 2000, log: (line) => { logLines.push(line); }, ...overrides };
}

function portalDeps(photoLibrary: PhotoLibrarySettings | undefined): PortalDependencies {
  return {
    db: pool,
    runtimeAccounts: { participantExists: async () => true, provisionParticipant: async () => {} },
    publicOrigin: ORIGIN, runtimeOrigin: "http://runtime.example.test", runtimeExchangeKey: "exchange-key",
    runtimeUpstreamHostSuffixes: ["internal"], telegramBotUsername: "kinerary_bot", sessionTtlSeconds: 3600,
    enrollmentTtlSeconds: 3600, approvalTtlSeconds: 3600, emailAuthLog: (line) => { logLines.push(line); },
    ...(photoLibrary ? { photoLibrary } : {}),
  };
}

const sessions: Record<string, { cookie: string; csrf: string }> = {};
async function session(userId: string, label: string) {
  const raw = `session-${label}-${suffix}`, csrf = `csrf-${label}-${suffix}`;
  await pool.query(
    `INSERT INTO control_plane.web_sessions(id, user_id, token_digest, csrf_digest, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
    [`wsess_${suffix}${label}`, userId, sha256(raw), sha256(csrf)]);
  return { cookie: `kit_session=${raw}; kit_csrf=${csrf}`, csrf };
}

/** Every response any test saw, headers and body, for the scan at the end. */
const seen: string[] = [];
type App = ReturnType<typeof buildApp>;
async function call(app: App, who: string | null, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: Record<string, unknown>) {
  const s = who ? sessions[who] : undefined;
  const headers: Record<string, string> = { origin: ORIGIN };
  if (s) { headers.cookie = s.cookie; headers["x-csrf-token"] = s.csrf; }
  const response = await app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  seen.push(`${method} ${url} -> ${response.statusCode} ${JSON.stringify(response.headers)} ${response.body}`);
  return response;
}

const rowsOf = async (userId: string) => (await pool.query(
  "SELECT * FROM control_plane.photo_connections WHERE user_id = $1 ORDER BY created_at, id", [userId])).rows;

before(async () => {
  immich = createServer(immichHandler);
  immichUrl = await listen(immich);
  notImmich = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html", "x-echo-key": String(request.headers["x-api-key"] ?? "") });
    response.end(`<html>a router login page ${String(request.headers["x-api-key"] ?? "")}</html>`);
  });
  notImmichUrl = await listen(notImmich);
  const closed = createNetServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  closedUrl = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  if (skip) return;
  pool = testPool({ max: 4 });
  const client = await pool.connect();
  try { await applyMigrations(client, migrationsDir); } finally { client.release(); }
  await pool.query("INSERT INTO control_plane.users(id,status,display_name) VALUES ($1,'active','Alice'),($2,'active','Bob'),($3,'active','Carol')",
    [ids.alice, ids.bob, ids.carol]);
  sessions.alice = await session(ids.alice, "alice");
  sessions.bob = await session(ids.bob, "bob");
  sessions.carol = await session(ids.carol, "carol");
});

beforeEach(async () => {
  immichHits.length = 0;
  validKeys.clear(); validKeys.add(GOOD); validKeys.add(GOOD_2);
  if (!skip) await pool.query("DELETE FROM control_plane.photo_connections WHERE user_id = ANY($1)", [Object.values(ids)]);
});

after(async () => {
  for (const server of [immich, notImmich]) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  if (skip) return;
  await pool.query("DELETE FROM control_plane.photo_connections WHERE user_id = ANY($1)", [Object.values(ids)]);
  await pool.query("DELETE FROM control_plane.web_sessions WHERE user_id = ANY($1)", [Object.values(ids)]);
  await pool.query("DELETE FROM control_plane.users WHERE id = ANY($1)", [Object.values(ids)]);
  await pool.end();
});

const connect = (app: App, who: string, apiKey: string, serverUrl = immichUrl, extra: Record<string, unknown> = {}) =>
  call(app, who, "POST", "/v1/photo-connections/immich", { serverUrl, apiKey, ...extra });

// ── not configured ────────────────────────────────────────────────────────────────────────────────────────────────────

test("without photo_library.credential_key_secret_ref every route answers 503 photo_library_not_configured and stores nothing", { skip }, async () => {
  const app = buildApp(profile, { portal: portalDeps(undefined) });
  try {
    const body = { error: "photo_library_not_configured", message: "Photo libraries are not set up on this Kinerary yet." };
    for (const [method, url] of [["GET", "/v1/photo-connections"], ["POST", "/v1/photo-connections/immich"], ["POST", "/v1/photo-connections/phc_abcdefgh/test"],
      ["PUT", "/v1/photo-connections/phc_abcdefgh/default"], ["DELETE", "/v1/photo-connections/phc_abcdefgh"]] as const) {
      const response = await call(app, "alice", method, url, method === "POST" ? { serverUrl: immichUrl, apiKey: GOOD } : undefined);
      assert.deepEqual([response.statusCode, response.json()], [503, body], `${method} ${url}`);
    }
    assert.deepEqual(await rowsOf(ids.alice), []);
    assert.deepEqual(immichHits, [], "the library was never contacted");
  } finally { await app.close(); }
  // A reference that does not resolve, or a key that is not 32 bytes: the same 503, nothing contacted, nothing stored, and a log line.
  for (const broken of [settings({ credentialKeySecretRef: "env://KINERARY_TEST_PHOTO_KEY_UNSET" }), settings({ resolveSecret: async () => "dG9vIHNob3J0" })]) {
    const app2 = buildApp(profile, { portal: portalDeps(broken) });
    try {
      logLines.length = 0;
      const response = await connect(app2, "alice", GOOD);
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error, "photo_library_not_configured");
      assert.ok(logLines.some((line) => line.includes("photo_library.credential_key_unavailable")), "the operator is told why");
      assert.deepEqual(await rowsOf(ids.alice), []);
      assert.deepEqual(immichHits, []);
    } finally { await app2.close(); }
  }
});

// ── AC-1 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("AC-1: a valid address and key make an active connection, the key sealed, and the list shows it", { skip }, async () => {
  const app = buildApp(profile, { portal: portalDeps(settings()) });
  try {
    const response = await connect(app, "alice", GOOD, `${immichUrl}/`, { publicUrl: "https://photos.example.test/" });
    assert.equal(response.statusCode, 201);
    const { connection } = response.json();
    assert.match(connection.id, /^phc_[0-9a-f]{32}$/);
    assert.deepEqual(Object.keys(connection).sort(), ["id", "isDefault", "lastCheckedAt", "lastErrorCode", "publicUrl", "serverUrl", "service", "state"]);
    assert.deepEqual({ ...connection, id: "x", lastCheckedAt: typeof connection.lastCheckedAt }, {
      id: "x", service: "immich", serverUrl: immichUrl, publicUrl: "https://photos.example.test", state: "active", isDefault: true,
      lastCheckedAt: "string", lastErrorCode: null,
    });
    // Ping without a key, then the albums with it, in the header and nowhere else.
    assert.deepEqual(immichHits, [{ method: "GET", path: "/api/server/ping", key: undefined }, { method: "GET", path: "/api/albums", key: GOOD }]);
    const [row] = await rowsOf(ids.alice);
    assert.equal(row.status, "active");
    assert.equal(row.credential_key_id, credentialKeyId(sealingKey));
    assertNoSecret(JSON.stringify(row), "the stored row");
    const listed = await call(app, "alice", "GET", "/v1/photo-connections");
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.json(), { connections: [connection] });
  } finally { await app.close(); }
});

test("AC-1: a wrong key, a key without album.read, an address that is not Immich, and one that does not answer each store nothing and say which", { skip }, async () => {
  const app = buildApp(profile, { portal: portalDeps(settings()) });
  try {
    const wrong = await connect(app, "alice", WRONG);
    assert.deepEqual([wrong.statusCode, wrong.json()], [422, { error: "invalid_key", message: "Immich did not accept that API key." }]);
    const noPermission = await connect(app, "alice", NO_PERMISSION);
    assert.deepEqual([noPermission.statusCode, noPermission.json()],
      [422, { error: "key_lacks_permission", message: "The API key works, but lacks a permission Kinerary needs.", permission: "album.read" }]);
    const notImmichAnswer = await connect(app, "alice", GOOD, notImmichUrl);
    assert.deepEqual([notImmichAnswer.statusCode, notImmichAnswer.json().error], [422, "not_immich"]);
    const unreachable = await connect(app, "alice", GOOD, closedUrl);
    assert.deepEqual([unreachable.statusCode, unreachable.json().error], [502, "unreachable"]);
    // An API key is base64url, as Immich issues them: anything else is refused before it is used or could be logged.
    for (const shape of ["two words\r\nx-injected: 1", "abc,def", "abc;def", "abc}def", "abc'def", 'abc"def', "abc=", "abc+/", "a".repeat(513), ""]) {
      const badKey = await connect(app, "alice", shape);
      assert.deepEqual([badKey.statusCode, badKey.json().error], [400, "invalid_request"], JSON.stringify(shape.slice(0, 20)));
    }
    const badPublic = await connect(app, "alice", GOOD, immichUrl, { publicUrl: "javascript:alert(1)" });
    assert.deepEqual([badPublic.statusCode, badPublic.json().error, badPublic.json().field], [400, "invalid_address", "publicUrl"]);
    assert.deepEqual(await rowsOf(ids.alice), []);
  } finally { await app.close(); }
});

test("AC-1 / AC-4 at the route: the metadata address, loopback without the allow-list, a private name and a non-http scheme are refused before any request, and nothing is stored", { skip }, async () => {
  const app = buildApp(profile, { portal: portalDeps(settings({ allowedPrivateHosts: [], resolveHost: async () => [{ address: "10.20.30.40", family: 4 }] })) });
  try {
    const port = new URL(immichUrl).port;
    for (const [serverUrl, code, status] of [
      ["http://169.254.169.254/latest/meta-data", "address_not_allowed", 400], [immichUrl, "address_not_allowed", 400],
      [`http://[::ffff:127.0.0.1]:${port}`, "address_not_allowed", 400], [`http://localhost:${port}`, "address_not_allowed", 400],
      [`http://immich.lan.test:${port}`, "address_not_allowed", 400],
      ["ftp://photos.example.test/", "invalid_address", 400], ["file:///etc/passwd", "invalid_address", 400],
      [`http://user:pass@127.0.0.1:${port}`, "invalid_address", 400],
    ] as const) {
      const response = await connect(app, "alice", GOOD, serverUrl);
      assert.deepEqual([response.statusCode, response.json().error], [status, code], serverUrl);
    }
    assert.deepEqual(immichHits, [], "the stand-in was never contacted");
    assert.deepEqual(await rowsOf(ids.alice), []);
  } finally { await app.close(); }
});

test("a second connect replaces the Immich connection in place: same id, re-sealed, active again", { skip }, async () => {
  const app = buildApp(profile, { portal: portalDeps(settings()) });
  try {
    const first = (await connect(app, "alice", GOOD)).json().connection;
    const [before] = await rowsOf(ids.alice);
    await pool.query("UPDATE control_plane.photo_connections SET status = 'needs_reconnect', last_error_code = 'invalid_key' WHERE id = $1", [first.id]);
    const second = await connect(app, "alice", GOOD_2);
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().connection.id, first.id);
    assert.equal(second.json().connection.state, "active");
    assert.equal(second.json().connection.lastErrorCode, null);
    const rows = await rowsOf(ids.alice);
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].credential_ct, before.credential_ct);
    const key = credentialKeyFromSecret(sealingKey.toString("base64"));
    assert.equal(decryptCredential(key, { ciphertext: rows[0].credential_ct, keyId: rows[0].credential_key_id }, { connectionId: first.id, userId: ids.alice }), GOOD_2);
    // A failed reconnect leaves the stored connection exactly as it was.
    const failed = await connect(app, "alice", WRONG);
    assert.equal(failed.statusCode, 422);
    assert.deepEqual((await rowsOf(ids.alice))[0].credential_ct, rows[0].credential_ct);
  } finally { await app.close(); }
});

// ── AC-2 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

async function insertGooglePhotosRow(userId: string, isDefault: boolean): Promise<string> {
  const id = `phc_${randomBytes(16).toString("hex")}`;
  const key = credentialKeyFromSecret(sealingKey.toString("base64"));
  const sealed = encryptCredential(key, `google-refresh-${randomBytes(8).toString("hex")}`, { connectionId: id, userId });
  await pool.query(
    `INSERT INTO control_plane.photo_connections(id, user_id, provider, credential_ct, credential_key_id, status, is_default, created_at)
     VALUES ($1, $2, 'google_photos', $3, $4, 'active', $5, now() - interval '1 day')`, [id, userId, sealed.ciphertext, sealed.keyId, isDefault]);
  return id;
}

test("AC-2: none, one is the default, two have exactly one; the user moves it; disconnecting the default makes the other the default", { skip }, async () => {
  const app = buildApp(profile, { portal: portalDeps(settings()) });
  const defaults = async () => (await pool.query("SELECT id FROM control_plane.photo_connections WHERE user_id = $1 AND is_default", [ids.alice])).rows.map((r) => r.id);
  try {
    assert.deepEqual((await call(app, "alice", "GET", "/v1/photo-connections")).json(), { connections: [] }, "none: nothing is a default");
    const immichId = (await connect(app, "alice", GOOD)).json().connection.id;
    assert.deepEqual(await defaults(), [immichId], "one connection is the default");
    const googleId = await insertGooglePhotosRow(ids.alice, false);
    assert.deepEqual(await defaults(), [immichId], "a second connection does not take the default");
    const moved = await call(app, "alice", "PUT", `/v1/photo-connections/${googleId}/default`);
    assert.equal(moved.statusCode, 200);
    assert.equal(moved.json().connection.isDefault, true);
    assert.deepEqual(await defaults(), [googleId], "exactly one default after the move");
    const listed = (await call(app, "alice", "GET", "/v1/photo-connections")).json().connections;
    assert.deepEqual(listed.map((c: { id: string; isDefault: boolean }) => [c.id, c.isDefault]), [[googleId, true], [immichId, false]]);
    // Setting the default that already is one changes nothing.
    assert.equal((await call(app, "alice", "PUT", `/v1/photo-connections/${googleId}/default`)).statusCode, 200);
    assert.deepEqual(await defaults(), [googleId]);
    const gone = await call(app, "alice", "DELETE", `/v1/photo-connections/${googleId}`);
    assert.equal(gone.statusCode, 200);
    assert.deepEqual(gone.json().connections.map((c: { id: string; isDefault: boolean }) => [c.id, c.isDefault]), [[immichId, true]]);
    assert.deepEqual(await defaults(), [immichId], "the other one is the default now");
    // The database itself refuses a second default.
    await assert.rejects(pool.query("INSERT INTO control_plane.photo_connections(id,user_id,provider,credential_ct,credential_key_id,is_default) VALUES ($1,$2,'google_photos','x','k_0123456789abcdef',true)",
      [`phc_${randomBytes(8).toString("hex")}`, ids.alice]), /photo_connections_one_default_per_user/);
  } finally { await app.close(); }
});

// ── AC-3 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("AC-3: the credential is sealed with AES-256-GCM, a fresh nonce, the key id recorded, and bound to its row and user", () => {
  const key = credentialKeyFromSecret(sealingKey.toString("base64"));
  assert.equal(key.id, credentialKeyId(sealingKey));
  assert.match(key.id, /^k_[0-9a-f]{16}$/);
  const binding = { connectionId: "phc_abcdefgh12", userId: "user_abcdefgh" };
  const one = encryptCredential(key, GOOD, binding);
  const two = encryptCredential(key, GOOD, binding);
  assert.notEqual(one.ciphertext, two.ciphertext, "a fresh nonce every time");
  assert.equal(one.keyId, key.id);
  assertNoSecret(JSON.stringify([one, two]), "the sealed credential");
  assert.equal(decryptCredential(key, one, binding), GOOD);
  // Copied to another row or another user, it does not open.
  assert.throws(() => decryptCredential(key, one, { ...binding, connectionId: "phc_otherrow12" }), (e: unknown) => (e as { code?: string }).code === "credential_unreadable");
  assert.throws(() => decryptCredential(key, one, { ...binding, userId: "user_someone1" }), (e: unknown) => (e as { code?: string }).code === "credential_unreadable");
  // The key id is authenticated too: relabelling the row does not make another key open it.
  const other = credentialKeyFromSecret(randomBytes(32).toString("base64url"));
  assert.throws(() => decryptCredential(other, one, binding), (e: unknown) => (e as { code?: string }).code === "credential_key_rotated");
  assert.throws(() => decryptCredential(other, { ...one, keyId: other.id }, binding), (e: unknown) => (e as { code?: string }).code === "credential_unreadable");
  // Anything but 32 bytes of base64 is refused, and the error does not quote it.
  for (const bad of ["", "short", randomBytes(16).toString("base64"), randomBytes(33).toString("base64"), "not base64 at all!!!!!!!!!!!!!!!!!!!!!!!!!!!"]) {
    assert.throws(() => credentialKeyFromSecret(bad), (e: unknown) => (e as { code?: string }).code === "credential_key_invalid" && (!bad || !(e as Error).message.includes(bad)));
  }
});

test("AC-3: a row sealed under a key that is no longer configured reads needs_reconnect, credential_key_rotated, and the library is not called", { skip }, async () => {
  const app = buildApp(profile, { portal: portalDeps(settings()) });
  const rotated = randomBytes(32).toString("base64");
  const app2 = buildApp(profile, { portal: portalDeps(settings({ resolveSecret: async () => rotated })) });
  try {
    const id = (await connect(app, "alice", GOOD)).json().connection.id;
    immichHits.length = 0;
    const tested = await call(app2, "alice", "POST", `/v1/photo-connections/${id}/test`);
    assert.equal(tested.statusCode, 200);
    assert.deepEqual(tested.json().check, { ok: false, error: "credential_key_rotated" });
    assert.equal(tested.json().connection.state, "needs_reconnect");
    assert.equal(tested.json().connection.lastErrorCode, "credential_key_rotated");
    assert.deepEqual(immichHits, []);
  } finally { await app.close(); await app2.close(); }
});

test("redaction: credential field names and an x-api-key quoted in text never reach a log line", () => {
  const line = structuredLog("warn", "photo_library.example", {
    credential_ct: "SEALED-VALUE", credential_key_id: "k_0123456789abcdef", apiKey: GOOD, "x-api-key": GOOD_2,
    detail: `request failed with headers x-api-key: ${WRONG} and {"x-api-key":"${NO_PERMISSION}"}`,
  });
  assertNoSecret(line, "the log line");
  assert.doesNotMatch(line, /SEALED-VALUE/);
});

// ── AC-5 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("AC-5: disconnecting deletes the stored credential and never calls the library", { skip }, async () => {
  const app = buildApp(profile, { portal: portalDeps(settings()) });
  try {
    const id = (await connect(app, "alice", GOOD)).json().connection.id;
    immichHits.length = 0;
    const gone = await call(app, "alice", "DELETE", `/v1/photo-connections/${id}`);
    assert.deepEqual([gone.statusCode, gone.json()], [200, { disconnected: true, connections: [] }]);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM control_plane.photo_connections WHERE id = $1", [id])).rows[0].n, 0);
    assert.deepEqual(immichHits, [], "nothing in the library is touched");
    assert.equal((await call(app, "alice", "DELETE", `/v1/photo-connections/${id}`)).statusCode, 404);
  } finally { await app.close(); }
});

// ── AC-6 (Immich) ─────────────────────────────────────────────────────────────────────────────────────────────────────

test("AC-6: a 401 or 403 from Immich makes the connection needs_reconnect after ONE call; a network failure leaves the state", { skip }, async () => {
  const app = buildApp(profile, { portal: portalDeps(settings()) });
  try {
    const id = (await connect(app, "alice", GOOD)).json().connection.id;
    // The key is revoked in Immich.
    validKeys.delete(GOOD);
    immichHits.length = 0;
    const revoked = await call(app, "alice", "POST", `/v1/photo-connections/${id}/test`);
    assert.equal(revoked.statusCode, 200);
    assert.equal(revoked.json().connection.state, "needs_reconnect");
    assert.equal(revoked.json().check.error, "invalid_key");
    assert.equal(immichHits.filter((hit) => hit.path === "/api/albums").length, 1, "exactly one authenticated call: no retry loop");
    const listed = (await call(app, "alice", "GET", "/v1/photo-connections")).json().connections[0];
    assert.deepEqual([listed.state, listed.lastErrorCode], ["needs_reconnect", "invalid_key"], "the dashboard's list says so");
    // Nothing retries it in the background either.
    immichHits.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(immichHits, []);
    // A working key again: the test brings it back.
    validKeys.add(GOOD);
    assert.equal((await call(app, "alice", "POST", `/v1/photo-connections/${id}/test`)).json().connection.state, "active");

    // A 403 (the key lost album.read) is the same.
    const bobId = (await connect(app, "bob", GOOD_2)).json().connection.id;
    validKeys.delete(GOOD_2);
    const forbiddenServer = createServer((request, response) => {
      immichHits.push({ method: request.method ?? "", path: request.url ?? "", key: String(request.headers["x-api-key"] ?? "") });
      if (request.url === "/api/server/ping") { response.end(JSON.stringify({ res: "pong" })); return; }
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "Missing required permission: album.read" }));
    });
    const forbiddenUrl = await listen(forbiddenServer);
    try {
      await pool.query("UPDATE control_plane.photo_connections SET server_url = $2 WHERE id = $1", [bobId, forbiddenUrl]);
      immichHits.length = 0;
      const forbidden = await call(app, "bob", "POST", `/v1/photo-connections/${bobId}/test`);
      assert.deepEqual([forbidden.json().connection.state, forbidden.json().check.error, forbidden.json().check.permission], ["needs_reconnect", "key_lacks_permission", "album.read"]);
      assert.equal(immichHits.filter((hit) => hit.path === "/api/albums").length, 1);
    } finally { forbiddenServer.closeAllConnections(); await new Promise<void>((resolve) => forbiddenServer.close(() => resolve())); }

    // The library is down: recorded, and the state is left alone (it is not the key's fault).
    validKeys.add(GOOD);
    await pool.query("UPDATE control_plane.photo_connections SET server_url = $2 WHERE id = $1", [id, closedUrl]);
    const down = await call(app, "alice", "POST", `/v1/photo-connections/${id}/test`);
    assert.deepEqual([down.json().connection.state, down.json().connection.lastErrorCode], ["active", "unreachable"]);
  } finally { await app.close(); }
});

test("a check that was running when the user reconnected does not overwrite the new connection with the old key's verdict", { skip }, async () => {
  const app = buildApp(profile, { portal: portalDeps(settings()) });
  try {
    const id = (await connect(app, "alice", GOOD)).json().connection.id;
    validKeys.delete(GOOD);
    slowKey = GOOD;
    const running = call(app, "alice", "POST", `/v1/photo-connections/${id}/test`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal((await connect(app, "alice", GOOD_2)).statusCode, 200, "the reconnect lands while the old key is being checked");
    const stale = await running;
    assert.equal(stale.json().check.error, "invalid_key", "the old key was refused");
    assert.deepEqual([stale.json().connection.state, stale.json().connection.lastErrorCode], ["active", null], "and the answer shows the row as it now is");
    const [row] = await rowsOf(ids.alice);
    assert.deepEqual([row.status, row.last_error_code], ["active", null], "the new key's connection was not marked needs_reconnect");
  } finally { slowKey = undefined; await app.close(); }
});

test("AC-4 at the route: a lookup that never answers is a 502 timeout within the deadline, and nothing is stored", { skip }, async () => {
  const app = buildApp(profile, { portal: portalDeps(settings({ allowedPrivateHosts: [], timeoutMs: 500, resolveHost: () => new Promise(() => { /* never */ }) })) });
  try {
    const started = Date.now();
    const response = await connect(app, "alice", GOOD, "https://immich.slow-dns.example.test");
    const took = Date.now() - started;
    assert.deepEqual([response.statusCode, response.json().error], [502, "timeout"]);
    assert.ok(took < 1500, `answered after ${took} ms, the deadline was 500`);
    assert.deepEqual(await rowsOf(ids.alice), []);
  } finally { await app.close(); }
});

// ── AC-19 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("AC-19: another account's connection id answers 404 on every route, byte for byte like an unknown id, and changes nothing", { skip }, async () => {
  const app = buildApp(profile, { portal: portalDeps(settings()) });
  try {
    const aliceId = (await connect(app, "alice", GOOD)).json().connection.id;
    const before = await rowsOf(ids.alice);
    immichHits.length = 0;
    const unknown = `phc_${randomBytes(16).toString("hex")}`;
    for (const [method, path] of [["POST", "/test"], ["PUT", "/default"], ["DELETE", ""]] as const) {
      const theirs = await call(app, "bob", method, `/v1/photo-connections/${aliceId}${path}`);
      const nobodys = await call(app, "bob", method, `/v1/photo-connections/${unknown}${path}`);
      const malformed = await call(app, "bob", method, `/v1/photo-connections/not-an-id${path}`);
      assert.equal(theirs.statusCode, 404, `${method} ${path}`);
      assert.equal(theirs.body, '{"error":"NOT_FOUND"}');
      assert.equal(theirs.body, nobodys.body);
      assert.equal(malformed.body, nobodys.body);
    }
    const bobList = await call(app, "bob", "GET", "/v1/photo-connections");
    assert.deepEqual(bobList.json(), { connections: [] }, "the list is the session's own");
    assert.deepEqual(await rowsOf(ids.alice), before, "Alice's connection is untouched");
    assert.deepEqual(immichHits, [], "Bob's requests never reached Alice's library");
    // No session, and a mutation without CSRF or from another origin, are refused before anything is looked at.
    assert.equal((await call(app, null, "GET", "/v1/photo-connections")).statusCode, 401);
    const noCsrf = await app.inject({ method: "DELETE", url: `/v1/photo-connections/${aliceId}`, headers: { cookie: sessions.alice!.cookie, origin: ORIGIN } });
    assert.equal(noCsrf.statusCode, 403);
    const foreign = await app.inject({ method: "DELETE", url: `/v1/photo-connections/${aliceId}`, headers: { cookie: sessions.alice!.cookie, "x-csrf-token": sessions.alice!.csrf, origin: "https://evil.example.test" } });
    assert.equal(foreign.statusCode, 403);
    assert.equal((await rowsOf(ids.alice)).length, 1);
  } finally { await app.close(); }
});

// ── AC-3: the scan ────────────────────────────────────────────────────────────────────────────────────────────────────

test("AC-3: no test key appears in any response, log line, error text, stderr or stored column, across success, wrong key, unreachable and refused", { skip }, async () => {
  const app = buildApp(profile, { portal: portalDeps(settings()) });
  const stderr: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => { stderr.push(String(chunk)); return (realWrite as (...a: unknown[]) => boolean)(chunk, ...rest); }) as typeof process.stderr.write;
  // A second app that logs to stderr (no injected sink), so the default path is scanned too.
  const stderrApp = buildApp(profile, { portal: portalDeps(settings({ log: undefined })) });
  try {
    for (const target of [app, stderrApp]) {
      await connect(target, "carol", WRONG);
      await connect(target, "carol", NO_PERMISSION);
      await connect(target, "carol", GOOD, notImmichUrl);
      await connect(target, "carol", GOOD, closedUrl);
      await connect(target, "carol", GOOD, "http://169.254.169.254/");
      const id = (await connect(target, "carol", GOOD)).json().connection.id;
      await connect(target, "carol", GOOD_2);
      await call(target, "carol", "GET", "/v1/photo-connections");
      validKeys.delete(GOOD_2);
      await call(target, "carol", "POST", `/v1/photo-connections/${id}/test`);
      validKeys.add(GOOD_2);
      await call(target, "carol", "PUT", `/v1/photo-connections/${id}/default`);
      await call(target, "bob", "POST", `/v1/photo-connections/${id}/test`);
      for (const row of await rowsOf(ids.carol)) assertNoSecret(JSON.stringify(row), "a stored row");
      await call(target, "carol", "DELETE", `/v1/photo-connections/${id}`);
    }
    // Errors the adapter's unimplemented methods throw, and what a refused check returns.
    const adapter = createImmichAdapter({ serverUrl: immichUrl, apiKey: GOOD, guard: { allowedPrivateHosts: ["127.0.0.1"] } });
    const thrown = await adapter.upload({ albumRef: "a", deviceAssetId: "d", filename: "f", bytes: Buffer.alloc(1), takenAt: "t" }).catch((error: unknown) => error);
    assert.ok(thrown instanceof PhotoLibraryNotImplementedError);
    const refusedCheck = await createImmichAdapter({ serverUrl: closedUrl, apiKey: GOOD, guard: { allowedPrivateHosts: ["127.0.0.1"] } }).check();
    assert.ok(immichHits.some((hit) => hit.key === GOOD), "the stand-in did receive the key, in the header, so the scan below is not vacuous");
    assert.ok(seen.length > 20 && logLines.length > 0 && stderr.join("").includes("photo_library."), "there was something to scan");
    assertNoSecret(seen.join("\n"), "a response");
    assertNoSecret(logLines.join("\n"), "a log line");
    assertNoSecret(stderr.join(""), "stderr");
    assertNoSecret(`${String(thrown)} ${(thrown as Error).stack} ${JSON.stringify(thrown)} ${JSON.stringify(refusedCheck)}`, "an error");
  } finally {
    process.stderr.write = realWrite;
    await app.close(); await stderrApp.close();
  }
});

// ── the wiring in the real entrypoint ─────────────────────────────────────────────────────────────────────────────────

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function bootServer(photoLibrary: unknown): Promise<{ origin: string; stop: () => Promise<void>; stderr: () => string }> {
  const port = await freePort(), workerPort = await freePort();
  const directory = await mkdtemp(join(tmpdir(), "kinerary-photo-boot-"));
  const profilePath = join(directory, "architecture.json");
  await writeFile(profilePath, JSON.stringify({
    version: 1, environment: "test", public_api: { bind_host: "127.0.0.1", port },
    worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: workerPort },
    database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
    adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" },
    test_resources: { enabled: false },
    web: {
      public_origin: `http://127.0.0.1:${port}`, runtime_origin: "http://127.0.0.1:4320",
      runtime_exchange_key_secret_ref: "env://KINERARY_TEST_RUNTIME_EXCHANGE_KEY",
      runtime_upstream_host_suffixes: ["internal"], telegram_bot_username: "kinerary_bot",
    },
    ...(photoLibrary !== undefined ? { photo_library: photoLibrary } : {}),
  }), "utf8");
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/server.ts", import.meta.url))], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, CONTROL_PLANE_ARCHITECTURE_PROFILE: profilePath, CONTROL_PLANE_DATABASE_URL: databaseUrl!, KINERARY_TEST_RUNTIME_EXCHANGE_KEY: "boot-runtime-exchange-secret" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  let exited: number | null = null;
  child.on("exit", (code) => { exited = code ?? 0; });
  const stop = async () => {
    if (exited === null) { const gone = new Promise((resolve) => child.once("exit", resolve)); child.kill("SIGTERM"); await gone; }
    await rm(directory, { recursive: true, force: true });
  };
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (exited !== null) { await stop(); throw new Error(`server exited (${exited}) before listening:\n${stderr}`); }
    try { if ((await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(500) })).ok) return { origin, stop, stderr: () => stderr }; } catch { /* not yet */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  await stop();
  throw new Error(`server did not listen within 20s:\n${stderr}`);
}

test("photoLibraryPortalSettings: absent block or absent key reference is absent; the allow-list defaults to empty", () => {
  const base = { version: 1, environment: "test", public_api: { bind_host: "127.0.0.1", port: 4310 },
    worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4311 }, database: { connection_secret_ref: "env://X" },
    adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" }, test_resources: { enabled: false } };
  assert.equal(photoLibraryPortalSettings(validateArchitectureProfile(base)), undefined);
  assert.equal(photoLibraryPortalSettings(validateArchitectureProfile({ ...base, photo_library: { allowed_private_hosts: ["immich.home.test"] } })), undefined);
  assert.deepEqual(photoLibraryPortalSettings(validateArchitectureProfile({ ...base, photo_library: { credential_key_secret_ref: KEY_REF } })),
    { credentialKeySecretRef: KEY_REF, allowedPrivateHosts: [] });
  assert.deepEqual(photoLibraryPortalSettings(validateArchitectureProfile({ ...base, photo_library: { credential_key_secret_ref: KEY_REF, allowed_private_hosts: ["Immich.Home.TEST", "::1"] } }))?.allowedPrivateHosts,
    ["immich.home.test", "::1"]);
  // A valid block says nothing at boot.
  const quiet: string[] = [];
  photoLibraryPortalSettings(validateArchitectureProfile({ ...base, photo_library: { credential_key_secret_ref: KEY_REF } }), (line) => { quiet.push(line); });
  assert.deepEqual(quiet, []);
});

/**
 * A PRESENT `photo_library` BLOCK THE SCHEMA REFUSES TURNS THE PHOTO LIBRARY OFF, NOT THE CONTROL PLANE (Dror, regression plan
 * decision 5, 2026-11-27; the shape of `relay.whatsapp`'s set-aside). The profile loads, `photo_library` is absent,
 * `photo_library_invalid` names the field and the rule (never a value), the portal settings are absent (so the routes answer
 * 503), and ONE boot line says so. An invalid block is never partly kept: nothing it names is opened.
 */
const profileBase = { version: 1, environment: "test", public_api: { bind_host: "127.0.0.1", port: 4310 },
  worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4311 }, database: { connection_secret_ref: "env://X" },
  adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" }, test_resources: { enabled: false },
  web: { public_origin: "https://portal.example.test", runtime_origin: "https://runtime.example.test", runtime_exchange_key_secret_ref: "env://EXCHANGE",
    runtime_upstream_host_suffixes: ["internal"], telegram_bot_username: "kinerary_bot" } };
const manyHosts = Array.from({ length: 65 }, (_, i) => `immich${i}.home.test`);
const BAD_BLOCKS: Array<[label: string, block: unknown, field: string, reason: string, values: string[]]> = [
  ["null", null, "photo_library", "is missing or of the wrong type", []],
  ["a string", "env://PHOTO_KEY", "photo_library", "is missing or of the wrong type", ["env://PHOTO_KEY"]],
  ["an array", [KEY_REF], "photo_library", "is missing or of the wrong type", [KEY_REF]],
  ["an unknown key", { credential_key_secret_ref: KEY_REF, allowed_hosts: ["10.0.0.0/8"] }, "photo_library", "has a key the schema does not know", ["10.0.0.0/8", KEY_REF]],
  ["a plain value for the reference", { credential_key_secret_ref: "plain-secret-value" }, "photo_library.credential_key_secret_ref", "is invalid", ["plain-secret-value"]],
  ["a traversing file reference", { credential_key_secret_ref: "file://../../etc/shadow" }, "photo_library.credential_key_secret_ref", "is invalid", ["etc/shadow"]],
  ["a number for the reference", { credential_key_secret_ref: 42 }, "photo_library.credential_key_secret_ref", "is missing or of the wrong type", []],
  ["a CIDR block in the allow-list", { credential_key_secret_ref: KEY_REF, allowed_private_hosts: ["immich.home.test", "10.0.0.0/8"] }, "photo_library.allowed_private_hosts.1", "is invalid", ["10.0.0.0/8", KEY_REF]],
  ["a wildcard", { credential_key_secret_ref: KEY_REF, allowed_private_hosts: ["*.home.test"] }, "photo_library.allowed_private_hosts.0", "is invalid", ["*.home.test"]],
  ["a URL", { credential_key_secret_ref: KEY_REF, allowed_private_hosts: ["http://immich.home.test"] }, "photo_library.allowed_private_hosts.0", "is invalid", ["immich.home.test"]],
  ["a host with a port", { credential_key_secret_ref: KEY_REF, allowed_private_hosts: ["immich.home.test:2283"] }, "photo_library.allowed_private_hosts.0", "is invalid", ["immich.home.test"]],
  ["a string, not a list", { credential_key_secret_ref: KEY_REF, allowed_private_hosts: "immich.home.test" }, "photo_library.allowed_private_hosts", "is missing or of the wrong type", ["immich.home.test"]],
  ["more than 64 hosts", { credential_key_secret_ref: KEY_REF, allowed_private_hosts: manyHosts }, "photo_library.allowed_private_hosts", "is out of range", ["immich0.home.test"]],
  ["an empty host", { credential_key_secret_ref: KEY_REF, allowed_private_hosts: [""] }, "photo_library.allowed_private_hosts.0", "is out of range", []],
];

test("a malformed photo_library block is set aside: the profile loads, the feature is off, one boot line names the field and the rule, never a value", () => {
  for (const [label, block, field, reason, values] of BAD_BLOCKS) {
    const parsed = validateArchitectureProfile({ ...profileBase, photo_library: block });
    assert.equal(parsed.photo_library, undefined, `${label}: the block is dropped, not partly kept`);
    assert.deepEqual(parsed.photo_library_invalid, { field, reason }, `${label}: field and rule named`);
    assert.equal(parsed.web?.telegram_bot_username, "kinerary_bot", `${label}: the rest of the profile is intact`);
    const lines: string[] = [];
    assert.equal(photoLibraryPortalSettings(parsed, (line) => { lines.push(line); }), undefined, `${label}: no portal settings, so the routes answer 503`);
    assert.equal(lines.length, 1, `${label}: exactly one line`);
    const logged = JSON.parse(lines[0]!);
    assert.deepEqual([logged.level, logged.event, logged.field, logged.reason], ["error", "photo_library.disabled", field, reason], label);
    assert.match(logged.effect, /503 photo_library_not_configured/);
    for (const value of values) assert.ok(!lines[0]!.includes(value), `${label}: the line never quotes ${value}`);
  }
});

test("photo_library_invalid is the loader's output, never a profile key: a profile that carries it is refused", () => {
  assert.throws(() => validateArchitectureProfile({ ...profileBase, photo_library_invalid: { field: "photo_library", reason: "is invalid" } }));
  assert.throws(() => validateArchitectureProfile({ ...profileBase, photo_library: { credential_key_secret_ref: KEY_REF }, photo_library_invalid: { field: "x", reason: "y" } }));
});

test("routes built from a set-aside block answer 503 photo_library_not_configured, the same as no block", { skip }, async () => {
  const parsed = validateArchitectureProfile({ ...profileBase, photo_library: { credential_key_secret_ref: KEY_REF, allowed_private_hosts: ["10.0.0.0/8"] } });
  const app = buildApp(profile, { portal: portalDeps(photoLibraryPortalSettings(parsed, () => {})) });
  try {
    for (const [method, url] of [["GET", "/v1/photo-connections"], ["POST", "/v1/photo-connections/immich"]] as const) {
      const response = await call(app, "alice", method, url, method === "POST" ? { serverUrl: immichUrl, apiKey: GOOD } : undefined);
      assert.deepEqual([response.statusCode, response.json().error], [503, "photo_library_not_configured"], `${method} ${url}`);
    }
    assert.deepEqual(immichHits, []);
    assert.deepEqual(await rowsOf(ids.alice), []);
  } finally { await app.close(); }
});

test("the real server entrypoint wires photo_library: with the setting the route answers, without it 503 photo_library_not_configured", { skip }, async () => {
  const configured = await bootServer({ credential_key_secret_ref: KEY_REF, allowed_private_hosts: ["127.0.0.1"] });
  try {
    const response = await fetch(`${configured.origin}/v1/photo-connections`, { headers: { cookie: sessions.alice!.cookie } });
    assert.equal(response.status, 200, "server.ts handed the portal its photo_library settings");
    assert.deepEqual(await response.json(), { connections: [] });
  } finally { await configured.stop(); }
  const unconfigured = await bootServer(undefined);
  try {
    const response = await fetch(`${unconfigured.origin}/v1/photo-connections`, { headers: { cookie: sessions.alice!.cookie } });
    assert.deepEqual([response.status, (await response.json()).error], [503, "photo_library_not_configured"]);
    assert.doesNotMatch(unconfigured.stderr(), /photo_library\.disabled/, "no block is not a malformed block: nothing to say");
  } finally { await unconfigured.stop(); }
  // A malformed block: the control plane still boots, the feature is off, and the boot log says so once, without the value.
  const malformed = await bootServer({ credential_key_secret_ref: KEY_REF, allowed_private_hosts: ["10.0.0.0/8"] });
  try {
    const response = await fetch(`${malformed.origin}/v1/photo-connections`, { headers: { cookie: sessions.alice!.cookie } });
    assert.deepEqual([response.status, (await response.json()).error], [503, "photo_library_not_configured"]);
    const lines = malformed.stderr().split("\n").filter((line) => line.includes("photo_library.disabled"));
    assert.equal(lines.length, 1, "exactly one boot line");
    assert.equal(JSON.parse(lines[0]!).field, "photo_library.allowed_private_hosts.0");
    assert.ok(!lines[0]!.includes("10.0.0.0/8") && !lines[0]!.includes(KEY_REF), "the line quotes no value");
  } finally { await malformed.stop(); }
});
