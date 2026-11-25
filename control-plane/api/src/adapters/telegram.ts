import { randomBytes } from "node:crypto";
import type pg from "pg";
import type { NotificationAdapter } from "../signup.js";
import { structuredLog } from "../redaction.js";

const TELEGRAM_API_ROOT = "https://api.telegram.org";

// Matches the ^cbk_[A-Za-z0-9]{8,64}$ CHECK constraint on
// telegram_callback_refs.ref (db/migrations/0014).
function generateCallbackRef(): string {
  return `cbk_${randomBytes(16).toString("hex")}`;
}

export interface TelegramAdapterConfig {
  botToken: string;
  /** Raw Telegram numeric ID of the super-admin — outbound send target only. */
  superAdminChatId: string;
  db: pg.Pool;
  log?: (line: string) => void;
  /**
   * Where the Bot API lives. Absent is `https://api.telegram.org`. Every request to it carries the BOT TOKEN
   * in its path, so a caller takes it from `telegramApiRoot(process.env.TELEGRAM_API_ROOT)` (relay/telegram-api.ts),
   * which refuses anything but https or plain http to this machine; the adapter does not re-validate it.
   * It exists so an outbox send can be pointed at the Bot API stand-in (tools/fake-telegram.ts).
   */
  apiRoot?: string;
}

/**
 * A Bot API call that did not succeed. Its message and fields never carry the bot token or a chat id: `description` is
 * Telegram's own words ("Bad Request: not enough rights to change chat photo"), which name neither, and a network failure is
 * reduced to one fixed phrase because Node's fetch errors quote the URL, and the URL carries the token.
 */
export class TelegramApiError extends Error {
  constructor(readonly method: string, readonly httpStatus: number, readonly description: string | null) {
    super(`telegram ${method} failed: ${httpStatus === 0 ? "unreachable" : `HTTP ${httpStatus}`}`);
    this.name = "TelegramApiError";
  }
}

/** What `getChatMember` says about the bot itself, reduced to the fields the photo decision reads. */
export interface ChatMemberInfo {
  /** Telegram's: creator, administrator, member, restricted, left, kicked. `unavailable` is ours: Telegram refused the question (see getChatMember). */
  status: string;
  can_change_info?: boolean;
  /** Telegram's description, when `status` is `unavailable`. */
  description?: string;
}

/** The three Bot API calls a group-photo request needs (group-photo.ts decides with them). */
export interface GroupPhotoApi {
  /** The bot's own user id: `getMe`, cached once it has succeeded. */
  botId(): Promise<number>;
  getChatMember(chatId: string, userId: number): Promise<ChatMemberInfo>;
  /** Uploads `png` as the chat's photo (multipart InputFile). */
  setChatPhoto(chatId: string, png: Uint8Array): Promise<void>;
}

const TELEGRAM_CALL_TIMEOUT_MS = 15_000;

/**
 * Sends the real Telegram approval DM and records the short callback_data
 * refs it hands out. See db/migrations/0014_telegram_callback_refs.sql for
 * why this indirection exists: the signed action token this wraps runs to
 * ~190-200 bytes, well over Telegram's 64-byte callback_data limit.
 */
export class TelegramNotificationAdapter implements NotificationAdapter, GroupPhotoApi {
  private readonly apiRoot: string;
  private cachedBotId: number | null = null;

  constructor(private readonly config: TelegramAdapterConfig) {
    this.apiRoot = (config.apiRoot ?? TELEGRAM_API_ROOT).replace(/\/+$/, "");
  }

  async sendApprovalRequest(params: {
    requestId: string;
    displayName: string;
    tripNameRequest: string;
    approveToken: string;
    rejectToken: string;
    expiresAt: Date;
  }): Promise<void> {
    const approveRef = generateCallbackRef();
    const rejectRef = generateCallbackRef();

    // Written before the Telegram call: if sendMessage fails partway, an
    // unused ref pointing at a still-valid token is harmless (it simply
    // never gets clicked and expires with the token it wraps). The reverse
    // order — send first, then persist — could leave a delivered button
    // whose ref resolves to nothing.
    const expiresAtIso = params.expiresAt.toISOString();
    await this.config.db.query(
      `INSERT INTO control_plane.telegram_callback_refs (ref, token, expires_at)
       VALUES ($1, $2, $3), ($4, $5, $3)`,
      [approveRef, params.approveToken, expiresAtIso, rejectRef, params.rejectToken],
    );

    const text = [
      "New Kinerary trip signup request",
      `From: ${params.displayName || "(no name provided)"}`,
      `Trip: ${params.tripNameRequest}`,
      `Expires: ${params.expiresAt.toISOString()}`,
    ].join("\n");

    const body = {
      chat_id: this.config.superAdminChatId,
      text,
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Approve", callback_data: approveRef },
          { text: "❌ Reject", callback_data: rejectRef },
        ]],
      },
    };

    const response = await fetch(`${this.apiRoot}/bot${this.config.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      this.config.log?.(structuredLog("error", "telegram.send_approval_request_failed", {
        request_id: params.requestId,
        status: response.status,
        // Telegram's error body is safe to include verbatim — it never
        // echoes the bot token or chat_id, only a description like
        // "Bad Request: chat not found".
        detail: detail.slice(0, 300),
      }));
      throw new Error(`telegram sendMessage failed: HTTP ${response.status}`);
    }
  }

  /**
   * A DM to an arbitrary chat id — no callback refs, no approval-flow
   * bookkeeping. Plain text unless `parseMode: "HTML"`, which the caller has
   * escaped itself (companion-intro.ts does, over the whole message).
   *
   * If Telegram rejects HTML it could not parse, the same words go again as
   * `plainText` with no parse_mode: the formatting is a nicety and the
   * password is not, so a message must never be lost to its own markup.
   */
  async sendMessage(params: {
    chatId: string;
    text: string;
    parseMode?: "HTML";
    plainText?: string;
  }): Promise<void> {
    const post = (body: Record<string, unknown>) => fetch(`${this.apiRoot}/bot${this.config.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let response = await post({
      chat_id: params.chatId,
      text: params.text,
      ...(params.parseMode ? { parse_mode: params.parseMode } : {}),
    });
    if (!response.ok && params.parseMode) {
      const detail = await response.text().catch(() => "");
      if (response.status === 400 && detail.toLowerCase().includes("can't parse entities")) {
        this.config.log?.(structuredLog("warn", "telegram.send_message_html_fallback", {
          status: response.status,
        }));
        response = await post({ chat_id: params.chatId, text: params.plainText ?? params.text });
      } else {
        this.failSend(response.status, detail);
      }
    }
    if (!response.ok) {
      this.failSend(response.status, await response.text().catch(() => ""));
    }
  }

  // ── The trip group's photo (group-photo.ts) ──────────────────────────────────────────────────────────────────────────

  /** One Bot API call, JSON or multipart, bounded in time. Throws TelegramApiError; returns `result`. */
  private async call(method: string, body: Record<string, unknown> | FormData): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.apiRoot}/bot${this.config.botToken}/${method}`, {
        method: "POST",
        ...(body instanceof FormData
          ? { body }
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TELEGRAM_CALL_TIMEOUT_MS),
      });
    } catch {
      throw new TelegramApiError(method, 0, "Telegram could not be reached");
    }
    const text = await response.text().catch(() => "");
    let parsed: { ok?: unknown; result?: unknown; description?: unknown } = {};
    try { parsed = JSON.parse(text) as typeof parsed; } catch { /* not JSON: the status says enough */ }
    if (!response.ok || parsed.ok !== true) {
      const description = typeof parsed.description === "string" ? parsed.description.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200) : null;
      this.config.log?.(structuredLog("warn", "telegram.api_call_failed", { method, status: response.status }));
      throw new TelegramApiError(method, response.status, description);
    }
    return parsed.result;
  }

  async botId(): Promise<number> {
    if (this.cachedBotId !== null) return this.cachedBotId;
    const result = await this.call("getMe", {}) as { id?: unknown } | null;
    if (!result || typeof result.id !== "number" || !Number.isSafeInteger(result.id)) {
      throw new TelegramApiError("getMe", 200, "getMe did not name the bot");
    }
    // Only a success is kept: a blip at one moment must not pin the answer.
    this.cachedBotId = result.id;
    return result.id;
  }

  /**
   * Telegram's answer to "what is this user in this chat", for the bot itself. A 400 or 403 means Telegram will not say
   * (the bot was removed, the chat is gone or was upgraded, the bot may not look): that is an answer for the caller, not a
   * fault, and it reads as `unavailable` so nothing is ever sent on it. Anything else (a rate limit, a 5xx, no network)
   * throws, because the right action is to try again later.
   */
  async getChatMember(chatId: string, userId: number): Promise<ChatMemberInfo> {
    try {
      const result = await this.call("getChatMember", { chat_id: chatId, user_id: userId }) as { status?: unknown; can_change_info?: unknown } | null;
      const status = typeof result?.status === "string" ? result.status : "unavailable";
      return {
        status,
        ...(typeof result?.can_change_info === "boolean" ? { can_change_info: result.can_change_info } : {}),
      };
    } catch (error) {
      if (error instanceof TelegramApiError && (error.httpStatus === 400 || error.httpStatus === 403)) {
        return { status: "unavailable", ...(error.description ? { description: error.description } : {}) };
      }
      throw error;
    }
  }

  async setChatPhoto(chatId: string, png: Uint8Array): Promise<void> {
    const form = new FormData();
    form.set("chat_id", chatId);
    form.set("photo", new Blob([png as BlobPart], { type: "image/png" }), "logo.png");
    await this.call("setChatPhoto", form);
  }

  private failSend(status: number, detail: string): never {
    this.config.log?.(structuredLog("error", "telegram.send_message_failed", {
      status,
      // Telegram's error body is safe to include verbatim, as above.
      detail: detail.slice(0, 300),
    }));
    throw new Error(`telegram sendMessage failed: HTTP ${status}`);
  }
}

/**
 * Resolves a callback_data ref back to the full signed action token.
 * Expired refs resolve to null even though verifyApprovalAction would also
 * catch an expired token — checking here too means a stale ref fails fast
 * with a lookup miss instead of a decode of a token that's already dead.
 */
export async function resolveTelegramCallbackRef(db: pg.Pool, ref: string): Promise<string | null> {
  const result = await db.query<{ token: string }>(
    "SELECT token FROM control_plane.telegram_callback_refs WHERE ref = $1 AND expires_at > now()",
    [ref],
  );
  return result.rows[0]?.token ?? null;
}

/**
 * Clears the loading spinner Telegram shows on a tapped inline-keyboard
 * button until answerCallbackQuery is called. Best-effort: a failure here
 * must never fail the approval/rejection it's reporting on, so callers
 * should not await-and-throw this into their own error path.
 */
export async function answerTelegramCallbackQuery(
  botToken: string,
  callbackQueryId: string,
  text?: string,
  log?: (line: string) => void,
): Promise<void> {
  try {
    const response = await fetch(`${TELEGRAM_API_ROOT}/bot${botToken}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
    });
    if (!response.ok) {
      log?.(structuredLog("warn", "telegram.answer_callback_query_failed", { status: response.status }));
    }
  } catch (error) {
    log?.(structuredLog("warn", "telegram.answer_callback_query_error", {
      safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
    }));
  }
}
