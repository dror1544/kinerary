import type pg from "pg";
import { resolveTelegramCallbackRef, answerTelegramCallbackQuery } from "./adapters/telegram.js";
import { digestTelegramId } from "./identity.js";
import { processApprovalCallback, type SignupConfig } from "./signup.js";
import { structuredLog } from "./redaction.js";

const TELEGRAM_API_ROOT = "https://api.telegram.org";

// Long polling, not a webhook — matches how Hermes's gateway and the RPi bot
// already talk to Telegram (outbound getUpdates only). A webhook needs a
// public HTTPS URL registered with @BotFather-adjacent setWebhook; polling
// needs none, which is both simpler for a bot that isn't otherwise publicly
// exposed and avoids adding a new public attack surface for a privileged
// admin-approval action. POST /v1/signup/callback (the webhook receiver)
// stays in the codebase for whoever ends up running this behind a real
// public endpoint later — both paths call the same processApprovalCallback,
// so neither can drift from the other's authorization behavior.
//
// Telegram refuses getUpdates while a webhook is registered for the same
// bot token (see deleteWebhookIfPresent below) — call it once before the
// first poll, not on every tick.

export interface TelegramPollerDeps {
  db: pg.Pool;
  botToken: string;
  config: SignupConfig;
  log?: (line: string) => void;
}

interface TelegramUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    data?: string;
    from?: { id?: number | string };
  };
}

export async function deleteWebhookIfPresent(botToken: string, log?: (line: string) => void): Promise<void> {
  try {
    const info = await fetch(`${TELEGRAM_API_ROOT}/bot${botToken}/getWebhookInfo`);
    const body = (await info.json()) as { ok: boolean; result?: { url?: string } };
    if (!body.ok || !body.result?.url) return;
    log?.(structuredLog("info", "telegram_poller.deleting_existing_webhook", {}));
    await fetch(`${TELEGRAM_API_ROOT}/bot${botToken}/deleteWebhook`, { method: "POST" });
  } catch (error) {
    log?.(structuredLog("warn", "telegram_poller.delete_webhook_failed", {
      safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
    }));
  }
}

/** Processes one already-fetched update. Exported separately so tests can feed fixtures without a live fetch. */
export async function handleTelegramUpdate(update: TelegramUpdate, deps: TelegramPollerDeps): Promise<void> {
  const callbackQuery = update.callback_query;
  if (!callbackQuery) return;
  const { data, from, id: callbackQueryId } = callbackQuery;
  const fromId = from?.id;
  if (typeof data !== "string" || (typeof fromId !== "number" && typeof fromId !== "string")) return;

  // Same ref-expansion + verification path POST /v1/signup/callback uses —
  // see resolveTelegramCallbackRef's own doc for why a short ref, not the
  // full signed token, is what actually arrives in callback_data.
  const resolvedToken = (await resolveTelegramCallbackRef(deps.db, data)) ?? data;
  const senderDigest = digestTelegramId(String(fromId));
  const result = await processApprovalCallback(deps.db, resolvedToken, senderDigest, deps.config);

  void answerTelegramCallbackQuery(
    deps.botToken,
    callbackQueryId,
    result.outcome === "approved" ? "Approved"
      : result.outcome === "rejected" ? "Rejected"
      : result.outcome === "already_decided" ? "Already decided"
      : "Could not process this action",
    deps.log,
  );

  if (result.outcome === "error") {
    deps.log?.(structuredLog("warn", "telegram_poller.callback_rejected", { safe_error_code: result.reason }));
  }
}

/**
 * Starts the poll loop and returns a stop function. `intervalMs` is the
 * delay BETWEEN polls (Telegram's own long-poll `timeout` param controls how
 * long each single getUpdates call blocks server-side waiting for new
 * updates — set short here since this runs alongside a Node event loop with
 * other work to do, not as the process's only job).
 */
export function startTelegramApprovalPoller(deps: TelegramPollerDeps, intervalMs = 3000): () => void {
  let offset = 0;
  let stopped = false;
  let inFlight = false;

  async function tick(): Promise<void> {
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      const params = new URLSearchParams({
        offset: String(offset),
        timeout: "0",
        allowed_updates: JSON.stringify(["callback_query"]),
      });
      const response = await fetch(`${TELEGRAM_API_ROOT}/bot${deps.botToken}/getUpdates?${params.toString()}`);
      if (!response.ok) return;
      const body = (await response.json()) as { ok: boolean; result?: TelegramUpdate[] };
      if (!body.ok || !body.result) return;

      for (const update of body.result) {
        offset = Math.max(offset, update.update_id + 1);
        try {
          await handleTelegramUpdate(update, deps);
        } catch (error) {
          deps.log?.(structuredLog("error", "telegram_poller.handle_update_failed", {
            safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
          }));
        }
      }
    } catch (error) {
      deps.log?.(structuredLog("warn", "telegram_poller.poll_failed", {
        safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
      }));
    } finally {
      inFlight = false;
    }
  }

  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
