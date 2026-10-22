/**
 * The shared bot's @username, from config when the deployment states it and
 * from Telegram when it does not.
 *
 * WHY THIS EXISTS. The organizer's add-to-group link is `t.me/<bot>?startgroup=…`,
 * so without a handle there is no link. The handle used to come only from
 * `web.telegram_bot_username` in the architecture profile — an optional block —
 * and a profile that omitted it dropped the link with nothing in any log: the
 * owner's Mac staging greeting just said "add me to the group" (2026-10-16). A
 * deployment-config gap must not silently remove the one-tap path, so the
 * handle can also be asked of the bot itself with `getMe` on the token the
 * process already holds.
 *
 * Order: the configured handle (what a deployment states wins), then `getMe`.
 * A SUCCESSFUL `getMe` is cached for the process's life; a failure is not, so
 * a Telegram blip at boot costs one greeting its link, not every greeting until
 * the next restart. The caller logs the gap; this never throws.
 */
import { TELEGRAM_API_ROOT } from "./relay/telegram-api.js";
import { structuredLog } from "./redaction.js";

/** Telegram's own rule for a username, and the one `config.ts` applies to the profile field. */
const BOT_USERNAME = /^[A-Za-z0-9_]{5,32}$/;

const GETME_TIMEOUT_MS = 5000;

export function normalise(value: string | null | undefined): string | null {
  const handle = (value ?? "").trim().replace(/^@/, "");
  return BOT_USERNAME.test(handle) ? handle : null;
}

export { normalise as normaliseBotUsername };

export interface BotUsernameOptions {
  /** `web.telegram_bot_username` / `TELEGRAM_BOT_USERNAME`, when the deployment states one. */
  configured?: string | null;
  /** The bot's token. Used only to ask `getMe`; never logged or returned. */
  botToken?: string | null;
  /** How long `getMe` may take before it counts as a failure. Default 5s. */
  timeoutMs?: number;
  /** For tests. */
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export function createBotUsernameResolver(options: BotUsernameOptions): () => Promise<string | null> {
  const configured = normalise(options.configured);
  const doFetch = options.fetchImpl ?? fetch;
  const log = options.log ?? (() => {});
  let derived: string | null = null;

  return async () => {
    if (configured) return configured;
    if (derived) return derived;
    if (!options.botToken) return null;
    // Bounded: this runs inside the outbox loop's single-flight guard, so a
    // stalled endpoint would otherwise hold every later tick for Node's default
    // (minutes). The abort signal stops the request; the race with a timer
    // bounds the whole call even for a fetch that ignores the signal.
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          const error = new Error("getMe timed out");
          error.name = "TimeoutError";
          reject(error);
        }, options.timeoutMs ?? GETME_TIMEOUT_MS);
      });
      const ask = async () => {
        const response = await doFetch(`${TELEGRAM_API_ROOT}/bot${options.botToken}/getMe`, { signal: controller.signal });
        if (!response.ok) {
          log(structuredLog("warn", "bot_username.getme_failed", { http_status: response.status }));
          return null;
        }
        return (await response.json()) as { ok?: boolean; result?: { username?: string } };
      };
      const body = await Promise.race([ask(), timedOut]);
      if (!body) return null;
      const handle = body.ok ? normalise(body.result?.username) : null;
      if (!handle) {
        log(structuredLog("warn", "bot_username.getme_unusable", {}));
        return null;
      }
      derived = handle;
      return derived;
    } catch (error) {
      // The error text is not logged: a fetch failure message can carry the
      // request URL, and the URL carries the token.
      log(structuredLog("warn", "bot_username.getme_failed", {
        safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
      }));
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
