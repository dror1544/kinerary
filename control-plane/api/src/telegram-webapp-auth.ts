/**
 * Verification of Telegram Mini App `initData` (WebApp.initData).
 *
 * NOT the Login Widget algorithm in identity.ts. The two look alike and differ
 * in exactly the places that make a copy-paste fail closed or, worse, open:
 *
 *   Login Widget (identity.ts)        Mini App (this file)
 *   secret = SHA256(bot_token)        secret = HMAC_SHA256(key="WebAppData", msg=bot_token)
 *   payload is a JSON object          payload is a URL-encoded query string
 *   sorted with localeCompare         sorted by UTF-16 code unit (see below)
 *
 * The algorithm, from https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app :
 *
 *   secret_key        = HMAC_SHA256(key = "WebAppData", message = bot_token)
 *   data_check_string = every received field EXCEPT `hash`, as `key=value` with
 *                       the value URL-DECODED, sorted by key, joined by "\n"
 *   hash              = hex( HMAC_SHA256(key = secret_key, message = data_check_string) )
 *
 * `signature` (Telegram's Ed25519 third-party proof) is NOT removed: it is part
 * of the data the HMAC covers. Dropping it is the commonest way to write a
 * verifier that passes on yesterday's captures and rejects today's.
 *
 * WHAT THIS MODULE IS STRICTER ABOUT THAN TELEGRAM'S REFERENCE:
 *
 *   - `hash` must be exactly 64 LOWERCASE hex characters before it is compared.
 *     `Buffer.from(x, "hex")` stops at the first non-hex character, so an
 *     un-checked "hash" with a trailing junk nibble decodes to the same 32
 *     bytes as the real one; an upper-case copy would likewise be a second
 *     spelling of one signature.
 *   - Duplicate keys are refused, not last-one-wins. A parser that keeps the
 *     last `user` and a checker that keeps the first are two different people.
 *   - Sorting is by code unit, not `localeCompare`: locale order puts "_"
 *     before letters in some ICU versions and after in others, and the HMAC is
 *     over exact bytes.
 *   - The comparison is `timingSafeEqual` over the 32 raw bytes.
 *   - Input is bounded (4096 bytes) before any parsing.
 *
 * The result carries the COMPUTED HMAC (`replayKey`), which replay accounting
 * keys on: two spellings of the same fields have one HMAC, so there is one
 * bucket however the string was re-encoded.
 *
 * NOTHING HERE LOGS. The caller logs a reason code from `reason`, never the
 * input, never the hash, never the user id.
 *
 * Checking a REAL captured initData against a real token (the test vector in
 * the unit test proves the algorithm, only a capture proves Telegram still
 * sends what we think): docs/telegram-mini-app.md, "Checking a captured
 * initData".
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { isPrivateChatId, telegramDisplayName, type TelegramName } from "./identity.js";

export const INIT_DATA_MAX_BYTES = 4096;
/** How far in the future an auth_date may be (clock skew between Telegram and us). */
export const INIT_DATA_FUTURE_SKEW_SECONDS = 60;
export const INIT_DATA_DEFAULT_MAX_AGE_SECONDS = 300;

export type InitDataRejection =
  | "NOT_A_STRING"
  | "TOO_LARGE"
  | "MALFORMED"
  | "DUPLICATE_KEY"
  | "HASH_MISSING"
  | "HASH_SHAPE"
  | "FIELDS_MISSING"
  | "AUTH_DATE_INVALID"
  | "STALE"
  | "FUTURE"
  | "HASH_MISMATCH"
  | "USER_INVALID";

export interface VerifiedInitData {
  /** Telegram's numeric user id, decimal, positive. Also the id of their private chat. */
  telegramUserId: string;
  authDate: number;
  /** The COMPUTED HMAC, lowercase hex. Equal to the received `hash` by construction. */
  replayKey: string;
  /** `start_param`, only ever a routing selector — membership grants access, not this. */
  startParam: string | null;
  /** `chat_type` as Telegram signed it ("sender", "private", "group", ...), if present. */
  chatType: string | null;
  /**
   * First name and @username of the signed-in Telegram account, as separate fields, taken from the user
   * object INSIDE the signed string. Display data only; never used to decide anything.
   */
  name: TelegramName | null;
}

export type InitDataResult =
  | { ok: true; data: VerifiedInitData }
  | { ok: false; reason: InitDataRejection };

const HASH_SHAPE = /^[0-9a-f]{64}$/;
const AUTH_DATE_SHAPE = /^[0-9]{1,12}$/;

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The HMAC Telegram signs initData with, for a given bot token and data-check-string. */
export function computeInitDataHash(botToken: string, dataCheckString: string): Buffer {
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  return createHmac("sha256", secretKey).update(dataCheckString).digest();
}

export function verifyMiniAppInitData(
  initData: unknown,
  botToken: string,
  options: { nowMs?: number; maxAgeSeconds?: number } = {},
): InitDataResult {
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeSeconds = options.maxAgeSeconds ?? INIT_DATA_DEFAULT_MAX_AGE_SECONDS;
  if (typeof initData !== "string" || initData.length === 0) return { ok: false, reason: "NOT_A_STRING" };
  if (Buffer.byteLength(initData, "utf8") > INIT_DATA_MAX_BYTES) return { ok: false, reason: "TOO_LARGE" };
  if (!botToken) return { ok: false, reason: "HASH_MISMATCH" };

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  const fields = new Map<string, string>();
  for (const [key, value] of params) {
    if (fields.has(key)) return { ok: false, reason: "DUPLICATE_KEY" };
    fields.set(key, value);
  }

  const hash = fields.get("hash");
  if (hash === undefined) return { ok: false, reason: "HASH_MISSING" };
  if (!HASH_SHAPE.test(hash)) return { ok: false, reason: "HASH_SHAPE" };
  const userField = fields.get("user");
  const authDateField = fields.get("auth_date");
  if (userField === undefined || authDateField === undefined) return { ok: false, reason: "FIELDS_MISSING" };
  if (!AUTH_DATE_SHAPE.test(authDateField)) return { ok: false, reason: "AUTH_DATE_INVALID" };
  const authDate = Number(authDateField);
  if (!Number.isSafeInteger(authDate) || authDate <= 0) return { ok: false, reason: "AUTH_DATE_INVALID" };

  // The signature is checked BEFORE freshness and user shape so that every
  // failure on attacker-chosen content costs the same single HMAC.
  const dataCheckString = [...fields.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const expected = computeInitDataHash(botToken, dataCheckString);
  const received = Buffer.from(hash, "hex");
  if (received.length !== expected.length || !timingSafeEqual(expected, received)) {
    return { ok: false, reason: "HASH_MISMATCH" };
  }

  const ageSeconds = nowMs / 1000 - authDate;
  if (ageSeconds > maxAgeSeconds) return { ok: false, reason: "STALE" };
  if (ageSeconds < -INIT_DATA_FUTURE_SKEW_SECONDS) return { ok: false, reason: "FUTURE" };

  let user: unknown;
  try {
    user = JSON.parse(userField);
  } catch {
    return { ok: false, reason: "USER_INVALID" };
  }
  const id = (user as { id?: unknown } | null)?.id;
  // A positive safe integer is the only shape that is also a private-chat id;
  // a string "123", a float, a negative (group-shaped) id or a 2^53+ number
  // that JSON.parse has already rounded are all refused here.
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || !isPrivateChatId(String(id))) {
    return { ok: false, reason: "USER_INVALID" };
  }

  const startParam = fields.get("start_param");
  const chatType = fields.get("chat_type");
  return {
    ok: true,
    data: {
      telegramUserId: String(id),
      authDate,
      replayKey: expected.toString("hex"),
      startParam: startParam === undefined || startParam === "" ? null : startParam,
      chatType: chatType === undefined || chatType === "" ? null : chatType,
      name: telegramDisplayName(user as { first_name?: unknown; username?: unknown }),
    },
  };
}
