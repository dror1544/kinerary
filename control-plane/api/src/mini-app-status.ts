/**
 * What an operator can read, from `/readyz`, about the Telegram Mini App.
 *
 * WHY IT EXISTS. The Mini App needs a one-time manual step no code can do: the
 * bot's Main Mini App is set in BotFather (Bot Settings, Configure Mini App,
 * URL `<portal origin>/mini-app`). Until then `t.me/<bot>?startapp=...` - the
 * link behind the "Open trip" button - opens nothing. Telegram tells us whether
 * it is done: `getMe` returns `has_main_web_app`. Boot already logs it
 * (`mini_app.bot_checked`); a log line is read once, if at all. This keeps the
 * last answer where the deployment's readiness is read, so "is the button
 * going to work" is one request, not a log search.
 *
 * `has_main_web_app: null` means "Telegram has not said" (the check has not
 * succeeded yet, or the field was absent) - NOT "no". Only `false` is a
 * confirmed gap. None of this makes the API not-ready: a missing Mini App
 * downgrades one entry point, it does not stop the service.
 */
import type { BotIdentityResult } from "./telegram-mini-app.js";

export interface MiniAppStatusSnapshot {
  /** `web.telegram_bot_token_secret_ref` resolved to a token. */
  configured: boolean;
  /** `getMe` on that token names the bot the profile says it is. */
  enabled: boolean;
  /** `getMe.has_main_web_app`: true / false, or null while unknown. */
  has_main_web_app: boolean | null;
}

export interface MiniAppStatus {
  markConfigured(): void;
  /** Records one `getMe` identity check (see `checkBotIdentity`). */
  record(result: { ok: boolean; hasMainWebApp?: boolean | null }): void;
  snapshot(): MiniAppStatusSnapshot;
}

export function createMiniAppStatus(): MiniAppStatus {
  let configured = false;
  let enabled = false;
  let hasMainWebApp: boolean | null = null;
  return {
    markConfigured() {
      configured = true;
    },
    record(result) {
      enabled = result.ok;
      // A failed or mismatched check says nothing about the bot's Mini App.
      if (result.ok && typeof result.hasMainWebApp === "boolean") hasMainWebApp = result.hasMainWebApp;
    },
    snapshot() {
      return { configured, enabled, has_main_web_app: hasMainWebApp };
    },
  };
}

/** The readiness check with the Mini App's state added under `telegram_mini_app`. */
export function withMiniAppReadiness(
  base: () => Promise<Record<string, unknown>>,
  status: MiniAppStatus,
): () => Promise<Record<string, unknown>> {
  return async () => ({ ...(await base()), telegram_mini_app: status.snapshot() });
}

/**
 * One round of the boot-time bot check, as server.ts runs it (now, and on a
 * timer until it returns true).
 *
 * - A later blip never switches off a feature that is already confirmed: only a
 *   first verdict, or a success, changes `enabled` and what /readyz says.
 * - "Settled" (stop asking) is: confirmed AND its Main Mini App is set, or a
 *   mis-wired token (only a restart fixes that). A confirmed bot WITHOUT its
 *   Main Mini App stays unsettled, so doing the BotFather step shows on /readyz
 *   within a minute and without a restart.
 * - The gap is announced once, not every minute.
 */
export function createBotCheckRound(options: {
  check: () => Promise<BotIdentityResult>;
  status: MiniAppStatus;
  setEnabled: (enabled: boolean) => void;
  onMainWebAppMissing: () => void;
}): () => Promise<boolean> {
  let enabled = false;
  let announced = false;
  return async () => {
    const result = await options.check();
    if (result.ok || !enabled) {
      enabled = result.ok;
      options.setEnabled(enabled);
      options.status.record(result.ok ? result : { ok: false });
    }
    const mainWebAppMissing = result.ok && result.hasMainWebApp === false;
    if (mainWebAppMissing && !announced) {
      announced = true;
      options.onMainWebAppMissing();
    }
    return (result.ok && !mainWebAppMissing) || (!result.ok && result.reason === "MISMATCH");
  };
}
