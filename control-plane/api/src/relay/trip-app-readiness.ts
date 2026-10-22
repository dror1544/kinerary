/**
 * Is the Telegram Mini App READY for this bot - so that an "Open trip" button,
 * a pinned message, `/app` in the menus and the plain-word replies would lead
 * somewhere?
 *
 * Owner decision, 2026-10-20: those surfaces appear ONLY when both hold:
 *
 *   1. the Mini App feature is configured and enabled: the architecture profile
 *      has a `web` block with a bot token, and `getMe` on that token names the
 *      bot the profile says it is (the same check the API's sign-in runs); and
 *   2. `getMe` reports `has_main_web_app: true` - the one-time BotFather step
 *      (docs/telegram-mini-app.md) is done, so `t.me/<bot>?startapp=...` opens
 *      something.
 *
 * Anything else is "not ready", and UNKNOWN IS NOT READY: a check that has not
 * run, was refused, failed, or did not say. The relay is a separate process
 * from the API and has no access to the API's own state, so it asks Telegram
 * itself, with the same `checkBotIdentity` and the same `createBotCheckRound`
 * (mini-app-status.ts) the API uses: a later network blip never un-confirms a
 * confirmed bot, and the question is repeated while the answer is "not yet" -
 * so doing the BotFather step later turns the surfaces on without a restart.
 * `onChange` is how the menus are republished when the answer flips.
 *
 * There is deliberately no fallback to the relay's own bot handle: without the
 * `web` block there is no Mini App, whatever bot the relay happens to be.
 */
import { createBotCheckRound, createMiniAppStatus } from "../mini-app-status.js";
import type { BotIdentityResult } from "../telegram-mini-app.js";

export interface TripAppReadiness {
  /** True only on a confirmed yes. Synchronous, so dispatch can ask per update. */
  ready(): boolean;
  /** Runs one check round now. Never throws. */
  runOnce(): Promise<void>;
  /**
   * Runs the first round (awaited, so a caller can read `ready()` right after)
   * and then repeats every `retryMs` until ready or the token is for another
   * bot. Does not call `onChange` for the first round: the caller reads it.
   */
  start(): Promise<void>;
  stop(): void;
}

export function createTripAppReadiness(options: {
  /** One `getMe` verdict on the Mini App's bot, or null when there is no Mini App configured at all. */
  check: (() => Promise<BotIdentityResult>) | null;
  /** Called when `ready()` changes after the first round. */
  onChange?: (ready: boolean) => void;
  retryMs?: number;
}): TripAppReadiness {
  const status = createMiniAppStatus();
  let last: BotIdentityResult | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  const ready = () => {
    const snapshot = status.snapshot();
    return snapshot.enabled && snapshot.has_main_web_app === true;
  };

  const round = options.check
    ? createBotCheckRound({
        check: async () => {
          const result = await options.check!();
          last = result;
          return result;
        },
        status,
        setEnabled: () => {},
        onMainWebAppMissing: () => {},
      })
    : null;

  const runOnce = async (): Promise<void> => {
    if (!round || running) return;
    running = true;
    try {
      await round();
    } catch {
      // A check that threw is "unknown", which is not ready; the next round tries again.
    } finally {
      running = false;
    }
  };

  // Stop asking once ready, or once the token is for another bot (only a restart fixes that).
  const settled = () => ready() || (last !== null && !last.ok && last.reason === "MISMATCH");

  return {
    ready,
    runOnce,
    async start() {
      if (!round) return;
      await runOnce();
      if (settled()) return;
      timer = setInterval(() => {
        const before = ready();
        void runOnce().then(() => {
          const now = ready();
          if (now !== before) options.onChange?.(now);
          if (settled() && timer) {
            clearInterval(timer);
            timer = undefined;
          }
        });
      }, options.retryMs ?? 60_000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
