/**
 * StructuredModelRunner — the one seam between the interview and whichever CLI
 * is answering.
 *
 * Two reasons this exists rather than the interview shelling out directly:
 *
 *  1. Model choice is per TASK and lives in configuration, not in the code that
 *     needs the answer. `interpret` wants precise and cheap; `extract` wants
 *     long context. They move independently.
 *
 *  2. It is where "own the retry" lives. On 2026-09-07 a fallback chain we did
 *     NOT own swapped models mid-interview — the primary returned 429 and a
 *     different model finished the run under the same SOUL, in the wrong
 *     language. A runner here retries the SAME pinned model and then gives up:
 *     a rate limit degrades to the router's own copy, visibly, never to a
 *     different personality.
 *
 * The `parse` callback IS the schema. There is no JSON-schema enforcement to be
 * had from a CLI, so pretending to enforce one would be theatre — instead the
 * caller supplies a total function from unknown to its own type, and that
 * function is what the tests exercise. Same division as
 * `normaliseExtractedItinerary`: the pure parser is the interesting half, the
 * process spawn is not.
 */
import { execFile } from "node:child_process";

export type RunnerFailure =
  /** No runner configured for this task — the caller proceeds without a model. */
  | "NOT_CONFIGURED"
  /** The CLI is missing, or exited non-zero for a reason that is not a limit. */
  | "FAILED"
  /** Provider said no: 429, quota, overloaded. Retried, then surfaced. */
  | "RATE_LIMITED"
  | "TIMED_OUT"
  /** The model answered, but `parse` rejected what it said. */
  | "BAD_OUTPUT";

export type RunnerResult<T> =
  | { ok: true; value: T; attempts: number; ms: number }
  | { ok: false; reason: RunnerFailure; detail?: string; attempts: number; ms: number };

export interface StructuredModelRequest<T> {
  /** Selects the pinned model. "interpret", "extract", … */
  task: string;
  prompt: string;
  /** Total: returns null for anything it does not accept. Never throws. */
  parse: (raw: unknown) => T | null;
  timeoutMs?: number;
}

export interface StructuredModelRunner {
  run<T>(req: StructuredModelRequest<T>): Promise<RunnerResult<T>>;
}

/**
 * A provider "you've hit your quota / too many requests" response as it
 * surfaces through a CLI — stderr, stdout, or a non-zero exit. Kept identical
 * in spirit to `isRateLimited` in itinerary-extract.ts: a rate-limited call is
 * worth one retry, a clean failure is not, and conflating the two turns a
 * transient limit into a permanent gap.
 */
export function isRateLimitText(text: string): boolean {
  return /\b429\b|rate[\s-]?limit|usage limit|too many requests|quota (?:exceeded|reached)|overloaded|capacity/i.test(
    String(text ?? ""),
  );
}

/**
 * The first JSON object in a CLI's stdout. Models prepend commentary no matter
 * what the prompt says; this is the same salvage `itinerary-extract.ts` does,
 * and it is deliberately not clever — a model that cannot be salvaged this way
 * fails as BAD_OUTPUT rather than being coaxed.
 */
export function firstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** How a CLI is invoked for one task. Adapters differ only in this. */
export interface CliSpec {
  bin: string;
  /** Built per call so the model id can be pinned per task. */
  args: (prompt: string, model: string) => string[];
  model: string;
  timeoutMs: number;
  /** Attempts in total, including the first. Never a different model. */
  maxAttempts: number;
}

export const DEFAULT_TIMEOUT_MS = 45_000;

/**
 * The Claude CLI in print mode. `-p` prints one response and exits, which is
 * the whole interaction: no session, no tools, no memory.
 */
export function claudeSpec(model: string, timeoutMs = DEFAULT_TIMEOUT_MS, bin = "claude"): CliSpec {
  return {
    bin,
    model,
    timeoutMs,
    maxAttempts: 2,
    args: (prompt, m) => ["-p", prompt, "--model", m],
  };
}

/**
 * Hermes with a no-tools profile — the invocation `extractItinerary` already
 * uses in production, kept so the runner can be pointed at the known-good path
 * while the Claude adapter is being measured against it.
 *
 * `--ignore-rules` rather than `--safe-mode`: both give a clean single-turn
 * run, but `--safe-mode` also discards the profile's model config.
 */
export function hermesSpec(profile: string, timeoutMs = DEFAULT_TIMEOUT_MS, bin = "hermes"): CliSpec {
  return {
    bin,
    model: profile,
    timeoutMs,
    maxAttempts: 2,
    args: (prompt, p) => ["-p", p, "chat", "-q", prompt, "-Q", "--ignore-rules", "--reasoning", "none"],
  };
}

type RunOnce = { ok: true; stdout: string } | { ok: false; reason: RunnerFailure; detail: string };

function runOnce(spec: CliSpec, prompt: string): Promise<RunOnce> {
  return new Promise((resolve) => {
    execFile(
      spec.bin,
      spec.args(prompt, spec.model),
      { timeout: spec.timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve({ ok: true, stdout: String(stdout) });
        const tail = `${String(stderr ?? "").trim()} ${String(stdout ?? "").trim()}`.trim().slice(-250);
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return resolve({ ok: false, reason: "FAILED", detail: `${spec.bin} not found` });
        }
        if (err.killed || err.signal) {
          return resolve({ ok: false, reason: "TIMED_OUT", detail: `timed out (${spec.timeoutMs}ms)` });
        }
        if (isRateLimitText(tail)) return resolve({ ok: false, reason: "RATE_LIMITED", detail: tail });
        return resolve({ ok: false, reason: "FAILED", detail: tail || `exit ${(err as NodeJS.ErrnoException).code}` });
      },
    );
  });
}

/** Only a transient failure is worth spending a second attempt on. */
export function worthRetrying(reason: RunnerFailure): boolean {
  return reason === "RATE_LIMITED" || reason === "TIMED_OUT";
}

/**
 * A runner over one CLI spec per task. `specs` is the model pinning: a task
 * with no spec is NOT_CONFIGURED, and the caller carries on without a model
 * rather than failing — the same contract `extractItinerary` already has.
 */
export function cliRunner(specs: Record<string, CliSpec>): StructuredModelRunner {
  return {
    async run<T>(req: StructuredModelRequest<T>): Promise<RunnerResult<T>> {
      const started = Date.now();
      const spec = specs[req.task];
      if (!spec) return { ok: false, reason: "NOT_CONFIGURED", attempts: 0, ms: 0 };
      const timeoutMs = req.timeoutMs ?? spec.timeoutMs;
      let attempts = 0;
      let last: { reason: RunnerFailure; detail: string } = { reason: "FAILED", detail: "" };
      while (attempts < spec.maxAttempts) {
        attempts += 1;
        const out = await runOnce({ ...spec, timeoutMs }, req.prompt);
        if (out.ok) {
          const parsed = req.parse(firstJsonObject(out.stdout));
          if (parsed !== null) return { ok: true, value: parsed, attempts, ms: Date.now() - started };
          // Bad output is not retried: the same prompt to the same pinned model
          // is the same coin flip, and the caller has a correct fallback.
          return { ok: false, reason: "BAD_OUTPUT", detail: out.stdout.slice(0, 250), attempts, ms: Date.now() - started };
        }
        last = { reason: out.reason, detail: out.detail };
        if (!worthRetrying(out.reason)) break;
      }
      return { ok: false, reason: last.reason, detail: last.detail, attempts, ms: Date.now() - started };
    },
  };
}

/**
 * The interpret runner, from the environment. Undefined unless
 * `INTERPRET_RUNNER` names one — the interpret path then falls back to the
 * router's own questions, which is a working interview rather than a broken
 * one, and is the correct default while §8's benchmark has not been run.
 *
 * Env rather than the architecture profile on purpose: this is an experiment
 * with a per-session flag, and putting it in the profile schema would imply a
 * settled deployment story it has not earned yet.
 *
 *   INTERPRET_RUNNER=claude|hermes
 *   INTERPRET_MODEL=<model id, or the Hermes profile name>
 *   INTERPRET_TIMEOUT_MS=45000
 */
export function interpretRunnerFromEnv(env: NodeJS.ProcessEnv = process.env): StructuredModelRunner | undefined {
  const kind = (env.INTERPRET_RUNNER || "").trim().toLowerCase();
  if (!kind) return undefined;
  const model = (env.INTERPRET_MODEL || "").trim();
  if (!model) return undefined;
  const timeoutMs = Number(env.INTERPRET_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  if (kind === "claude") return cliRunner({ interpret: claudeSpec(model, timeoutMs, env.CLAUDE_BIN || "claude") });
  if (kind === "hermes") return cliRunner({ interpret: hermesSpec(model, timeoutMs, env.HERMES_BIN || "hermes") });
  return undefined;
}

/** Test double. `replies` is consumed in order; exhausted means FAILED. */
export function fakeRunner(
  replies: readonly (string | Error)[],
): StructuredModelRunner & { calls: StructuredModelRequest<unknown>[] } {
  const calls: StructuredModelRequest<unknown>[] = [];
  let i = 0;
  return {
    calls,
    async run<T>(req: StructuredModelRequest<T>): Promise<RunnerResult<T>> {
      calls.push(req as unknown as StructuredModelRequest<unknown>);
      const reply = replies[i++];
      if (reply === undefined) return { ok: false, reason: "FAILED", detail: "no reply queued", attempts: 1, ms: 0 };
      if (reply instanceof Error) {
        const reason: RunnerFailure = isRateLimitText(reply.message) ? "RATE_LIMITED" : "FAILED";
        return { ok: false, reason, detail: reply.message, attempts: 1, ms: 0 };
      }
      const parsed = req.parse(firstJsonObject(reply));
      if (parsed === null) return { ok: false, reason: "BAD_OUTPUT", detail: reply.slice(0, 250), attempts: 1, ms: 0 };
      return { ok: true, value: parsed, attempts: 1, ms: 0 };
    },
  };
}
