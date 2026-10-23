/**
 * The portal's own email sign-up and password reset (owner decision 2026-10-23).
 *
 * WHAT IT IS FOR. A new organizer creates a portal account with an email and a
 * password, proven by a message to that address; anyone who forgot, or who has
 * an invited / Google-created account and never had a password, sets one the
 * same way. It is for creating trips on the portal. The trip sites keep their
 * own trip-password login, untouched.
 *
 * THE SHAPE, and why each part is where it is:
 *
 *   - THE PASSWORD IS CHOSEN AT VERIFICATION, NOT AT SIGN-UP. Sign-up takes an
 *     address only; the emailed link opens a page that asks for the name and the
 *     password, and the request that sends them is the one that spends the token.
 *     Anyone can start a sign-up for anyone's address, so a password chosen then
 *     would be known to a stranger the moment the real owner clicked the link.
 *     Opening the link spends nothing (a mail scanner that fetches it burns no
 *     token), and a too-short password or an unusable name is refused before the
 *     token is touched.
 *   - THE NAME IS CHOSEN THERE TOO, for the same reason: a name typed at sign-up
 *     would become the owner's account name AND the greeting in the mail sent to
 *     the owner's inbox, both written by a stranger. The verification mail greets
 *     generically, and the pending row holds no name.
 *   - AN UNVERIFIED SIGN-UP IS NOT AN ACCOUNT. It is one row in
 *     `email_action_tokens` (purpose `sign_up`): the digest of the
 *     emailed token and the return path, no password and no name. No `users`,
 *     `user_identities` or `password_credentials` row exists until the token is
 *     consumed. So an unverified address cannot sign in (nothing to match), cannot
 *     be claimed, and cannot block an operator's invitation or a Google sign-in
 *     for the same address — they resolve the address through
 *     `resolveOrCreateEmailAccount` and find nothing in their way.
 *   - THE ACCOUNT IS MINTED BY THE SAME FUNCTION AS EVERY OTHER ACCOUNT
 *     (`resolveOrCreateEmailAccountByDigest`, the body of
 *     `resolveOrCreateEmailAccount`): one address, one `user_id`. Verifying only
 *     ever creates a brand-new account. If the address has acquired one in the
 *     meantime (an invitation, a Google sign-in), the token is spent, nothing is
 *     written, and the page says to sign in or reset the password.
 *   - THE RESPONSE NEVER SAYS WHETHER AN ADDRESS HAS AN ACCOUNT. Sign-up and
 *     forgot-password answer 202 with the same body for a new address, an
 *     existing one and an unknown one, and do their work AFTER answering (in the
 *     background, tracked so shutdown and tests can wait for it): the hash, the
 *     lookups and the send all take longer for one case than the other, and a
 *     caller could otherwise read the difference off the clock. Whoever owns the
 *     mailbox is told the truth by mail instead.
 *   - A TOKEN IS A SECRET, SO ONLY ITS DIGEST IS STORED, it is single use and
 *     short lived, and it travels in the URL FRAGMENT (`/verify-email#token=…`)
 *     which browsers never send to a server, a proxy log or a Referer.
 *   - A SEND BUDGET PER ADDRESS lives in the table (rows are the count), because
 *     the in-memory limiter forgets on restart and cannot stop a slow drip to a
 *     stranger's mailbox. Over budget, the request is answered as usual and
 *     nothing is sent — and the log says so.
 *
 * NOTHING HERE LOGS A TOKEN, A PASSWORD, A HASH OR AN ADDRESS. A send failure
 * logs the purpose and the provider's HTTP status.
 */
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import type { Mailer } from "./mailer.js";
import { MailSendError } from "./mailer.js";
import { digestEmail, resolveOrCreateEmailAccountByDigest } from "./password-identity.js";
import { renderPortalMail, type MailLanguage, type PortalMail } from "./portal-email-templates.js";
import { structuredLog } from "./redaction.js";

export const SIGN_UP_TOKEN_TTL_SECONDS = 24 * 60 * 60;
export const PASSWORD_RESET_TOKEN_TTL_SECONDS = 60 * 60;
/** Messages (of any kind) a single address may be sent per hour; past it a request is answered and nothing is sent. */
export const ADDRESS_HOURLY_SEND_CAP = 5;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 1024;

/** `ev_` / `pr_` + 43 base64url characters (32 random bytes). Shape-checked before any query. */
const SIGN_UP_TOKEN = /^ev_[A-Za-z0-9_-]{43}$/;
const RESET_TOKEN = /^pr_[A-Za-z0-9_-]{43}$/;

const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const newToken = (prefix: "ev" | "pr") => `${prefix}_${randomBytes(32).toString("base64url")}`;
const rowId = () => `eat_${randomBytes(16).toString("hex")}`;

export const DISPLAY_NAME_MAX_LENGTH = 80;

/**
 * The name a person types for their own account, made safe to store, show and
 * put in a mail: control, format (which includes the bidi overrides and
 * zero-width characters), surrogate, private-use and line/paragraph-separator
 * characters become spaces, the invisible filler letters the same, whitespace is
 * collapsed and trimmed. Null when nothing is left or more than
 * DISPLAY_NAME_MAX_LENGTH characters remain: the caller refuses, it never clips
 * a name the person has not seen clipped. The same character classes as
 * identity.ts's telegramDisplayName, which cleans a name Telegram supplied.
 */
export function cleanDisplayName(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 1024) return null;
  const cleaned = value
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/[ㅤ⠀ᅟᅠﾠ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const length = Array.from(cleaned).length;
  return length >= 1 && length <= DISPLAY_NAME_MAX_LENGTH ? cleaned : null;
}

export function isPlausibleEmail(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

// ── In-flight background work ───────────────────────────────────────────────

const inFlight = new Set<Promise<void>>();

/** Runs `job` after the response; its failure is logged, never thrown into a request that has already been answered. */
export function runInBackground(job: () => Promise<void>, onError: (error: unknown) => void): void {
  const promise: Promise<void> = Promise.resolve().then(job).catch(onError).finally(() => { inFlight.delete(promise); });
  inFlight.add(promise);
}

/** Resolves when every background job started so far has finished (graceful shutdown; tests). */
export async function portalMailIdle(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

// ── Starting a sign-up or a reset (background) ──────────────────────────────

export interface EmailAuthContext {
  db: pg.Pool;
  mailer: Mailer;
  publicOrigin: string;
  log: (line: string) => void;
}

async function deliver(ctx: EmailAuthContext, purpose: string, mail: PortalMail, language: MailLanguage, to: string): Promise<void> {
  try {
    await ctx.mailer.send(renderPortalMail(mail, language, to));
  } catch (error) {
    // The one failure the person cannot see (the page already said "check your email"): loud here.
    ctx.log(structuredLog("error", "email_auth.send_failed", {
      purpose, provider_status: error instanceof MailSendError ? error.status : null, effect: "no message reached the address",
    }));
  }
}

async function accountExists(db: pg.Pool, emailDigest: string): Promise<boolean> {
  const found = await db.query(
    `SELECT 1 FROM control_plane.password_credentials WHERE email_digest = $1
     UNION ALL
     SELECT 1 FROM control_plane.user_identities WHERE provider = 'password' AND provider_subject_digest = $1
     LIMIT 1`,
    [emailDigest],
  );
  return (found.rowCount ?? 0) > 0;
}

async function overSendBudget(db: pg.Pool, emailDigest: string): Promise<boolean> {
  const sent = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM control_plane.email_action_tokens WHERE email_digest = $1 AND created_at > now() - interval '1 hour'",
    [emailDigest],
  );
  return (sent.rows[0]?.n ?? 0) >= ADDRESS_HOURLY_SEND_CAP;
}

async function purgeStale(db: pg.Pool): Promise<void> {
  await db.query("DELETE FROM control_plane.email_action_tokens WHERE created_at < now() - interval '2 days'");
}

export interface SignUpRequest { email: string; returnTo: string; language: MailLanguage }

/**
 * Everything a sign-up request does after it has been answered. A new address
 * gets a verification message; an address that already has an account gets "you
 * already have an account" instead; either way the caller saw the same 202.
 */
export async function startSignUp(ctx: EmailAuthContext, input: SignUpRequest): Promise<void> {
  const emailDigest = digestEmail(input.email);
  await purgeStale(ctx.db);
  if (await overSendBudget(ctx.db, emailDigest)) {
    ctx.log(structuredLog("warn", "email_auth.address_send_budget_exhausted", { purpose: "sign_up", effect: "request answered, nothing sent" }));
    return;
  }
  const to = input.email.trim();
  if (await accountExists(ctx.db, emailDigest)) {
    // Recorded so the notice counts against the address's budget; the digest is random and can never be presented.
    await ctx.db.query(
      `INSERT INTO control_plane.email_action_tokens(id, purpose, token_digest, email_digest, expires_at, consumed_at)
       VALUES ($1, 'existing_notice', $2, $3, now(), now())`,
      [rowId(), sha(randomBytes(32).toString("base64url")), emailDigest],
    );
    await deliver(ctx, "existing_notice", {
      kind: "existing", signInUrl: `${ctx.publicOrigin}/sign-in`, resetUrl: `${ctx.publicOrigin}/forgot-password`,
    }, input.language, to);
    return;
  }
  const token = newToken("ev");
  const client = await ctx.db.connect();
  try {
    await client.query("BEGIN");
    // Only the newest link works: a person who asked twice is not left with two live tokens.
    await client.query(
      `UPDATE control_plane.email_action_tokens SET consumed_at = now()
        WHERE email_digest = $1 AND purpose = 'sign_up' AND consumed_at IS NULL`,
      [emailDigest],
    );
    await client.query(
      `INSERT INTO control_plane.email_action_tokens(id, purpose, token_digest, email_digest, return_to, expires_at)
       VALUES ($1, 'sign_up', $2, $3, $4, now() + ($5 * interval '1 second'))`,
      [rowId(), sha(token), emailDigest, input.returnTo, SIGN_UP_TOKEN_TTL_SECONDS],
    );
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
  await deliver(ctx, "sign_up", {
    kind: "verify", link: `${ctx.publicOrigin}/verify-email#token=${token}`, ttlHours: SIGN_UP_TOKEN_TTL_SECONDS / 3600,
  }, input.language, to);
}

/** A reset link is sent only when the account exists; otherwise this does nothing at all. */
export async function startPasswordReset(ctx: EmailAuthContext, input: { email: string; language: MailLanguage }): Promise<void> {
  const emailDigest = digestEmail(input.email);
  await purgeStale(ctx.db);
  const account = await ctx.db.query<{ user_id: string }>(
    `SELECT u.id AS user_id FROM control_plane.users u
       JOIN control_plane.user_identities ui ON ui.user_id = u.id AND ui.provider = 'password' AND ui.provider_subject_digest = $1
      WHERE u.status = 'active'
     UNION
     SELECT u.id FROM control_plane.users u
       JOIN control_plane.password_credentials c ON c.user_id = u.id AND c.email_digest = $1
      WHERE u.status = 'active'
     LIMIT 1`,
    [emailDigest],
  );
  const userId = account.rows[0]?.user_id;
  if (!userId) return;
  if (await overSendBudget(ctx.db, emailDigest)) {
    ctx.log(structuredLog("warn", "email_auth.address_send_budget_exhausted", { purpose: "password_reset", effect: "request answered, nothing sent" }));
    return;
  }
  const token = newToken("pr");
  const client = await ctx.db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE control_plane.email_action_tokens SET consumed_at = now() WHERE user_id = $1 AND purpose = 'password_reset' AND consumed_at IS NULL",
      [userId],
    );
    await client.query(
      `INSERT INTO control_plane.email_action_tokens(id, purpose, token_digest, email_digest, user_id, expires_at)
       VALUES ($1, 'password_reset', $2, $3, $4, now() + ($5 * interval '1 second'))`,
      [rowId(), sha(token), emailDigest, userId, PASSWORD_RESET_TOKEN_TTL_SECONDS],
    );
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
  await deliver(ctx, "password_reset", {
    kind: "reset", link: `${ctx.publicOrigin}/reset-password#token=${token}`, ttlMinutes: PASSWORD_RESET_TOKEN_TTL_SECONDS / 60,
  }, input.language, input.email.trim());
}

// ── Consuming a token (inside the caller's transaction) ─────────────────────

export type VerifyResult =
  | { ok: true; userId: string; returnTo: string }
  /** Unknown, used, superseded and expired are ONE answer: a distinguishable refusal confirms a guess. */
  | { ok: false; error: "TOKEN_INVALID" | "ACCOUNT_EXISTS" };

/**
 * Spends a sign-up token and, if the address still has no account, creates it
 * with the password and name the person just chose (`passwordHash`, computed by
 * the caller BEFORE the transaction, as for a reset; `displayName`, already
 * cleaned by `cleanDisplayName`). The caller owns BEGIN/COMMIT so
 * the account, its credential and the session it is signed in with commit
 * together. The token is spent even when the address turned out to have an
 * account already: it will not be tried again.
 */
export async function consumeSignUpToken(client: pg.PoolClient, token: unknown, passwordHash: string, displayName: string): Promise<VerifyResult> {
  if (typeof token !== "string" || !SIGN_UP_TOKEN.test(token)) return { ok: false, error: "TOKEN_INVALID" };
  const found = await client.query<{ id: string; email_digest: string; return_to: string | null }>(
    `SELECT id, email_digest, return_to FROM control_plane.email_action_tokens
      WHERE token_digest = $1 AND purpose = 'sign_up' AND consumed_at IS NULL AND expires_at > now() FOR UPDATE`,
    [sha(token)],
  );
  const row = found.rows[0];
  if (!row) return { ok: false, error: "TOKEN_INVALID" };
  await client.query("UPDATE control_plane.email_action_tokens SET consumed_at = now() WHERE id = $1", [row.id]);

  const taken = await client.query(
    `SELECT 1 FROM control_plane.password_credentials WHERE email_digest = $1
     UNION ALL
     SELECT 1 FROM control_plane.user_identities WHERE provider = 'password' AND provider_subject_digest = $1
     LIMIT 1`,
    [row.email_digest],
  );
  if ((taken.rowCount ?? 0) > 0) return { ok: false, error: "ACCOUNT_EXISTS" };

  const userId = await resolveOrCreateEmailAccountByDigest(client, row.email_digest, displayName);
  const credential = await client.query(
    `INSERT INTO control_plane.password_credentials(user_id, email_digest, password_hash)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING user_id`,
    [userId, row.email_digest, passwordHash],
  );
  // A concurrent invitation or Google sign-in won the address between the check and here: leave theirs alone.
  if (credential.rowCount !== 1) return { ok: false, error: "ACCOUNT_EXISTS" };
  return { ok: true, userId, returnTo: row.return_to ?? "/trips" };
}

export type ResetResult = { ok: true; userId: string } | { ok: false; error: "TOKEN_INVALID" };

/**
 * Spends a reset token, sets the password, and ends every web session the user
 * had (a forgotten password is often a lost or shared device). The caller
 * creates the new session in the same transaction. `passwordHash` is computed by
 * the caller BEFORE the transaction, so scrypt runs for a bad token exactly as
 * it does for a good one and never while a row lock is held.
 */
export async function consumePasswordReset(client: pg.PoolClient, token: unknown, passwordHash: string): Promise<ResetResult> {
  if (typeof token !== "string" || !RESET_TOKEN.test(token)) return { ok: false, error: "TOKEN_INVALID" };
  const found = await client.query<{ id: string; user_id: string; email_digest: string }>(
    `SELECT t.id, t.user_id, t.email_digest FROM control_plane.email_action_tokens t
       JOIN control_plane.users u ON u.id = t.user_id AND u.status = 'active'
      WHERE t.token_digest = $1 AND t.purpose = 'password_reset' AND t.consumed_at IS NULL AND t.expires_at > now() FOR UPDATE OF t`,
    [sha(token)],
  );
  const row = found.rows[0];
  if (!row) return { ok: false, error: "TOKEN_INVALID" };
  // The address's credential must be this user's (or absent): a digest held by another user is a data fault, not something to overwrite.
  const holder = await client.query<{ user_id: string }>("SELECT user_id FROM control_plane.password_credentials WHERE email_digest = $1", [row.email_digest]);
  if (holder.rows[0] && holder.rows[0].user_id !== row.user_id) return { ok: false, error: "TOKEN_INVALID" };
  await client.query("UPDATE control_plane.email_action_tokens SET consumed_at = now() WHERE user_id = $1 AND purpose = 'password_reset' AND consumed_at IS NULL", [row.user_id]);
  await client.query(
    `INSERT INTO control_plane.password_credentials(user_id, email_digest, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()`,
    [row.user_id, row.email_digest, passwordHash],
  );
  await client.query("UPDATE control_plane.web_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [row.user_id]);
  return { ok: true, userId: row.user_id };
}
