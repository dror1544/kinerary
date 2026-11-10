import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface VerifiedTelegramIdentity {
  // "password" is the stopgap web-login path in password-identity.ts — see
  // its module doc for why /v1/signup and the owner-scoped routes need an
  // alternative to the Telegram Login Widget.
  provider: "telegram" | "password";
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

export const TELEGRAM_FIRST_NAME_MAX_LENGTH = 40;

/** The two facts the dashboard may show about a Telegram account, kept APART so one cannot pose as the other. */
export interface TelegramName {
  firstName: string | null;
  username: string | null;
}

// Characters that render as blank (Hangul/Braille fillers): a "name" made only of them is no name.
const INVISIBLE_FILLERS = /[\u3164\u2800\u115F\u1160\uFFA0]/g;
const AT_SIGNS = /[@\uFF20\uFE6B]/g;
const MAX_COMBINING_MARKS = 2;

/**
 * What the dashboard shows next to a link so an owner can tell their own phone from a stranger's: the
 * account's FIRST NAME and its @USERNAME, as two separate fields. DISPLAY DATA ONLY: free text the other
 * person chose, never used to decide anything (who a link belongs to, what it may open, whether it can be
 * restored) - the digest decides, and these are never compared, parsed or trusted.
 *
 * Callers pass only what Telegram delivered on a VERIFIED path: the `from` of an update the bot received on
 * its own connection, or the user object inside signature-checked initData. NEVER a request body.
 *
 * Why two fields: a forwardee can type "@owner_handle" as their first name, and one joined label would then
 * read as if the owner's handle belonged to them. So the username is stored and rendered on its own, and
 * every '@' is stripped from the first name. The first name is also bounded; stripped of control, format and
 * bidi characters (it cannot reorder the text around it or smuggle a line break); stripped of invisible
 * fillers (a name that is blank apart from them is no name); and limited to two combining marks per base
 * character (no stacked-diacritic towers). A username that is not a real Telegram handle is dropped. Null
 * when nothing usable is left. Surname and id are never kept.
 */
export function telegramDisplayName(from: { first_name?: unknown; username?: unknown } | null | undefined): TelegramName | null {
  let firstName: string | null = null;
  if (typeof from?.first_name === "string") {
    const cleaned = from.first_name
      .replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu, " ")
      .replace(INVISIBLE_FILLERS, " ")
      .replace(AT_SIGNS, "")
      .replace(/\s+/g, " ")
      .trim();
    let marks = 0;
    const capped = Array.from(cleaned).filter((ch) => {
      if (!/\p{M}/u.test(ch)) { marks = 0; return true; }
      marks += 1;
      return marks <= MAX_COMBINING_MARKS;
    });
    const clipped = capped.slice(0, TELEGRAM_FIRST_NAME_MAX_LENGTH).join("").trim();
    firstName = clipped.length > 0 ? clipped : null;
  }
  const username = typeof from?.username === "string" && /^[A-Za-z0-9_]{1,32}$/.test(from.username) ? from.username : null;
  return firstName === null && username === null ? null : { firstName, username };
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

/**
 * Whether a Telegram chat id is a private 1:1 chat rather than a group.
 *
 * Telegram gives a group or supergroup a negative id and a private chat a
 * positive one, and in a private chat that id IS the person's own Telegram
 * user id. Both facts are load-bearing: routing that binds a chat to an
 * organizer, and any lookup that treats a chat id as an identity, are only
 * correct for the private shape.
 *
 * Lives here, beside `digestTelegramId`, because three modules were each
 * carrying their own copy of this regex — chat-router (before consuming an
 * enrollment), interview (before recording a session's chat), and now the
 * organizer trip list. A predicate three places re-derive is a predicate that
 * eventually disagrees with itself.
 */
export function isPrivateChatId(chatId: string): boolean {
  return /^\d{1,20}$/.test(chatId);
}
