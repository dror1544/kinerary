import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface VerifiedTelegramIdentity {
  provider: "telegram";
  /** sha256:hex — used for identity lookups; the raw ID below is never used for comparisons */
  providerSubjectDigest: string;
  /** Raw Telegram numeric ID as a string. Only for sending messages back — never for identity checks (use the digest) or for returning in any API response. */
  providerSubjectId: string;
  displayName: string;
}

export type TelegramLoginError =
  | "TELEGRAM_LOGIN_HASH_MISSING"
  | "TELEGRAM_LOGIN_MISSING_FIELDS"
  | "TELEGRAM_LOGIN_AUTH_DATE_INVALID"
  | "TELEGRAM_LOGIN_STALE"
  | "TELEGRAM_LOGIN_INVALID_HASH";

export type TelegramLoginResult =
  | { ok: true; identity: VerifiedTelegramIdentity }
  | { ok: false; error: TelegramLoginError };

/**
 * Verifies a Telegram Login Widget payload.
 *
 * Telegram's verification algorithm:
 *   secret_key = SHA256(bot_token)
 *   data_check_string = sorted("key=value\n" for each field except "hash")
 *   expected_hash = HMAC-SHA256(secret_key, data_check_string).hex()
 *
 * Returns both a SHA256 digest of the Telegram numeric ID (the identity
 * comparison key, used everywhere else in this codebase) and the raw ID
 * itself (`providerSubjectId`, needed only to send the user a message back —
 * callers must not use it for identity checks or return it in a response).
 */
export function verifyTelegramLogin(
  payload: Record<string, unknown>,
  botToken: string,
  options: { maxAgeSeconds?: number; nowMs?: number } = {},
): TelegramLoginResult {
  const maxAgeSeconds = options.maxAgeSeconds ?? 600;
  const nowMs = options.nowMs ?? Date.now();

  if (!payload.hash || typeof payload.hash !== "string") {
    return { ok: false, error: "TELEGRAM_LOGIN_HASH_MISSING" };
  }
  if (typeof payload.id === "undefined" || typeof payload.first_name !== "string") {
    return { ok: false, error: "TELEGRAM_LOGIN_MISSING_FIELDS" };
  }

  const authDate = Number(payload.auth_date);
  if (!Number.isInteger(authDate) || authDate <= 0) {
    return { ok: false, error: "TELEGRAM_LOGIN_AUTH_DATE_INVALID" };
  }

  const ageSeconds = (nowMs / 1000) - authDate;
  if (ageSeconds > maxAgeSeconds || ageSeconds < -60) {
    return { ok: false, error: "TELEGRAM_LOGIN_STALE" };
  }

  // Build sorted data-check string from all fields except "hash".
  // Telegram sends numeric id and auth_date as JSON numbers; String() converts them correctly.
  const dataCheckString = Object.entries(payload)
    .filter(([k]) => k !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("\n");

  const secretKey = createHash("sha256").update(botToken).digest();
  const expectedBuf = createHmac("sha256", secretKey).update(dataCheckString).digest();
  let providedBuf: Buffer;
  try {
    providedBuf = Buffer.from(payload.hash, "hex");
  } catch {
    return { ok: false, error: "TELEGRAM_LOGIN_INVALID_HASH" };
  }
  if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
    return { ok: false, error: "TELEGRAM_LOGIN_INVALID_HASH" };
  }

  const displayName = [payload.first_name, payload.last_name]
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .join(" ");

  return {
    ok: true,
    identity: {
      provider: "telegram",
      providerSubjectDigest: digestTelegramId(String(payload.id)),
      providerSubjectId: String(payload.id),
      displayName,
    },
  };
}

/** Produces the SHA256 digest stored in user_identities for a Telegram numeric ID. */
export function digestTelegramId(telegramId: string): string {
  return "sha256:" + createHash("sha256").update(telegramId).digest("hex");
}

/**
 * Verifies the `X-Telegram-Bot-Api-Secret-Token` header Telegram attaches to
 * every webhook delivery once the webhook is registered with a secret via
 * `setWebhook`. This is the only thing standing between the public callback
 * endpoint and an attacker who supplies their own `callback_query.from.id` —
 * so the comparison must be constant-time and must fail closed on any
 * malformed input rather than throwing.
 */
export function verifyTelegramWebhookSecret(headerValue: unknown, configuredSecret: string): boolean {
  if (typeof headerValue !== "string" || headerValue.length === 0) return false;
  if (configuredSecret.length === 0) return false;
  const provided = Buffer.from(headerValue, "utf8");
  const expected = Buffer.from(configuredSecret, "utf8");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
