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

/**
 * Same digest shape as identity.ts's digestTelegramId — irreversible,
 * lowercased/trimmed so "A@B.com" and "a@b.com " match.
 *
 * Exported because the operator's invitation path (organizer-invite.ts) has to
 * recognise an address this table already knows, and a second implementation of
 * "how an email becomes a digest" would diverge on exactly the inputs that
 * matter: a capital letter, or a trailing space pasted out of a message.
 */
export function digestEmail(email: string): string {
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

/** A display name for an address, when nothing better has been offered. */
function nameFromEmail(email: string): string {
  return email.split("@")[0]?.slice(0, 120) || "Kinerary organizer";
}

/**
 * THE canonical organizer account for an email address, created if it is new.
 *
 * One address, one `user_id`, whatever brought it here — a signup, an
 * operator's invitation, or a Google sign-in for the same verified address.
 * Every path that needs "the account behind this email" asks here rather than
 * minting its own user, because the moment two of them mint separately, one
 * physical organizer holds two accounts and no later step can tell that they
 * are the same person.
 *
 * `user_identities` is that answer, keyed by `(provider = 'password', email
 * digest)` and UNIQUE on the pair — so the row IS the canonical mapping, and
 * the constraint is what makes this function total rather than a race.
 *
 * WHAT THE IDENTITY ROW DOES NOT MEAN. It is not a credential and not proof
 * that anyone holds the address: `password_credentials` is the credential, and
 * it arrives separately, when and if that person chooses a password. An
 * account with an identity and no credential is an ordinary, expected state —
 * it is exactly what an invited organizer has until they sign up. Nothing can
 * authenticate as it, because every login path reads the credential table.
 *
 * `verified_at` is written as now(), which is what signup has always written
 * for a password identity without verifying anything either: in this model the
 * column records when the address was asserted, not when it was proven. Real
 * verification is a separate piece of work, and when it arrives it belongs
 * here, once, rather than at each caller.
 *
 * Runs inside the caller's transaction so the account and whatever it is being
 * created for — a credential, a trip — commit together or not at all.
 */
export async function resolveOrCreateEmailAccount(
  client: pg.PoolClient,
  email: string,
  displayName?: string,
): Promise<string> {
  const emailDigest = digestEmail(email);
  const existing = await client.query<{ user_id: string }>(
    "SELECT user_id FROM control_plane.user_identities WHERE provider = 'password' AND provider_subject_digest = $1",
    [emailDigest],
  );
  if (existing.rows[0]) return existing.rows[0].user_id;

  // A concurrent caller may be creating the same account right now. The unique
  // pair decides between us; the savepoint is so losing that race does not
  // leave the `users` row we optimistically inserted behind as an orphan.
  await client.query("SAVEPOINT create_email_account");
  const userId = `user_${randomBytes(16).toString("hex")}`;
  await client.query(
    "INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', $2)",
    [userId, (displayName || nameFromEmail(email)).slice(0, 120)],
  );
  const inserted = await client.query<{ user_id: string }>(
    `INSERT INTO control_plane.user_identities(id, user_id, provider, provider_subject_digest, verified_at)
     VALUES ($1, $2, 'password', $3, now())
     ON CONFLICT (provider, provider_subject_digest) DO NOTHING
     RETURNING user_id`,
    [`idnt_${randomBytes(16).toString("hex")}`, userId, emailDigest],
  );
  if (inserted.rows[0]) {
    await client.query("RELEASE SAVEPOINT create_email_account");
    return inserted.rows[0].user_id;
  }

  await client.query("ROLLBACK TO SAVEPOINT create_email_account");
  const winner = await client.query<{ user_id: string }>(
    "SELECT user_id FROM control_plane.user_identities WHERE provider = 'password' AND provider_subject_digest = $1",
    [emailDigest],
  );
  const [row] = winner.rows;
  // The unique pair is what we just lost to, so the winning row is there. If
  // it somehow is not, say so rather than returning undefined into a user_id.
  if (!row) throw new Error("EMAIL_ACCOUNT_VANISHED");
  return row.user_id;
}

/**
 * Give an account a password nobody knows, unless it already has one.
 *
 * An operator creating a trip for somebody supplies their address and nothing
 * else — no password, because inventing one on a person's behalf and keeping it
 * is the thing this whole route exists to avoid. But an account with no
 * `password_credentials` row is not a normal account: it is a shape the rest of
 * the system has to keep special-casing, and the first-come hazard is real —
 * whoever signs up with that address first would otherwise get to set its
 * password and inherit the trip behind it.
 *
 * So the account gets a real credential, derived from 32 random bytes that are
 * hashed and immediately forgotten. Nobody can authenticate with it because
 * nobody — including this process, a moment later — knows what it is. The
 * account is structurally identical to one somebody signed up for themselves,
 * and the organizer simply has no password yet.
 *
 * WHAT REPLACES IT. Password recovery, when the landing page and its
 * authentication UX exist. That flow will overwrite this hash with one the
 * organizer chose, which needs nothing added here: it is an ordinary credential
 * in an ordinary account, which is the point of writing it. Until then an
 * invited organizer reaches their trip through Telegram, or through a Google
 * sign-in on the same verified address, which resolves to this same user.
 *
 * NEVER OVERWRITES. `ON CONFLICT DO NOTHING` covers both unique constraints on
 * the table — the primary key on user_id and the unique email digest. Inviting
 * an address that already belongs to a real organizer must not disturb the
 * password they chose, and this is the line that guarantees it.
 *
 * Returns whether it wrote one, which is only ever used for logging and tests.
 */
export async function ensureUnknownPasswordCredential(
  client: pg.PoolClient,
  userId: string,
  email: string,
): Promise<boolean> {
  const unknowable = randomBytes(32).toString("base64url");
  const passwordHash = await hashPassword(unknowable);
  const inserted = await client.query(
    `INSERT INTO control_plane.password_credentials(user_id, email_digest, password_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING
     RETURNING user_id`,
    [userId, digestEmail(email), passwordHash],
  );
  return inserted.rowCount === 1;
}

/**
 * POST /v1/signup's password branch: creates the credential on first use,
 * verifies it on every later call (so a retried/duplicate signup with the
 * same email+password is idempotent, matching startSignup()'s own
 * idempotency). A second signup attempt with the same email but a WRONG
 * password is rejected rather than silently treated as a new account.
 *
 * SIGNING UP COMPLETES AN ACCOUNT, IT DOES NOT ALWAYS CREATE ONE. An address
 * may already name an organizer here without having a credential — someone who
 * has only ever signed in with Google, or an account invited before invitations
 * wrote credentials of their own. Signing up attaches the password to that
 * account. Minting a second user instead would hand that person a login that
 * cannot see their own trips — a 404 on their own site, permanently, with
 * nothing in the data saying the two accounts were ever one person.
 *
 * AN INVITED ORGANIZER CANNOT SIGN UP OVER THEIR OWN ACCOUNT, and that is the
 * intended shape: their account already holds a credential nobody knows, so
 * this returns INVALID_CREDENTIALS rather than letting whoever gets there first
 * set the password on a trip that is not theirs. The way in for that person is
 * password recovery, which arrives with the landing page; until then it is
 * Telegram, or Google on the same verified address.
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

    // No credential yet, so this address either belongs to nobody or belongs to
    // an account that has never had a password. Attaching one is the same act
    // in both cases — with one exception.
    const userId = await resolveOrCreateEmailAccount(client, payload.email);

    // AN ACCOUNT SOMEBODY CAN ALREADY SIGN IN TO IS NOT CLAIMABLE BY TYPING ITS
    // ADDRESS. Every account created from here on holds a credential from birth
    // — signup writes the chosen one, invitations and Google sign-in write one
    // nobody knows — so a credential-less account can only be an older row. If
    // another identity reaches it, asserting the email is a weaker claim than
    // the one already on the account, and setting a password would hand over
    // everything it owns. Refuse, exactly as a wrong password is refused.
    const others = await client.query(
      "SELECT 1 FROM control_plane.user_identities WHERE user_id = $1 AND provider <> 'password' LIMIT 1",
      [userId],
    );
    if (others.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false, error: "PASSWORD_LOGIN_INVALID_CREDENTIALS" };
    }
    const passwordHash = await hashPassword(payload.password);
    const claimed = await client.query<{ user_id: string }>(
      `INSERT INTO control_plane.password_credentials(user_id, email_digest, password_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (email_digest) DO NOTHING
       RETURNING user_id`,
      [userId, emailDigest, passwordHash],
    );
    await client.query("COMMIT");
    if (claimed.rows[0]) {
      return { ok: true, identity: passwordIdentity(userId, payload.email, emailDigest) };
    }

    // A concurrent signup set the password first. Theirs stands, and this call
    // becomes the verify it would have been a moment later.
    return verifyPasswordLogin(db, payload);
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
