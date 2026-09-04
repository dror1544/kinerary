/**
 * Thin Telegram Bot API client for the connector.
 *
 * Kept behind an interface so the connector's dispatch logic can be tested
 * without a bot token or a network — the routing and trust rules are the part
 * worth testing, and they should not need Telegram to be exercised.
 *
 * The connector is the ONLY holder of the bot token. Per the relay contract's
 * Appendix A, the gateway holds zero platform secrets and performs no platform
 * crypto; everything that needs the token happens here, at the edge.
 */
import { structuredLog } from "../redaction.js";
import type { InlineKeyboard } from "../chat-router.js";
import { toTelegramMarkdownV2 } from "./markdown.js";

const TELEGRAM_API_ROOT = "https://api.telegram.org";
/** File downloads hang off a different path root than the method API. */
const TELEGRAM_FILE_ROOT = "https://api.telegram.org/file";

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface ChatInfo {
  name: string;
  type: string;
}

/** Who this token actually belongs to, per Telegram itself. */
export interface BotSelf {
  id: string;
  username: string;
}

export interface TelegramClient {
  /**
   * Resolves a Telegram `file_id` to its bytes.
   *
   * Two calls: `getFile` yields a `file_path`, and the download URL that path
   * belongs to embeds the bot token. That URL is why inbound media is
   * re-hosted rather than referenced — the contract requires the platform
   * credential never to cross the wire, and this is where it would.
   *
   * Returns null on any failure, including a file over the size cap. A missing
   * attachment degrades the turn to its caption; it must not fail the update.
   */
  fetchFile(fileId: string, maxBytes: number): Promise<{ bytes: Buffer; mime?: string; path?: string } | null>;

  sendMessage(params: {
    chatId: string;
    text: string;
    replyMarkup?: InlineKeyboard;
    replyTo?: string;
    /**
     * Set for AGENT-authored content, which is formatted in the dialect our
     * capability descriptor advertises (markdown_v2). Left unset for the
     * router's own replies, which are plain prose — asking Telegram to parse
     * them as MarkdownV2 would only invite a parse error over an ordinary
     * full stop.
     */
    parseMode?: "MarkdownV2";
  }): Promise<SendResult>;
  editMessageText(params: {
    chatId: string;
    messageId: string;
    text: string;
    parseMode?: "MarkdownV2";
    /** Redraws the keyboard alongside the text — a re-ticked multi-select. */
    replyMarkup?: InlineKeyboard;
  }): Promise<SendResult>;
  sendChatAction(params: { chatId: string; action?: string }): Promise<void>;
  answerCallbackQuery(params: { callbackQueryId: string; text?: string }): Promise<void>;
  getChatInfo(chatId: string): Promise<ChatInfo | null>;
  /**
   * The bot's own identity. Asked rather than configured: the group relevance
   * gate keys @mention detection and "is this a reply to US" off it, and a
   * hand-written value that drifted from the token would fail silently.
   */
  getMe(): Promise<BotSelf | null>;
  getUpdates(params: { offset: number; timeoutSeconds: number; allowedUpdates: string[] }): Promise<unknown[]>;
  deleteWebhookIfPresent(): Promise<void>;
}

export class HttpTelegramClient implements TelegramClient {
  constructor(
    private readonly botToken: string,
    private readonly log: (line: string) => void = () => {},
  ) {}

  private url(method: string): string {
    return `${TELEGRAM_API_ROOT}/bot${this.botToken}/${method}`;
  }

  private async post(method: string, body: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    try {
      const response = await fetch(this.url(method), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let parsed: { ok?: boolean; result?: unknown; description?: string } = {};
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        /* fall through to the !ok branch */
      }
      if (!response.ok || !parsed.ok) {
        // Telegram's `description` is safe to log verbatim: it never echoes the
        // bot token or chat contents, only shapes like "Bad Request: chat not
        // found". Same judgement adapters/telegram.ts already makes.
        this.log(
          structuredLog("warn", "telegram_api.call_failed", {
            method,
            status: response.status,
            detail: (parsed.description ?? text).slice(0, 300),
          }),
        );
        return { ok: false, error: parsed.description ?? `HTTP ${response.status}` };
      }
      return { ok: true, result: parsed.result };
    } catch (error) {
      this.log(
        structuredLog("warn", "telegram_api.call_threw", {
          method,
          safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
        }),
      );
      return { ok: false, error: "NETWORK" };
    }
  }

  /**
   * Telegram refuses the WHOLE message when MarkdownV2 does not parse, and
   * MarkdownV2 is strict — a bare `.`, `-` or `!` outside an entity is enough.
   * The agent formats in that dialect because our descriptor advertises it, but
   * "formats in" is not "always emits valid".
   *
   * So a parse failure retries once as plain text. The asterisks show, which is
   * ugly; the alternative is the organizer's answer vanishing entirely, which
   * is worse and much harder to notice.
   */
  private isParseError(error: string | undefined): boolean {
    return (error ?? "").toLowerCase().includes("can't parse entities");
  }

  async sendMessage(params: {
    chatId: string;
    text: string;
    replyMarkup?: InlineKeyboard;
    replyTo?: string;
    parseMode?: "MarkdownV2";
  }): Promise<SendResult> {
    const body: Record<string, unknown> = { chat_id: params.chatId, text: params.text };
    if (params.replyMarkup) body.reply_markup = params.replyMarkup;
    if (params.replyTo) body.reply_parameters = { message_id: Number(params.replyTo) };
    if (params.parseMode) {
      // The agent emits CommonMark despite the dialect we advertise, so convert
      // rather than forward. Sending it raw fails on the first unescaped "." —
      // see markdown.ts.
      body.text = toTelegramMarkdownV2(params.text);
      body.parse_mode = params.parseMode;
    }

    let res = await this.post("sendMessage", body);
    if (!res.ok && params.parseMode && this.isParseError(res.error)) {
      this.log(structuredLog("warn", "telegram_api.markdown_fallback", { method: "sendMessage" }));
      delete body.parse_mode;
      body.text = params.text;
      res = await this.post("sendMessage", body);
    }
    if (!res.ok) return { ok: false, error: res.error };
    const messageId = (res.result as { message_id?: number } | undefined)?.message_id;
    return { ok: true, messageId: messageId !== undefined ? String(messageId) : undefined };
  }

  async editMessageText(params: {
    chatId: string;
    messageId: string;
    text: string;
    parseMode?: "MarkdownV2";
    replyMarkup?: InlineKeyboard;
  }): Promise<SendResult> {
    const body: Record<string, unknown> = {
      chat_id: params.chatId,
      message_id: Number(params.messageId),
      text: params.text,
    };
    // Omitted rather than sent empty when there is no keyboard: Telegram reads
    // an absent reply_markup as "leave it alone" and an empty one as "remove
    // it", and removing a live question's buttons is not what an edit means.
    if (params.replyMarkup) body.reply_markup = params.replyMarkup;
    if (params.parseMode) {
      body.text = toTelegramMarkdownV2(params.text);
      body.parse_mode = params.parseMode;
    }

    let res = await this.post("editMessageText", body);
    if (!res.ok && params.parseMode && this.isParseError(res.error)) {
      this.log(structuredLog("warn", "telegram_api.markdown_fallback", { method: "editMessageText" }));
      delete body.parse_mode;
      body.text = params.text;
      res = await this.post("editMessageText", body);
    }
    return res.ok ? { ok: true, messageId: params.messageId } : { ok: false, error: res.error };
  }

  async sendChatAction(params: { chatId: string; action?: string }): Promise<void> {
    await this.post("sendChatAction", { chat_id: params.chatId, action: params.action ?? "typing" });
  }

  async answerCallbackQuery(params: { callbackQueryId: string; text?: string }): Promise<void> {
    await this.post("answerCallbackQuery", {
      callback_query_id: params.callbackQueryId,
      text: params.text,
      show_alert: false,
    });
  }

  async getChatInfo(chatId: string): Promise<ChatInfo | null> {
    const res = await this.post("getChat", { chat_id: chatId });
    if (!res.ok) return null;
    const chat = res.result as { title?: string; username?: string; first_name?: string; type?: string };
    return {
      name: chat.title ?? chat.username ?? chat.first_name ?? chatId,
      type: chat.type ?? "private",
    };
  }

  async getMe(): Promise<BotSelf | null> {
    const res = await this.post("getMe", {});
    if (!res.ok) return null;
    const me = res.result as { id?: number; username?: string };
    if (me?.id === undefined || !me.username) return null;
    return { id: String(me.id), username: me.username };
  }

  async fetchFile(fileId: string, maxBytes: number): Promise<{ bytes: Buffer; mime?: string; path?: string } | null> {
    try {
      const res = await this.post("getFile", { file_id: fileId });
      const meta = (res.ok ? res.result : null) as { file_path?: string; file_size?: number } | null;
      if (!meta) return null;
      const filePath = meta?.file_path;
      if (!filePath) return null;
      // Cheap pre-check so an oversize file is refused before it is streamed.
      if (typeof meta.file_size === "number" && meta.file_size > maxBytes) {
        this.log(structuredLog("warn", "telegram_api.file_too_large", { size: meta.file_size }));
        return null;
      }
      const response = await fetch(`${TELEGRAM_FILE_ROOT}/bot${this.botToken}/${filePath}`);
      if (!response.ok) {
        this.log(structuredLog("warn", "telegram_api.file_download_failed", { status: response.status }));
        return null;
      }
      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.length > maxBytes) {
        this.log(structuredLog("warn", "telegram_api.file_too_large", { size: buf.length }));
        return null;
      }
      return {
        bytes: buf,
        mime: response.headers.get("content-type") ?? undefined,
        path: filePath,
      };
    } catch {
      // Never surface the URL or the error text: both carry the bot token.
      this.log(structuredLog("warn", "telegram_api.file_fetch_error", {}));
      return null;
    }
  }

  async getUpdates(params: {
    offset: number;
    timeoutSeconds: number;
    allowedUpdates: string[];
  }): Promise<unknown[]> {
    const query = new URLSearchParams({
      offset: String(params.offset),
      timeout: String(params.timeoutSeconds),
      allowed_updates: JSON.stringify(params.allowedUpdates),
    });
    try {
      const response = await fetch(`${this.url("getUpdates")}?${query.toString()}`);
      if (!response.ok) {
        // 409 Conflict means something else is already polling this bot token
        // — the failure mode the single-loop rule exists to prevent. Surface it
        // loudly rather than as a generic poll failure.
        this.log(
          structuredLog(response.status === 409 ? "error" : "warn", "telegram_api.get_updates_failed", {
            status: response.status,
            ...(response.status === 409
              ? { hint: "another process is polling this bot token" }
              : {}),
          }),
        );
        return [];
      }
      const body = (await response.json()) as { ok: boolean; result?: unknown[] };
      return body.ok && body.result ? body.result : [];
    } catch (error) {
      this.log(
        structuredLog("warn", "telegram_api.get_updates_threw", {
          safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
        }),
      );
      return [];
    }
  }

  /**
   * Telegram refuses getUpdates while a webhook is registered for the same
   * token, so clear one if present before the first poll. Same reasoning as
   * telegram-poller.ts's own helper.
   */
  async deleteWebhookIfPresent(): Promise<void> {
    try {
      const info = await fetch(this.url("getWebhookInfo"));
      const body = (await info.json()) as { ok: boolean; result?: { url?: string } };
      if (!body.ok || !body.result?.url) return;
      this.log(structuredLog("info", "telegram_api.deleting_existing_webhook", {}));
      await fetch(this.url("deleteWebhook"), { method: "POST" });
    } catch (error) {
      this.log(
        structuredLog("warn", "telegram_api.delete_webhook_failed", {
          safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
        }),
      );
    }
  }
}
