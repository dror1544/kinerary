/**
 * The bits every "ask Hermes to web-search and return JSON" task needs.
 *
 * `lookupConsularContacts` and `lookupDestinationInfo` are the same shape of
 * task — one profile, one prompt, `-t web`, salvage a JSON object out of stdout,
 * classify a provider throttle separately from a real failure — and they were
 * written as near-verbatim copies of each other, right down to comments in the
 * second that named the first ("identical posture to…", "same invocation as…").
 * A comment that says "same as that one" is a request for them to be one thing.
 *
 * What is NOT here, deliberately:
 *   - the PROFILE env var and the timeout, which are per task and are the only
 *     things the two callers legitimately differ on;
 *   - the prompt and the normaliser, which are the whole content of each task;
 *   - `firstJsonObject`, which already existed and is re-exported below rather
 *     than written a third time.
 *
 * `itinerary-extract.ts` holds two more copies of this invocation (its extract
 * and venue-search runners) and its own `firstJsonObject`. They are NOT folded
 * in here: that file drives the live document-extract and venue-link paths, and
 * widening this refactor into it would put a working feature at risk to tidy
 * code nobody reported a defect in. It is named here so the remaining
 * duplication is visible rather than forgotten.
 */
import { execFile } from "node:child_process";
// One implementation, already exported, already the one model-runner uses for
// exactly this salvage. A fourth copy was the alternative.
export { firstJsonObject } from "./model-runner.js";

const HERMES_BIN = process.env.HERMES_BIN || "hermes";

/**
 * Plain text safe to interpolate into the site's bilingual span.
 *
 * `site/app.js`'s `_biSpan` builds raw HTML by string interpolation and does no
 * escaping, so stripping angle brackets here is a real boundary and not
 * housekeeping — the modern site's React tree escapes, the legacy site's does
 * not, and both render this data.
 *
 * `maxChars` is optional because the two callers genuinely differ: a consular
 * office name is bounded by its own field rules, an Info-tab line by what fits
 * a list row.
 */
export function plainText(value: unknown, maxChars?: number): string {
  const text = String(value ?? "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return maxChars === undefined ? text : text.slice(0, maxChars);
}

export type HermesSearchArgs = {
  /** The Hermes profile to run under. The caller resolves which env var names it. */
  profile: string;
  prompt: string;
  timeoutMs: number;
};

/**
 * Run one Hermes web search and return raw stdout.
 *
 * `-t web` is what makes it actually search rather than answer an embassy phone
 * number or a tipping custom from memory; `--ignore-rules` keeps the run clean
 * without dropping the profile's fallback chain. Rejects with a message the
 * caller can hand to `isRateLimited` — stdout is included in that message
 * because a provider throttle notice often arrives as model text on stdout
 * rather than on stderr.
 */
export function runHermesWebSearch({ profile, prompt, timeoutMs }: HermesSearchArgs): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      HERMES_BIN,
      ["-p", profile, "chat", "-q", prompt, "-Q", "--ignore-rules", "-t", "web"],
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve(String(stdout));
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return reject(new Error(`hermes CLI not found (HERMES_BIN=${HERMES_BIN})`));
        }
        // `killed` is set by Node only when NODE killed the child, which for
        // this call means the timeout elapsed. A signal WITHOUT `killed` came
        // from outside — an OOM kill, a systemd stop, someone's `kill`. Both
        // behave identically (LOOKUP_FAILED, retried next pass), but they need
        // different fixes, and reporting an external SIGKILL as "timed out"
        // sends whoever reads the log looking for a slow model that was never
        // the problem.
        const signal = err.signal ? String(err.signal) : "";
        const why = err.killed
          ? `timed out (${timeoutMs}ms)`
          : signal
            ? `killed by ${signal} (not a timeout; the ${timeoutMs}ms limit was not reached)`
            : `exit ${(err as NodeJS.ErrnoException).code}`;
        const tail = `${String(stderr ?? "").trim()} ${String(stdout ?? "").trim()}`.trim().slice(-250);
        reject(new Error(`hermes ${why}${tail ? ` — ${tail}` : ""}`));
      },
    );
  });
}
