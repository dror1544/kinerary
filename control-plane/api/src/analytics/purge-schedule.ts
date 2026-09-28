/**
 * The schedule for `purgeExpiredEvents` (#186): once shortly after the relay
 * starts, then daily, with the store's default retention.
 *
 * Scheduling it was the precondition the migration header and #186 name for
 * enabling assistant events anywhere real, so it is gated by the same setting
 * as recording itself: with `ASSISTANT_EVENTS_ENABLED` unset there is no timer
 * at all — not an idle one. Nothing here enables anything.
 *
 * Follows the relay's other periodic jobs (`startDocumentSweeper`): an
 * unref'd interval, an in-process guard against overlapping runs, a stop
 * function the shutdown path calls, and a failure that is logged and retried
 * at the next tick — never thrown, because an escaping rejection from a timer
 * would take the relay down over a housekeeping job.
 *
 * Logs carry counts and an error class and message. Never a row.
 */
import type pg from "pg";
import { structuredLog } from "../redaction.js";
import { assistantEventsSetting } from "./emitter.js";
import { DEFAULT_RETENTION_DAYS, purgeExpiredEvents } from "./store.js";

/** First run: long enough for the relay to finish booting, short enough that a restart loop still purges. */
export const PURGE_START_DELAY_MS = 60_000;
/** Then daily. Retention is measured in days, so a finer cadence buys nothing. */
export const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Just the timer functions used, so a test can drive the schedule without sleeping. */
export interface PurgeScheduler {
  setTimeout(fn: () => void, ms: number): { unref?(): unknown };
  setInterval(fn: () => void, ms: number): { unref?(): unknown };
  clearTimeout(handle: unknown): void;
  clearInterval(handle: unknown): void;
}

export interface PurgeScheduleOptions {
  /** Defaults to the store's `purgeExpiredEvents`. Injected by tests. */
  purge?: (db: pg.Pool, olderThanDays: number) => Promise<number>;
  scheduler?: PurgeScheduler;
  startDelayMs?: number;
  intervalMs?: number;
}

const realScheduler: PurgeScheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

/**
 * Starts the purge schedule when assistant events are on and there is a
 * database, and returns the function that stops it. Otherwise creates nothing
 * and returns `undefined`.
 */
export function startAssistantEventsPurge(
  env: NodeJS.ProcessEnv,
  db: pg.Pool | undefined,
  log: (line: string) => void,
  options: PurgeScheduleOptions = {},
): (() => void) | undefined {
  if (!assistantEventsSetting(env).enabled || !db) return undefined;

  const purge = options.purge ?? purgeExpiredEvents;
  const scheduler = options.scheduler ?? realScheduler;
  const retentionDays = DEFAULT_RETENTION_DAYS;
  let running = false;
  let stopped = false;

  const tick = (): void => {
    if (stopped || running) return;
    running = true;
    // The call itself is inside the promise chain, so a synchronous throw is
    // caught the same way a rejection is.
    Promise.resolve()
      .then(() => purge(db, retentionDays))
      .then((deleted) => {
        log(structuredLog("info", "relay.assistant_events_purged", { deleted, retention_days: retentionDays }));
      })
      .catch((error: unknown) => {
        log(structuredLog("warn", "relay.assistant_events_purge_failed", {
          error_class: error instanceof Error ? error.name : "UNKNOWN",
          message: String(error instanceof Error ? error.message : error).slice(0, 200),
        }));
      })
      .finally(() => {
        running = false;
      });
  };

  const first = scheduler.setTimeout(tick, options.startDelayMs ?? PURGE_START_DELAY_MS);
  const repeat = scheduler.setInterval(tick, options.intervalMs ?? PURGE_INTERVAL_MS);
  first.unref?.();
  repeat.unref?.();

  return () => {
    stopped = true;
    scheduler.clearTimeout(first);
    scheduler.clearInterval(repeat);
  };
}
