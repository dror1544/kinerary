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
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type RunnerFailure =
  /** No runner configured for this task — the caller proceeds without a model. */
  | "NOT_CONFIGURED"
  /** The CLI is missing, or exited non-zero for a reason that is not a limit. */
  | "FAILED"
  /** Provider said no: 429, quota, overloaded. Retried, then surfaced. */
  | "RATE_LIMITED"
  | "TIMED_OUT"
  /** 5xx from the gateway or the model host — transient, same model, retried. */
  | "UPSTREAM_ERROR"
  /** Credentials rejected. Never retried: a second identical call cannot help. */
  | "UNAUTHORIZED"
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
  /**
   * A JSON Schema for the answer, when the caller has one.
   *
   * Advisory, and deliberately so: adapters that can enforce it do (the Codex
   * CLI's `--output-schema`, OpenRouter's structured outputs), and adapters
   * that cannot ignore it. It never replaces `parse` — a schema the provider
   * enforces still describes what the model was ASKED for, and `parse` is what
   * decides whether what came back is acceptable to us.
   */
  schema?: Record<string, unknown>;
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
  /** Where to run it. Defaults to a neutral directory — see `hermeticEnv`. */
  cwd?: string;
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

/**
 * A bounded model call must not depend on WHERE it was spawned from.
 *
 * `execFile` inherits the parent's cwd and environment, and the parent here is
 * the relay — a long-running process living inside the kinerary checkout. So
 * `claude -p` was being started in a directory containing CLAUDE.md, a
 * `.claude/settings.json` full of hooks, and a repo it will happily read; and
 * with the environment of whatever shell launched the relay, which on this
 * machine includes an ambient Claude Code session's own `CLAUDE_CODE_*`
 * variables.
 *
 * That is not a theoretical tidiness argument. On 2026-09-10 the SAME document,
 * model, prompt and timeout produced four accepted proposals in 188s through
 * `tools/extract-intake-check.ts` and `proposed: 0, malformed: 0` in 25s
 * through the relay — well-formed output containing nothing, twice, from a
 * booking PDF full of trip details.
 *
 * `codexSpec` already ran in `tmpdir()` for its own reasons; the CLI path never
 * did. Now both are hermetic: a neutral directory, and the caller's session
 * variables stripped so a nested CLI cannot mistake this for a conversation it
 * is part of. PATH and HOME stay — the binary has to be findable and has to
 * reach its own credentials.
 */
function hermeticEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("CLAUDE_CODE_") || k === "CLAUDE_PID" || k === "CLAUDE_EFFORT") continue;
    env[k] = v;
  }
  return env;
}

function runOnce(spec: CliSpec, prompt: string): Promise<RunOnce> {
  return new Promise((resolve) => {
    execFile(
      spec.bin,
      spec.args(prompt, spec.model),
      { timeout: spec.timeoutMs, maxBuffer: 10 * 1024 * 1024, cwd: spec.cwd ?? tmpdir(), env: hermeticEnv() },
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

/**
 * Only a transient failure is worth spending a second attempt on — and the
 * retry is always the SAME pinned model. Never a fallback to another one; that
 * is the 2026-09-07 failure this module exists to prevent.
 */
export function worthRetrying(reason: RunnerFailure): boolean {
  return reason === "RATE_LIMITED" || reason === "TIMED_OUT" || reason === "UPSTREAM_ERROR";
}

// ── Codex CLI ────────────────────────────────────────────────────────────────

/**
 * `codex exec`, as a one-shot structuring call.
 *
 * Three things make it a better fit than the plain print-mode CLIs above:
 *
 *  - `--output-schema` is real enforcement. The model is constrained to the
 *    shape rather than asked politely for it in a prompt, which is the single
 *    biggest source of BAD_OUTPUT on this path.
 *  - `-o <file>` gives the final message on its own. Codex echoes the answer
 *    into its own transcript on stdout, so a `firstJsonObject` over stdout
 *    would span from the echo's first brace to the copy's last one and parse
 *    as neither.
 *  - It authenticates through CODEX_HOME, so it needs no key of ours.
 *
 * Isolation matters as much as any of that: `--ephemeral --ignore-rules
 * --skip-git-repo-check` and a neutral cwd, so a call made from inside this
 * repository does not quietly inherit CLAUDE.md, AGENTS.md or a session.
 * A structuring call must depend on its prompt and nothing else.
 */
export interface CodexSpec {
  bin: string;
  model: string;
  timeoutMs: number;
  maxAttempts: number;
  /** Where the process runs. Neutral by default so no repo rules apply. */
  cwd: string;
}

export function codexSpec(model: string, timeoutMs = DEFAULT_TIMEOUT_MS, over: Partial<CodexSpec> = {}): CodexSpec {
  return { bin: "codex", model, timeoutMs, maxAttempts: 2, cwd: tmpdir(), ...over };
}

async function runCodexOnce(spec: CodexSpec, req: { prompt: string; schema?: Record<string, unknown> }): Promise<RunOnce> {
  const dir = await mkdtemp(join(tmpdir(), "kinerary-codex-"));
  const answerPath = join(dir, "answer.json");
  const args = [
    "exec",
    "-m", spec.model,
    "-s", "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-rules",
    "-o", answerPath,
  ];
  if (req.schema) {
    const schemaPath = join(dir, "schema.json");
    await writeFile(schemaPath, JSON.stringify(req.schema), "utf8");
    args.push("--output-schema", schemaPath);
  }
  args.push(req.prompt);

  try {
    const exited = await new Promise<{ code: number | null; err: string }>((resolve) => {
      // spawn, not execFile: stdin must be closed. Codex waits on it for extra
      // instructions otherwise, and a call that hangs on an empty pipe is worse
      // than one that fails.
      const child = spawn(spec.bin, args, { cwd: spec.cwd, stdio: ["ignore", "pipe", "pipe"] });
      let err = "";
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        child.kill("SIGKILL");
        resolve({ code: null, err: `timed out (${spec.timeoutMs}ms)` });
      }, spec.timeoutMs);
      child.stdout?.on("data", () => {});
      child.stderr?.on("data", (d) => { err += String(d); });
      child.on("error", (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: -1, err: String(e?.message ?? e) });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, err });
      });
    });

    if (exited.code === null) return { ok: false, reason: "TIMED_OUT", detail: exited.err };
    if (exited.code === -1) return { ok: false, reason: "FAILED", detail: `${spec.bin}: ${exited.err.slice(0, 250)}` };

    let answer = "";
    try {
      answer = await readFile(answerPath, "utf8");
    } catch {
      answer = "";
    }
    if (!answer.trim()) {
      const tail = exited.err.trim().slice(-250);
      if (isRateLimitText(tail)) return { ok: false, reason: "RATE_LIMITED", detail: tail };
      return { ok: false, reason: exited.code === 0 ? "BAD_OUTPUT" : "FAILED", detail: tail || `exit ${exited.code}` };
    }
    return { ok: true, stdout: answer };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function codexRunner(specs: Record<string, CodexSpec>): StructuredModelRunner {
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
        const out = await runCodexOnce({ ...spec, timeoutMs }, req);
        if (out.ok) {
          const parsed = req.parse(firstJsonObject(out.stdout));
          if (parsed !== null) return { ok: true, value: parsed, attempts, ms: Date.now() - started };
          return { ok: false, reason: "BAD_OUTPUT", detail: out.stdout.slice(0, 250), attempts, ms: Date.now() - started };
        }
        last = { reason: out.reason, detail: out.detail };
        if (!worthRetrying(out.reason)) break;
      }
      return { ok: false, reason: last.reason, detail: last.detail, attempts, ms: Date.now() - started };
    },
  };
}

// ── OpenRouter ───────────────────────────────────────────────────────────────

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** One task's OpenRouter binding. */
export interface HttpSpec {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxAttempts: number;
  /**
   * Ask for `response_format: {type:"json_object"}`. Worth having when the
   * model supports it and harmless when it does not — a model that rejects it
   * is remembered and retried without it (see `jsonModeRefused`).
   */
  jsonMode: boolean;
  maxOutputTokens?: number;
}

export function openRouterSpec(
  model: string,
  apiKey: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  over: Partial<HttpSpec> = {},
): HttpSpec {
  return {
    baseUrl: OPENROUTER_BASE_URL,
    apiKey,
    model,
    timeoutMs,
    maxAttempts: 3,
    jsonMode: true,
    ...over,
  };
}

/**
 * Models that answered 400 to `response_format`. Process-lifetime, per model:
 * the first call pays one wasted request, every later call skips json mode.
 * Deliberately not persisted — a model gaining support should not need a
 * database migration to be noticed.
 */
const jsonModeRefused = new Set<string>();

/** Whether a 400 is "I do not support response_format" rather than a real fault. */
export function isJsonModeRejection(body: string): boolean {
  return /response_format|json[_\s-]?object|json[_\s-]?mode|structured output/i.test(String(body ?? ""));
}

/** Maps one HTTP status onto the closed reason set. */
export function reasonForStatus(status: number, body: string): RunnerFailure {
  if (status === 401 || status === 403) return "UNAUTHORIZED";
  // 402 is OpenRouter for "out of credits". It is a limit, not a fault, and it
  // must not read as FAILED — the two are told apart for the same reason
  // `isRateLimited` exists in itinerary-extract.ts.
  if (status === 429 || status === 402) return "RATE_LIMITED";
  if (status === 408 || status === 504) return "TIMED_OUT";
  if (status >= 500) return "UPSTREAM_ERROR";
  if (isRateLimitText(body)) return "RATE_LIMITED";
  return "FAILED";
}

/** The assistant text out of an OpenAI-shaped chat completion, or null. */
export function completionText(payload: unknown): string | null {
  const choices = (payload as { choices?: unknown })?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: { content?: unknown } })?.message;
  const content = message?.content;
  if (typeof content === "string") return content;
  // Some providers return content as an array of parts.
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (typeof part === "string" ? part : (part as { text?: unknown })?.text))
      .filter((t): t is string => typeof t === "string")
      .join("");
    return text.length > 0 ? text : null;
  }
  return null;
}

type Fetcher = typeof fetch;

async function callOpenRouter(spec: HttpSpec, prompt: string, doFetch: Fetcher): Promise<RunOnce> {
  const useJsonMode = spec.jsonMode && !jsonModeRefused.has(spec.model);
  const body: Record<string, unknown> = {
    model: spec.model,
    // Deterministic: this is a structuring task, not a writing one.
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
    ...(useJsonMode ? { response_format: { type: "json_object" } } : {}),
    ...(spec.maxOutputTokens ? { max_tokens: spec.maxOutputTokens } : {}),
    // NOTE: deliberately no `models: [...]` fallback array. OpenRouter's own
    // model-fallback is precisely the thing that finished an interview under a
    // different model on 2026-09-07. Provider routing WITHIN one model is fine
    // — same weights, different host; a different model is not.
  };

  let res: Response;
  try {
    res = await doFetch(`${spec.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${spec.apiKey}`,
        "content-type": "application/json",
        // OpenRouter attribution. Not a credential, and not required.
        "http-referer": "https://kinerary.local",
        "x-title": "Kinerary control plane",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(spec.timeoutMs),
    });
  } catch (e) {
    const name = (e as Error)?.name ?? "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, reason: "TIMED_OUT", detail: `timed out (${spec.timeoutMs}ms)` };
    }
    return { ok: false, reason: "UPSTREAM_ERROR", detail: String((e as Error)?.message ?? e).slice(0, 250) };
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    if (res.status === 400 && useJsonMode && isJsonModeRejection(text)) {
      // Not a fault: this model has no json mode. Remember, and let the retry
      // loop spend its next attempt without it.
      jsonModeRefused.add(spec.model);
      return { ok: false, reason: "UPSTREAM_ERROR", detail: "response_format unsupported; retrying without it" };
    }
    return { ok: false, reason: reasonForStatus(res.status, text), detail: `${res.status} ${text.slice(0, 250)}` };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, reason: "FAILED", detail: `unparseable response body: ${text.slice(0, 200)}` };
  }
  // A 200 carrying an error object is how OpenRouter reports some upstream
  // failures. Treated as the status it describes, not as a successful call.
  const embedded = (payload as { error?: { message?: unknown; code?: unknown } })?.error;
  if (embedded) {
    const message = String(embedded.message ?? "");
    const code = Number(embedded.code);
    return {
      ok: false,
      reason: Number.isFinite(code) && code >= 400 ? reasonForStatus(code, message) : reasonForStatus(0, message),
      detail: message.slice(0, 250),
    };
  }

  const content = completionText(payload);
  if (content === null) return { ok: false, reason: "FAILED", detail: "no message content in completion" };
  return { ok: true, stdout: content };
}

/**
 * A runner over OpenRouter, one pinned model per task.
 *
 * The interview does not know this exists — it asks for a task and gets typed
 * data. Which is the point of `StructuredModelRunner`: extraction can sit on a
 * long-context model at one price and `interpret` on a cheap precise one, and
 * neither choice reaches the code that needs the answer.
 */
export function openRouterRunner(specs: Record<string, HttpSpec>, doFetch: Fetcher = fetch): StructuredModelRunner {
  return {
    async run<T>(req: StructuredModelRequest<T>): Promise<RunnerResult<T>> {
      const started = Date.now();
      const spec = specs[req.task];
      if (!spec) return { ok: false, reason: "NOT_CONFIGURED", attempts: 0, ms: 0 };
      if (!spec.apiKey) return { ok: false, reason: "NOT_CONFIGURED", detail: "no api key", attempts: 0, ms: 0 };
      const timeoutMs = req.timeoutMs ?? spec.timeoutMs;
      let attempts = 0;
      let last: { reason: RunnerFailure; detail: string } = { reason: "FAILED", detail: "" };
      while (attempts < spec.maxAttempts) {
        attempts += 1;
        const out = await callOpenRouter({ ...spec, timeoutMs }, req.prompt, doFetch);
        if (out.ok) {
          const parsed = req.parse(firstJsonObject(out.stdout));
          if (parsed !== null) return { ok: true, value: parsed, attempts, ms: Date.now() - started };
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
 * Routes each task to whichever runner was configured for it, so `interpret`
 * can sit on a CLI and `extract` on OpenRouter without either caller knowing.
 * A task nobody claimed is NOT_CONFIGURED, which every caller already handles.
 */
export function composeRunners(byTask: Record<string, StructuredModelRunner>): StructuredModelRunner {
  return {
    async run<T>(req: StructuredModelRequest<T>): Promise<RunnerResult<T>> {
      const runner = byTask[req.task];
      if (!runner) return { ok: false, reason: "NOT_CONFIGURED", attempts: 0, ms: 0 };
      return runner.run(req);
    },
  };
}

/** The OpenRouter key: `OPENROUTER_API_KEY`, or a file holding it. */
export function openRouterKey(env: NodeJS.ProcessEnv = process.env): string {
  const direct = (env.OPENROUTER_API_KEY || "").trim();
  if (direct) return direct;
  const file = (env.OPENROUTER_API_KEY_FILE || "").trim();
  if (!file) return "";
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * The extraction model: MiniMax M3 on OpenRouter.
 *
 * Verified against OpenRouter's live model list on 2026-09-08 — 1,048,576-token
 * context, $0.30/M in and $1.20/M out, and it declares both `response_format`
 * and `structured_outputs`. A million tokens of context is the property that
 * matters here: extraction is the one task where a long window earns its cost.
 *
 * NOTE, and it is worth acting on separately: the `kinerary-extract` Hermes
 * profile names `minimax/minimax-m3:free`, and **there is no such model id**.
 * OpenRouter publishes 16 `:free` variants and no MiniMax is among them. So
 * that profile's primary has been failing and falling through to its own
 * seven-deep fallback chain — which is exactly how a fallback chain hides a
 * broken primary, and exactly why this path does not have one.
 *
 * Here a limit is a limit: retried on the same model, then surfaced.
 */
export const DEFAULT_EXTRACT_MODEL = "minimax/minimax-m3";

/**
 * The interpret model. MiniMax M3 as well — a starting point for §8's
 * benchmark, not a settled choice.
 *
 * Cost is not the reason and barely matters here: an interpret prompt is the
 * outstanding questions plus one message, and its answer is a short JSON
 * object. Latency is the open question, and the only thing that answers it is
 * the measurement. If p95 disappoints, a smaller model is the obvious next
 * thing to try — which is a one-line config change precisely because the task
 * is pinned separately from `extract`.
 */
export const DEFAULT_INTERPRET_MODEL = "minimax/minimax-m3";

/**
 * Codex Luna — the model the first real run uses, and the one to fall back to
 * when a candidate is not good enough.
 *
 * Reached through the Codex CLI rather than OpenRouter, which is why it works
 * with no credential of ours: `codex` authenticates through CODEX_HOME. It is
 * also the only candidate here that can be given an enforced output schema.
 *
 * Falling back to it is a DEPLOYMENT decision — change the config and restart —
 * not something the runner does mid-call. That distinction is the whole of §7:
 * choosing a different model between runs is judgement, swapping one in during
 * a run is the 2026-09-07 failure.
 */
export const CODEX_LUNA_MODEL = "gpt-5.6-luna";

/**
 * Never route through `openrouter/auto`. It picks a model per request, which
 * is the fallback problem wearing a different hat: two runs of the same
 * interview could be served by two different models with no signal that
 * anything varied. Named here so the reason survives someone noticing that
 * `auto` exists and looks convenient.
 */
export const FORBIDDEN_MODELS: ReadonlySet<string> = new Set(["openrouter/auto", "openrouter/auto-beta"]);

/**
 * Both task runners, from the environment. Undefined when nothing is
 * configured — the interpret path then falls back to the router's own
 * questions and extraction to its Hermes profile, which are working behaviours
 * rather than broken ones, and are the right default while §8's benchmark has
 * not been run.
 *
 * Env rather than the architecture profile on purpose: this is an experiment
 * behind a per-session flag, and putting it in the profile schema would imply
 * a settled deployment story it has not earned yet.
 *
 *   OPENROUTER_API_KEY / OPENROUTER_API_KEY_FILE
 *   INTERPRET_RUNNER=openrouter|claude|hermes   INTERPRET_MODEL=<id|profile>
 *   EXTRACT_RUNNER=openrouter|hermes            EXTRACT_MODEL=<id|profile>
 *   INTERPRET_TIMEOUT_MS / EXTRACT_TIMEOUT_MS
 */
export function modelRunnerFromEnv(env: NodeJS.ProcessEnv = process.env): StructuredModelRunner | undefined {
  const key = openRouterKey(env);
  const byTask: Record<string, StructuredModelRunner> = {};

  const build = (kind: string, model: string, timeoutMs: number, task: string): StructuredModelRunner | undefined => {
    // A model that picks a model is the fallback problem again. Refused here
    // rather than trusted to configuration, because the failure it produces is
    // silent — see FORBIDDEN_MODELS.
    if (FORBIDDEN_MODELS.has(model)) return undefined;
    if (kind === "openrouter") {
      if (!key) return undefined;
      return openRouterRunner({ [task]: openRouterSpec(model, key, timeoutMs) });
    }
    if (kind === "codex") return codexRunner({ [task]: codexSpec(model, timeoutMs, { bin: env.CODEX_BIN || "codex" }) });
    if (kind === "claude") return cliRunner({ [task]: claudeSpec(model, timeoutMs, env.CLAUDE_BIN || "claude") });
    if (kind === "hermes") return cliRunner({ [task]: hermesSpec(model, timeoutMs, env.HERMES_BIN || "hermes") });
    return undefined;
  };

  const interpretKind = (env.INTERPRET_RUNNER || "").trim().toLowerCase();
  if (interpretKind) {
    const interpretModel =
      (env.INTERPRET_MODEL || "").trim() ||
      (interpretKind === "openrouter" ? DEFAULT_INTERPRET_MODEL : interpretKind === "codex" ? CODEX_LUNA_MODEL : "");
    if (interpretModel) {
      const runner = build(interpretKind, interpretModel, Number(env.INTERPRET_TIMEOUT_MS || DEFAULT_TIMEOUT_MS), "interpret");
      if (runner) byTask.interpret = runner;
    }
  }

  const extractKind = (env.EXTRACT_RUNNER || "").trim().toLowerCase();
  if (extractKind) {
    const extractModel =
      (env.EXTRACT_MODEL || "").trim() ||
      (extractKind === "openrouter" ? DEFAULT_EXTRACT_MODEL : extractKind === "codex" ? CODEX_LUNA_MODEL : "");
    if (extractModel) {
      const runner = build(extractKind, extractModel, Number(env.EXTRACT_TIMEOUT_MS || 90_000), "extract");
      if (runner) byTask.extract = runner;
    }
  }

  return Object.keys(byTask).length > 0 ? composeRunners(byTask) : undefined;
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
