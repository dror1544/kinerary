/**
 * A user's photo-library connection (#699, docs/specs/sprint-9/699-user-photo-library.md), slice S1a: connect, test,
 * list, choose the default, disconnect. Nothing syncs yet (S2) and Google Photos comes in S3.
 *
 * Two halves:
 *
 *   - The ADAPTER, one per service behind one interface (`ensureAlbum`, `upload`, `describe`, `addToBest`, `shareLink`,
 *     `check`). There is no delete, on purpose: Kinerary never deletes anything in a user's library (P1). Immich
 *     implements `check` only; the rest throw `not_implemented` until S2.
 *   - The CONNECTION STORE the portal routes call. Every query is scoped by the session's user id, so another account's
 *     connection id and an unknown one get the same 404 (AC-19). A response is built field by field from an allow-list
 *     (`connectionView`), never by spreading a row, and never carries the credential (AC-3).
 *
 * Every call to a library goes through photo-library-guard.ts (AC-4). The key travels only in the `x-api-key` header,
 * never in an address; nothing a library answers is passed on to the user as text.
 */
import { randomBytes } from "node:crypto";
import type pg from "pg";
import {
  PhotoCredentialError, decryptCredential, encryptCredential, loadCredentialKey, type CredentialKey,
} from "./photo-credentials.js";
import {
  PhotoLibraryGuardError, guardedFetch, libraryAddressString, parseLibraryAddress, type GuardErrorCode, type GuardOptions, type Resolver,
} from "./photo-library-guard.js";
import { structuredLog } from "./redaction.js";

// ── the adapter ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type PhotoService = "immich" | "google_photos";

export type CheckFailureCode = GuardErrorCode | "not_immich" | "invalid_key" | "key_lacks_permission";

export type CheckResult = { ok: true } | { ok: false; code: CheckFailureCode; permission?: string };

export interface PhotoLibraryAdapter {
  /** Is the library there, and does the credential work for what Kinerary does with it? One call per step, no retries. */
  check(): Promise<CheckResult>;
  ensureAlbum(input: { name: string }): Promise<{ albumRef: string }>;
  upload(input: { albumRef: string; deviceAssetId: string; filename: string; bytes: Buffer; takenAt: string }): Promise<{ assetRef: string }>;
  describe(input: { assetRef: string; description: string }): Promise<void>;
  addToBest(input: { assetRef: string; albumRef: string; best: boolean }): Promise<void>;
  shareLink(input: { albumRef: string }): Promise<{ url: string } | null>;
}

export class PhotoLibraryNotImplementedError extends Error {
  readonly code = "not_implemented";
  constructor(method: string) {
    super(`${method} is not implemented yet (#699 S2)`);
    this.name = "PhotoLibraryNotImplementedError";
  }
}

/** The permission Kinerary needs and checks for first: it reads back the albums it made. */
const REQUIRED_PERMISSION = "album.read";

function permissionNamed(body: Buffer, apiKey: string): string {
  try {
    const message = (JSON.parse(body.toString("utf8")) as { message?: unknown }).message;
    const match = typeof message === "string" ? /Missing required permission:\s*([A-Za-z]+(?:\.[A-Za-z]+){1,2})\b/.exec(message) : null;
    const named = match?.[1];
    // A strict shape, and never anything the key contains: the server's text is not passed on.
    if (named && named.length <= 40 && !apiKey.includes(named)) return named;
  } catch { /* not JSON: fall back */ }
  return REQUIRED_PERMISSION;
}

export function createImmichAdapter(input: { serverUrl: string; apiKey: string; guard: GuardOptions }): PhotoLibraryAdapter {
  const base = parseLibraryAddress(input.serverUrl);
  const at = (path: string): URL => {
    const url = new URL(base.href);
    url.pathname = `${base.pathname === "/" ? "" : base.pathname}${path}`;
    return url;
  };
  const notYet = (method: string) => async (): Promise<never> => { throw new PhotoLibraryNotImplementedError(method); };
  return {
    async check(): Promise<CheckResult> {
      try {
        // Needs no key: is this an Immich at all?
        const ping = await guardedFetch(at("/api/server/ping"), { headers: { accept: "application/json" } }, input.guard);
        let pong = false;
        try { pong = ping.status === 200 && (JSON.parse(ping.body.toString("utf8")) as { res?: unknown }).res === "pong"; } catch { pong = false; }
        if (!pong) return { ok: false, code: "not_immich" };
        // Needs album.read: does the key work, with the permission Kinerary uses? (Never users/me: a narrow key lacks user.read.)
        const albums = await guardedFetch(at("/api/albums"), { headers: { accept: "application/json", "x-api-key": input.apiKey } }, input.guard);
        if (albums.status === 200) {
          let list = false;
          try { list = Array.isArray(JSON.parse(albums.body.toString("utf8"))); } catch { list = false; }
          return list ? { ok: true } : { ok: false, code: "not_immich" };
        }
        if (albums.status === 401) return { ok: false, code: "invalid_key" };
        if (albums.status === 403) return { ok: false, code: "key_lacks_permission", permission: permissionNamed(albums.body, input.apiKey) };
        if (albums.status >= 500) return { ok: false, code: "unreachable" };
        return { ok: false, code: "not_immich" };
      } catch (error) {
        if (error instanceof PhotoLibraryGuardError) return { ok: false, code: error.code };
        return { ok: false, code: "unreachable" };
      }
    },
    ensureAlbum: notYet("ensureAlbum"),
    upload: notYet("upload"),
    describe: notYet("describe"),
    addToBest: notYet("addToBest"),
    shareLink: notYet("shareLink"),
  };
}

// ── the connection store ────────────────────────────────────────────────────────────────────────────────────────────

/** `photo_library` from the profile (config.ts `photoLibraryPortalSettings`), plus what tests inject. */
export interface PhotoLibrarySettings {
  credentialKeySecretRef: string;
  allowedPrivateHosts: readonly string[];
  /** Tests only: a stand-in resolver, shorter limits, a secret resolver and a log sink. */
  resolveHost?: Resolver;
  timeoutMs?: number;
  maxBytes?: number;
  resolveSecret?: (ref: string) => Promise<string>;
  log?: (line: string) => void;
}

export const CONNECTION_ID_PATTERN = /^phc_[A-Za-z0-9]{8,64}$/;

export interface ConnectionView {
  id: string;
  service: PhotoService;
  serverUrl: string | null;
  publicUrl: string | null;
  state: "active" | "needs_reconnect";
  isDefault: boolean;
  lastCheckedAt: string | null;
  lastErrorCode: string | null;
}

interface ConnectionRow {
  id: string;
  user_id: string;
  provider: PhotoService;
  server_url: string | null;
  public_url: string | null;
  credential_ct: string;
  credential_key_id: string;
  status: "active" | "needs_reconnect";
  is_default: boolean;
  last_checked_at: Date | null;
  last_error_code: string | null;
}

/** The ONLY shape a connection leaves the control plane in. Field by field; the credential columns are not read. */
function connectionView(row: ConnectionRow): ConnectionView {
  return {
    id: row.id,
    service: row.provider,
    serverUrl: row.server_url,
    publicUrl: row.public_url,
    state: row.status,
    isDefault: row.is_default,
    lastCheckedAt: row.last_checked_at ? row.last_checked_at.toISOString() : null,
    lastErrorCode: row.last_error_code,
  };
}

const COLUMNS = "id, user_id, provider, server_url, public_url, credential_ct, credential_key_id, status, is_default, last_checked_at, last_error_code";

export interface RouteAnswer {
  status: number;
  body: Record<string, unknown>;
}

const NOT_FOUND: RouteAnswer = { status: 404, body: { error: "NOT_FOUND" } };
export const NOT_CONFIGURED: RouteAnswer = {
  status: 503,
  body: { error: "photo_library_not_configured", message: "Photo libraries are not set up on this Kinerary yet." },
};

const FAILURE_STATUS: Record<CheckFailureCode, number> = {
  invalid_address: 400, address_not_allowed: 400,
  not_immich: 422, invalid_key: 422, key_lacks_permission: 422, redirect_refused: 422, response_too_large: 422,
  unreachable: 502, timeout: 502,
};

const FAILURE_MESSAGE: Record<CheckFailureCode, string> = {
  invalid_address: "Enter the address as http:// or https://, with no user name or password in it.",
  address_not_allowed: "That address is on a private or local network this Kinerary may not reach.",
  not_immich: "There is no Immich server at that address.",
  invalid_key: "Immich did not accept that API key.",
  key_lacks_permission: "The API key works, but lacks a permission Kinerary needs.",
  redirect_refused: "The server answered with a redirect. Enter the address Immich itself is served at.",
  response_too_large: "The server's answer was larger than an Immich server sends.",
  unreachable: "The server could not be reached.",
  timeout: "The server took too long to answer.",
};

/** A 401 or 403 from the library: the person has to give Kinerary a working key again (AC-6). */
const NEEDS_RECONNECT: ReadonlySet<CheckFailureCode> = new Set(["invalid_key", "key_lacks_permission"]);

function failure(result: Extract<CheckResult, { ok: false }>): Record<string, unknown> {
  return { error: result.code, message: FAILURE_MESSAGE[result.code], ...(result.permission ? { permission: result.permission } : {}) };
}

function log(settings: PhotoLibrarySettings, level: "warn" | "error", event: string, fields: Record<string, unknown>): void {
  const line = structuredLog(level, event, fields);
  if (settings.log) settings.log(line);
  else process.stderr.write(`${line}\n`);
}

function guardOf(settings: PhotoLibrarySettings): GuardOptions {
  return {
    allowedPrivateHosts: settings.allowedPrivateHosts,
    ...(settings.resolveHost ? { resolve: settings.resolveHost } : {}),
    ...(settings.timeoutMs !== undefined ? { timeoutMs: settings.timeoutMs } : {}),
    ...(settings.maxBytes !== undefined ? { maxBytes: settings.maxBytes } : {}),
  };
}

async function currentKey(settings: PhotoLibrarySettings): Promise<CredentialKey | null> {
  try {
    return await loadCredentialKey(settings.credentialKeySecretRef, settings.resolveSecret);
  } catch (error) {
    // Loud, and without the value: the reference names where the key should be, which is what the operator needs.
    log(settings, "error", "photo_library.credential_key_unavailable", {
      safe_error_code: error instanceof PhotoCredentialError ? error.code : "UNKNOWN",
      effect: "photo-library connections answer 503 photo_library_not_configured",
    });
    return null;
  }
}

async function inTransaction<T>(db: pg.Pool, userId: string, run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // One change to a user's connections at a time: the default and the one-per-service rule are both per user.
    await client.query("SELECT 1 FROM control_plane.users WHERE id = $1 FOR UPDATE", [userId]);
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function listConnections(db: pg.Pool | pg.PoolClient, userId: string): Promise<ConnectionView[]> {
  const rows = await db.query<ConnectionRow>(
    `SELECT ${COLUMNS} FROM control_plane.photo_connections WHERE user_id = $1 ORDER BY created_at, id`, [userId]);
  return rows.rows.map(connectionView);
}

// Immich issues base64url keys. Nothing else is accepted, so a key can never hold a character (`,` `;` `}` quotes,
// spaces, line breaks) that would end a redaction match early or split a header.
const API_KEY_SHAPE = /^[A-Za-z0-9_-]{1,512}$/;

export async function connectImmich(db: pg.Pool, settings: PhotoLibrarySettings, userId: string, body: unknown): Promise<RouteAnswer> {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  let serverUrl: URL;
  let publicUrl: URL | null = null;
  try {
    serverUrl = parseLibraryAddress(input.serverUrl);
  } catch {
    return { status: 400, body: { ...failure({ ok: false, code: "invalid_address" }), field: "serverUrl" } };
  }
  if (input.publicUrl !== undefined && input.publicUrl !== null && input.publicUrl !== "") {
    // Never fetched: it is the address a share link would use. It only has to be a plain http(s) address.
    try { publicUrl = parseLibraryAddress(input.publicUrl); } catch {
      return { status: 400, body: { ...failure({ ok: false, code: "invalid_address" }), field: "publicUrl" } };
    }
  }
  if (typeof input.apiKey !== "string" || !API_KEY_SHAPE.test(input.apiKey)) {
    return { status: 400, body: { error: "invalid_request", field: "apiKey", message: "Paste the API key Immich gave you." } };
  }
  const apiKey = input.apiKey;
  // No key to seal it with means nothing is checked and nothing is stored.
  const key = await currentKey(settings);
  if (!key) return NOT_CONFIGURED;
  const result = await createImmichAdapter({ serverUrl: serverUrl.href, apiKey, guard: guardOf(settings) }).check();
  if (!result.ok) {
    log(settings, "warn", "photo_library.connect_refused", { service: "immich", safe_error_code: result.code });
    return { status: FAILURE_STATUS[result.code], body: failure(result) };
  }
  return inTransaction(db, userId, async (client) => {
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM control_plane.photo_connections WHERE user_id = $1 AND provider = 'immich' FOR UPDATE", [userId]);
    const id = existing.rows[0]?.id ?? `phc_${randomBytes(16).toString("hex")}`;
    const sealed = encryptCredential(key, apiKey, { connectionId: id, userId });
    const values = [id, userId, libraryAddressString(serverUrl), publicUrl ? libraryAddressString(publicUrl) : null, sealed.ciphertext, sealed.keyId];
    const row = existing.rows[0]
      // A second connect replaces the first in place (L3: one per service): same id, new key, active again.
      ? await client.query<ConnectionRow>(
        `UPDATE control_plane.photo_connections
            SET server_url = $3, public_url = $4, credential_ct = $5, credential_key_id = $6,
                status = 'active', last_checked_at = now(), last_error_code = NULL
          WHERE id = $1 AND user_id = $2 RETURNING ${COLUMNS}`, values)
      : await client.query<ConnectionRow>(
        `INSERT INTO control_plane.photo_connections
           (id, user_id, provider, server_url, public_url, credential_ct, credential_key_id, status, is_default, last_checked_at)
         VALUES ($1, $2, 'immich', $3, $4, $5, $6, 'active',
                 NOT EXISTS (SELECT 1 FROM control_plane.photo_connections WHERE user_id = $2 AND is_default), now())
         RETURNING ${COLUMNS}`, values);
    return { status: existing.rows[0] ? 200 : 201, body: { connection: connectionView(row.rows[0]!) } };
  });
}

async function ownRow(db: pg.Pool | pg.PoolClient, userId: string, id: string, lock = false): Promise<ConnectionRow | null> {
  if (!CONNECTION_ID_PATTERN.test(id)) return null;
  const row = await db.query<ConnectionRow>(
    `SELECT ${COLUMNS} FROM control_plane.photo_connections WHERE id = $1 AND user_id = $2${lock ? " FOR UPDATE" : ""}`, [id, userId]);
  return row.rows[0] ?? null;
}

/**
 * One check of a stored connection. A 401 or 403 from the library makes it `needs_reconnect`; one call, never retried
 * here (AC-6). A failure that is not the key's (unreachable, timeout, a refused address) is recorded and leaves the state.
 */
export async function testConnection(db: pg.Pool, settings: PhotoLibrarySettings, userId: string, id: string): Promise<RouteAnswer> {
  const row = await ownRow(db, userId, id);
  if (!row) return NOT_FOUND;
  if (row.provider !== "immich") return { status: 409, body: { error: "not_supported", message: "This library cannot be tested yet." } };
  const key = await currentKey(settings);
  if (!key) return NOT_CONFIGURED;
  let result: CheckResult;
  try {
    const apiKey = decryptCredential(key, { ciphertext: row.credential_ct, keyId: row.credential_key_id }, { connectionId: row.id, userId });
    result = await createImmichAdapter({ serverUrl: row.server_url ?? "", apiKey, guard: guardOf(settings) }).check();
  } catch (error) {
    // A row sealed under a key that is gone, or one that does not open: only a reconnect helps.
    const code = error instanceof PhotoCredentialError ? error.code : "credential_unreadable";
    log(settings, "warn", "photo_library.credential_unreadable", { connection_id: row.id, safe_error_code: code });
    const updated = await db.query<ConnectionRow>(
      `UPDATE control_plane.photo_connections SET status = 'needs_reconnect', last_error_code = $3, last_checked_at = now()
        WHERE id = $1 AND user_id = $2 AND credential_ct = $4 RETURNING ${COLUMNS}`, [row.id, userId, code, row.credential_ct]);
    return { status: 200, body: { connection: connectionView(updated.rows[0] ?? (await ownRow(db, userId, id)) ?? row), check: { ok: false, error: code } } };
  }
  if (!result.ok) log(settings, "warn", "photo_library.check_failed", { connection_id: row.id, safe_error_code: result.code });
  const updated = await db.query<ConnectionRow>(
    `UPDATE control_plane.photo_connections
        SET status = CASE WHEN $3::boolean THEN 'active' WHEN $4::boolean THEN 'needs_reconnect' ELSE status END,
            last_error_code = $5, last_checked_at = now()
      WHERE id = $1 AND user_id = $2 AND credential_ct = $6 RETURNING ${COLUMNS}`,
    [row.id, userId, result.ok, !result.ok && NEEDS_RECONNECT.has(result.code), result.ok ? null : result.code, row.credential_ct]);
  // A reconnect that landed while this check ran re-sealed the row: its verdict is about the old key, so it writes nothing.
  return {
    status: 200,
    body: { connection: connectionView(updated.rows[0] ?? (await ownRow(db, userId, id)) ?? row), check: result.ok ? { ok: true } : { ok: false, ...failure(result) } },
  };
}

/** Exactly one default per user (AC-2): the old one is cleared first, then the new one set (the index is not deferrable). */
export async function setDefaultConnection(db: pg.Pool, userId: string, id: string): Promise<RouteAnswer> {
  if (!CONNECTION_ID_PATTERN.test(id)) return NOT_FOUND;
  return inTransaction(db, userId, async (client) => {
    if (!(await ownRow(client, userId, id, true))) return NOT_FOUND;
    await client.query("UPDATE control_plane.photo_connections SET is_default = false WHERE user_id = $1 AND is_default AND id <> $2", [userId, id]);
    const row = await client.query<ConnectionRow>(
      `UPDATE control_plane.photo_connections SET is_default = true WHERE id = $1 AND user_id = $2 RETURNING ${COLUMNS}`, [id, userId]);
    return { status: 200, body: { connection: connectionView(row.rows[0]!) } };
  });
}

/**
 * Disconnect (AC-5): the row goes, and the credential with it. The library is not called: nothing in it is touched.
 * Disconnecting the default makes the oldest remaining connection the default (AC-2).
 */
export async function disconnectConnection(db: pg.Pool, userId: string, id: string): Promise<RouteAnswer> {
  if (!CONNECTION_ID_PATTERN.test(id)) return NOT_FOUND;
  return inTransaction(db, userId, async (client) => {
    const gone = await client.query<{ is_default: boolean }>(
      "DELETE FROM control_plane.photo_connections WHERE id = $1 AND user_id = $2 RETURNING is_default", [id, userId]);
    if (!gone.rows[0]) return NOT_FOUND;
    if (gone.rows[0].is_default) {
      await client.query(
        `UPDATE control_plane.photo_connections SET is_default = true
          WHERE id = (SELECT id FROM control_plane.photo_connections WHERE user_id = $1 ORDER BY created_at, id LIMIT 1)`, [userId]);
    }
    return { status: 200, body: { disconnected: true, connections: await listConnections(client, userId) } };
  });
}
