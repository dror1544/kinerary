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
}

/**
 * Sends the real Telegram approval DM and records the short callback_data
 * refs it hands out. See db/migrations/0014_telegram_callback_refs.sql for
 * why this indirection exists: the signed action token this wraps runs to
 * ~190-200 bytes, well over Telegram's 64-byte callback_data limit.
 */
export class TelegramNotificationAdapter implements NotificationAdapter {
  constructor(private readonly config: TelegramAdapterConfig) {}

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

    const response = await fetch(`${TELEGRAM_API_ROOT}/bot${this.config.botToken}/sendMessage`, {
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

  /** A plain DM to an arbitrary chat id — no callback refs, no approval-flow bookkeeping. */
  async sendMessage(params: { chatId: string; text: string }): Promise<void> {
    const response = await fetch(`${TELEGRAM_API_ROOT}/bot${this.config.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: params.chatId, text: params.text }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      this.config.log?.(structuredLog("error", "telegram.send_message_failed", {
        status: response.status,
        detail: detail.slice(0, 300),
      }));
      throw new Error(`telegram sendMessage failed: HTTP ${response.status}`);
    }
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
