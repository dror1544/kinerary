import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type pg from "pg";
import type { VerifiedTelegramIdentity, TelegramLoginError } from "./identity.js";

// Stopgap password login — see migration 0021_password_identity.sql's
// header for why this exists instead of routing everything through the
// Telegram Login Widget. Hashing matches the already-reviewed scrypt
// pattern in feat/landing-spa's portal.ts so the eventual switch to that
// system's web_password_credentials isn't a crypto-scheme change too.
const scrypt = promisify(scryptCallback);

function base64url(bytes = 16): string {
  return randomBytes(bytes).toString("base64url");
}

async function hashPassword(password: string): Promise<string> {
  const salt = base64url(16);
  const derived = (await scrypt(password, salt, 32)) as Buffer;
  return `scrypt:${salt}:${derived.toString("base64url")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, digest, extra] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !digest || extra) return false;
  const derived = (await scrypt(password, salt, 32)) as Buffer;
  const expected = Buffer.from(digest, "base64url");
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Same digest shape as identity.ts's digestTelegramId — irreversible, lowercased/trimmed so "A@B.com" and "a@b.com " match. */
function digestEmail(email: string): string {
  return "sha256:" + createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

export type PasswordLoginError =
  | "PASSWORD_LOGIN_MISSING_FIELDS"
  | "PASSWORD_TOO_SHORT"
  | "PASSWORD_LOGIN_INVALID_CREDENTIALS";

export type PasswordLoginResult =
  | { ok: true; identity: VerifiedTelegramIdentity }
  | { ok: false; error: PasswordLoginError };

function fieldsOk(payload: Record<string, unknown>): payload is { email: string; password: string } {
  return typeof payload.email === "string" && payload.email.includes("@")
    && typeof payload.password === "string" && payload.password.length > 0;
}

/**
 * POST /v1/signup's password branch: creates the credential on first use,
 * verifies it on every later call (so a retried/duplicate signup with the
 * same email+password is idempotent, matching startSignup()'s own
 * idempotency). A second signup attempt with the same email but a WRONG
 * password is rejected rather than silently treated as a new account.
 */
export async function createOrVerifyPasswordIdentity(
  db: pg.Pool,
  payload: Record<string, unknown>,
): Promise<PasswordLoginResult> {
  if (!fieldsOk(payload)) return { ok: false, error: "PASSWORD_LOGIN_MISSING_FIELDS" };
  if (payload.password.length < 8) return { ok: false, error: "PASSWORD_TOO_SHORT" };
  const emailDigest = digestEmail(payload.email);

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ user_id: string; password_hash: string }>(
      "SELECT user_id, password_hash FROM control_plane.password_credentials WHERE email_digest = $1 FOR UPDATE",
      [emailDigest],
    );
    const [row] = existing.rows;
    if (row) {
      await client.query("COMMIT");
      if (!(await verifyPassword(payload.password, row.password_hash))) {
        return { ok: false, error: "PASSWORD_LOGIN_INVALID_CREDENTIALS" };
      }
      return { ok: true, identity: passwordIdentity(row.user_id, payload.email, emailDigest) };
    }

    const userId = `user_${randomBytes(16).toString("hex")}`;
    await client.query(
      "INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', $2)",
      [userId, payload.email.split("@")[0]?.slice(0, 120) || "Kinerary organizer"],
    );
    await client.query(
      "INSERT INTO control_plane.user_identities(id, user_id, provider, provider_subject_digest, verified_at) VALUES ($1, $2, 'password', $3, now())",
      [`idnt_${randomBytes(16).toString("hex")}`, userId, emailDigest],
    );
    const passwordHash = await hashPassword(payload.password);
    await client.query(
      "INSERT INTO control_plane.password_credentials(user_id, email_digest, password_hash) VALUES ($1, $2, $3)",
      [userId, emailDigest, passwordHash],
    );
    await client.query("COMMIT");
    return { ok: true, identity: passwordIdentity(userId, payload.email, emailDigest) };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}

/** The 401-gated routes: the credential must already exist — a typo'd email must never silently mint a new phantom account. */
export async function verifyPasswordLogin(
  db: pg.Pool,
  payload: Record<string, unknown>,
): Promise<PasswordLoginResult> {
  if (!fieldsOk(payload)) return { ok: false, error: "PASSWORD_LOGIN_MISSING_FIELDS" };
  const emailDigest = digestEmail(payload.email);
  const result = await db.query<{ user_id: string; password_hash: string }>(
    "SELECT user_id, password_hash FROM control_plane.password_credentials WHERE email_digest = $1",
    [emailDigest],
  );
  const [row] = result.rows;
  if (!row || !(await verifyPassword(payload.password, row.password_hash))) {
    return { ok: false, error: "PASSWORD_LOGIN_INVALID_CREDENTIALS" };
  }
  return { ok: true, identity: passwordIdentity(row.user_id, payload.email, emailDigest) };
}

function passwordIdentity(userId: string, email: string, emailDigest: string): VerifiedTelegramIdentity {
  return {
    provider: "password",
    providerSubjectDigest: emailDigest,
    // Never a real chat id — the outbox dispatcher already treats a NULL
    // recipient as "unsendable, skip" rather than retrying forever (see
    // provisioner.py's _complete()), so this identity just can't receive a
    // Telegram DM until it separately links a real Telegram identity.
    providerSubjectId: userId,
    displayName: email.split("@")[0]?.slice(0, 120) || "Kinerary organizer",
  };
}

export type WebAuthResult =
  | { ok: true; identity: VerifiedTelegramIdentity }
  | { ok: false; error: TelegramLoginError | PasswordLoginError | "AUTHENTICATION_REQUIRED" };

/**
 * Shared resolver for every owner-scoped route (trips/:id, enrollment, plan
 * generate/get/approve, intake/correct): tries the existing X-Telegram-Login
 * header first (byte-for-byte the same behavior as before this module
 * existed), then falls back to X-Portal-Password-Login (base64url JSON
 * {email, password}). Verify-only — never creates an account; only
 * POST /v1/signup does that, via createOrVerifyPasswordIdentity above.
 */
export async function resolveWebAuth(
  headers: Record<string, unknown>,
  db: pg.Pool,
  verifyTelegramLogin: (payload: Record<string, unknown>, botToken: string) => { ok: true; identity: VerifiedTelegramIdentity } | { ok: false; error: TelegramLoginError },
  botToken: string,
): Promise<WebAuthResult> {
  const telegramHeader = headers["x-telegram-login"];
  if (typeof telegramHeader === "string") {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(Buffer.from(telegramHeader, "base64url").toString()) as Record<string, unknown>;
    } catch {
      return { ok: false, error: "AUTHENTICATION_REQUIRED" };
    }
    return verifyTelegramLogin(payload, botToken);
  }

  const passwordHeader = headers["x-portal-password-login"];
  if (typeof passwordHeader === "string") {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(Buffer.from(passwordHeader, "base64url").toString()) as Record<string, unknown>;
    } catch {
      return { ok: false, error: "AUTHENTICATION_REQUIRED" };
    }
    return verifyPasswordLogin(db, payload);
  }

  return { ok: false, error: "AUTHENTICATION_REQUIRED" };
}
