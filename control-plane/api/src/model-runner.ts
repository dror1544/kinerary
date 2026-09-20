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

/**
 * What a call consumed, as far as the provider says. Every field is optional:
 * providers report different things, and a guessed number is worse than a gap.
 */
export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /**
   * USD. `billed` when a per-token provider charged it; `api_equivalent` when a
   * subscription CLI reports what the call would have cost at API prices — a
   * quota signal, not money spent.
   */
  costUsd?: number;
  costKind?: "billed" | "api_equivalent";
}

/** Two calls' usage together — the empty-answer re-ask is two calls. */
export function addUsage(a: ModelUsage | undefined, b: ModelUsage | undefined): ModelUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  const out: ModelUsage = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "costUsd"] as const) {
    if (a[key] !== undefined || b[key] !== undefined) out[key] = (a[key] ?? 0) + (b[key] ?? 0);
  }
  const kind = a.costKind ?? b.costKind;
  if (kind) out.costKind = kind;
  return out;
}

export type RunnerResult<T> =
  | { ok: true; value: T; attempts: number; ms: number; usage?: ModelUsage }
  | { ok: false; reason: RunnerFailure; detail?: string; attempts: number; ms: number; usage?: ModelUsage };

/**
 * A file the model has to LOOK at rather than read as text: a photographed
 * confirmation, a scanned PDF. The bytes travel to the provider as they are.
 */
export interface ModelAttachment {
  mime: string;
  bytes: Uint8Array;
}

/** What an attachment may be. Anything else is refused before a call is made. */
export const ATTACHMENT_MIMES: ReadonlySet<string> = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf",
]);

/**
 * Runners that can deliver an attachment — as verified, not as advertised.
 *
 *  - claude: `--input-format stream-json` with image and document content
 *    blocks. A synthetic booking PNG and the same page as a PDF each came back
 *    transcribed exactly, in 9–10 s (2026-09-13, Claude Code 2.1.236,
 *    claude-sonnet-5, `--tools ""`).
 *  - openrouter: OpenAI-shaped content parts. Implemented to OpenRouter's
 *    documented shape and NOT verified live — the machine that built it has no
 *    key. Whether a model reads images is that model's property; one that cannot
 *    tends to answer badly rather than refuse, which the reader's own gate has to
 *    catch.
 *  - codex: NOT here, by decision pending review. codex-cli 0.153.2 with
 *    gpt-5.6-luna transcribed a plain JPEG exactly (8 s), but answered "No text
 *    is visible in the image" for a PNG with a transparent background — a PNG
 *    claude read correctly (2026-09-13). The first probes used only such PNGs,
 *    which is why an earlier note here said codex drops images; it does not.
 *    `-i` takes images, not PDFs. OpenRouter's models failed the same
 *    transparent PNG, so transparency is a reader concern, not codex's alone.
 *  - hermes: no attachment path at all.
 */
export const ATTACHMENT_RUNNERS: ReadonlySet<string> = new Set(["claude", "openrouter"]);

/** Tasks whose every call carries attachments, so only ATTACHMENT_RUNNERS may serve them. */
export const ATTACHMENT_TASKS: ReadonlySet<string> = new Set(["read_image"]);

/** Why these attachments cannot be sent, or null when they can. */
function attachmentProblem(files: readonly ModelAttachment[]): string | null {
  const bad = files.find((file) => !ATTACHMENT_MIMES.has(file.mime));
  return bad ? `unsupported attachment type: ${bad.mime.slice(0, 60)}` : null;
}

function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

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
  /**
   * Files the model must see. An adapter that cannot deliver them refuses the
   * call — NOT_CONFIGURED, no model contacted — rather than running the prompt
   * without them, because a transcription of a file the model never saw is
   * indistinguishable from a real one.
   */
  attachments?: readonly ModelAttachment[];
}

export interface StructuredModelRunner {
  run<T>(req: StructuredModelRequest<T>): Promise<RunnerResult<T>>;
  /**
   * Which provider and model a task is pinned to, or null when the task is not
   * configured.
   *
   * For RECORDING, never for deciding. A stored extraction is keyed by the
   * configuration that produced it, so a changed model is a new reading rather
   * than a stale cache hit — and that is the only reason to ask. Nothing outside
   * this module may branch on the answer: every caller keeps its own parse and
   * validation gate precisely so that it is correct whichever provider serves
   * the task, and the choice of provider stays configuration.
   */
  describe?(task: string): { provider: string; model: string } | null;
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
  /** How `describe` names this CLI. Defaults to the binary's own name. */
  provider?: string;
  /**
   * How to read the answer out of stdout, for a CLI whose output is not the
   * answer itself. Absent: stdout is the answer.
   */
  output?: (stdout: string) => { ok: true; text: string; usage?: ModelUsage } | { ok: false; detail: string };
  /**
   * How to send attachments, for a CLI that can. Absent: a request carrying any
   * is refused rather than run without them.
   */
  attachments?: {
    args: (model: string) => string[];
    /** Written to stdin, which is then closed. */
    stdin: (prompt: string, files: readonly ModelAttachment[]) => string;
    /** The model's answer out of stdout — or the failure the CLI reported in it. */
    answer: (stdout: string) => { ok: true; text: string; usage?: ModelUsage } | { ok: false; detail: string };
  };
}

export const DEFAULT_TIMEOUT_MS = 45_000;

/** The Claude CLI's own `--effort` levels. */
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORT_LEVELS)[number];

/**
 * A task's effort from `<TASK>_EFFORT`, or undefined when unset.
 *
 * A value that is not a level THROWS. Passed through, `--effort meduim` makes
 * every call exit non-zero — FAILED — and the router quietly does less for the
 * whole interview, which is the silent downgrade this configuration keeps
 * paying for. Refusing to start is the loud version of the same mistake.
 */
export function claudeEffort(name: string, env: NodeJS.ProcessEnv = process.env): ClaudeEffort | undefined {
  const raw = (env[name] || "").trim().toLowerCase();
  if (!raw) return undefined;
  if ((CLAUDE_EFFORT_LEVELS as readonly string[]).includes(raw)) return raw as ClaudeEffort;
  throw new Error(`${name}=${JSON.stringify(env[name])} is not an effort level (${CLAUDE_EFFORT_LEVELS.join("|")})`);
}

/**
 * The Claude CLI in print mode. `-p` prints one response and exits, which is
 * the whole interaction: no session, no tools, no memory.
 *
 * WITH AN EFFORT, the call is also cut loose from every settings file and MCP
 * server the CLI would otherwise load — `--setting-sources ""` still reaches
 * the login, so nothing else is needed. Without one it inherits them, as it
 * always has: that is where its effort comes from, and on the Mac that was a
 * personal `effortLevel: xhigh` meant for coding sessions. On 2026-09-16 a
 * 4-page PDF's day-by-day extraction took 143s there against a 60s limit and
 * failed every time; at `medium` it took 53s, as it does on the VM. Settings
 * are only dropped when an effort replaces them, because the VM still takes
 * its `medium` from CLAUDE_CONFIG_DIR's settings.json, and dropping that
 * unasked would fall back to the CLI's default — the effort at which the VM
 * once mapped answers to the wrong question (2026-09-11).
 */
export function claudeSpec(
  model: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  bin = "claude",
  effort?: ClaudeEffort,
): CliSpec {
  return {
    bin,
    model,
    timeoutMs,
    maxAttempts: 2,
    // `--tools ""`: a structuring call gets no tools at all. Print mode already
    // denies anything needing permission, but still offers the read-only ones,
    // and a document is untrusted input that should not be able to ask for a
    // file read. Verified to answer normally on 2026-09-13.
    // `--output-format json`: the answer arrives inside one result object that
    // also says what the call used, so quota can be measured rather than guessed.
    //
    // The effort flags are APPENDED rather than an alternative spelling of the
    // call. Dropping tools and reading usage are wanted on every claude call;
    // the settings isolation only where an effort replaces what those settings
    // would have supplied (see the note above). One list, not two forms, so
    // that adding a flag to one and forgetting the other — which is how
    // `--tools ""` could go missing on exactly the calls that pin an effort —
    // is not a shape this function can take.
    args: (prompt, m) => [
      "-p", prompt, "--model", m, "--tools", "", "--output-format", "json",
      ...(effort ? ["--effort", effort, "--setting-sources", "", "--strict-mcp-config"] : []),
    ],
    output: claudeStreamAnswer,
    attachments: {
      args: (m) => [
        "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
        "--model", m, "--tools", "",
      ...(effort ? ["--effort", effort, "--setting-sources", "", "--strict-mcp-config"] : []),
      ],
      stdin: claudeStreamMessage,
      answer: claudeStreamAnswer,
    },
  };
}

/** One user turn for `claude -p --input-format stream-json`: the files, then the prompt. */
export function claudeStreamMessage(prompt: string, files: readonly ModelAttachment[]): string {
  const blocks = files.map((file) => ({
    type: file.mime === "application/pdf" ? "document" : "image",
    source: { type: "base64", media_type: file.mime, data: base64Of(file.bytes) },
  }));
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: [...blocks, { type: "text", text: prompt }] },
  })}\n`;
}

/**
 * The final `result` object of a `--output-format json` or `stream-json` run,
 * with what the call used. The token counts include cached input; the cost is
 * what the CLI reports the call would cost at API prices.
 */
export function claudeStreamAnswer(stdout: string): { ok: true; text: string; usage?: ModelUsage } | { ok: false; detail: string } {
  type StreamResult = {
    type?: unknown;
    subtype?: unknown;
    is_error?: unknown;
    result?: unknown;
    total_cost_usd?: unknown;
    usage?: Record<string, unknown>;
  };
  let result: StreamResult | null = null;
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as StreamResult;
      if (event.type === "result") result = event;
    } catch {
      // A partial or non-JSON line says nothing about the answer.
    }
  }
  if (!result) return { ok: false, detail: "no result event in stream" };
  if (result.is_error === true || result.subtype !== "success") {
    return { ok: false, detail: String(result.result ?? result.subtype ?? "error").slice(0, 250) };
  }
  const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const u = result.usage ?? {};
  const cached = (n(u.cache_creation_input_tokens) ?? 0) + (n(u.cache_read_input_tokens) ?? 0);
  const usage: ModelUsage = {};
  if (n(u.input_tokens) !== undefined) usage.inputTokens = n(u.input_tokens)! + cached;
  if (n(u.output_tokens) !== undefined) usage.outputTokens = n(u.output_tokens)!;
  if (n(result.total_cost_usd) !== undefined) {
    usage.costUsd = n(result.total_cost_usd)!;
    usage.costKind = "api_equivalent";
  }
  return {
    ok: true,
    text: typeof result.result === "string" ? result.result : "",
    ...(Object.keys(usage).length ? { usage } : {}),
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

type RunOnce = { ok: true; stdout: string; usage?: ModelUsage } | { ok: false; reason: RunnerFailure; detail: string };

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
 *
 * CLAUDE_CODE_OAUTH_TOKEN is the one CLAUDE_CODE_ variable that is a
 * credential, not session state, and it stays. On a Mac the CLI finds its login
 * in the keychain, so stripping it cost nothing; on the Proxmox VM the relay
 * runs in a container with no keychain, the token from `claude setup-token` is
 * the CLI's only credential, and stripping it made every interpret call exit
 * non-zero — FAILED — until the interview stalled on its first typed answer
 * (2026-09-11).
 */
export function hermeticEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) {
    if (k === "CLAUDE_CODE_OAUTH_TOKEN") {
      env[k] = v;
      continue;
    }
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
        if (!err) {
          if (!spec.output) return resolve({ ok: true, stdout: String(stdout) });
          const answer = spec.output(String(stdout));
          if (answer.ok) return resolve({ ok: true, stdout: answer.text, ...(answer.usage ? { usage: answer.usage } : {}) });
          return resolve({ ok: false, reason: isRateLimitText(answer.detail) ? "RATE_LIMITED" : "FAILED", detail: answer.detail });
        }
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
 * A CLI call whose input goes through stdin — how files reach a CLI that takes
 * them. Same hermetic directory and environment as `runOnce`, same failure
 * vocabulary.
 */
function runWithInput(spec: CliSpec, args: string[], input: string): Promise<RunOnce> {
  return new Promise((resolve) => {
    const child = spawn(spec.bin, args, { cwd: spec.cwd ?? tmpdir(), env: hermeticEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let settled = false;
    const finish = (result: RunOnce) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, reason: "TIMED_OUT", detail: `timed out (${spec.timeoutMs}ms)` });
    }, spec.timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      if (out.length < 10 * 1024 * 1024) out += d;
    });
    child.stderr?.on("data", (d: string) => {
      err = (err + d).slice(-8_000);
    });
    child.on("error", (e: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        reason: "FAILED",
        detail: e?.code === "ENOENT" ? `${spec.bin} not found` : String(e?.message ?? e).slice(0, 250),
      });
    });
    child.on("close", (code) => {
      if (code === 0) return finish({ ok: true, stdout: out });
      const tail = `${err.trim()} ${out.trim()}`.trim().slice(-250);
      if (isRateLimitText(tail)) return finish({ ok: false, reason: "RATE_LIMITED", detail: tail });
      finish({ ok: false, reason: "FAILED", detail: tail || `exit ${code}` });
    });
    // A CLI that exits before reading its input breaks the pipe; `close` reports
    // the exit, so the write error itself has nothing to add.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

async function runAttached(spec: CliSpec, prompt: string, files: readonly ModelAttachment[]): Promise<RunOnce> {
  const via = spec.attachments!;
  const out = await runWithInput(spec, via.args(spec.model), via.stdin(prompt, files));
  if (!out.ok) return out;
  const answer = via.answer(out.stdout);
  if (answer.ok) return { ok: true, stdout: answer.text, ...(answer.usage ? { usage: answer.usage } : {}) };
  return { ok: false, reason: isRateLimitText(answer.detail) ? "RATE_LIMITED" : "FAILED", detail: answer.detail };
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

/**
 * Everything a structuring call must not have, switched off on every call.
 *
 * `codex exec` loads the whole CODEX_HOME it runs under. On the machine this was
 * built on that meant a shell (`exec_command`), web access (`web__run`),
 * `apply_patch`, computer-use MCP tools, image generation, plugins and apps —
 * all offered to a model reading an untrusted document. Asked to list its tools
 * it named fourteen, and asked to transcribe a PDF it ran python over the file
 * on its own (2026-09-13). A read-only sandbox limits writes, not reading files
 * or reaching the network.
 *
 * With these flags the same model lists only `exec`, `wait` and
 * `request_user_input`, and `exec` refuses ("code-mode host is disabled").
 * Structured output, image input and extraction were probed unchanged.
 *
 * The login's own CODEX_HOME is kept deliberately. A private copy would refresh
 * the login's token in one place and lock the other copy out.
 */
export const CODEX_ISOLATION_ARGS: readonly string[] = [
  ...[
    "shell_tool", "unified_exec", "shell_snapshot", "code_mode_host",
    "apps", "plugins", "remote_plugin", "plugin_sharing",
    "browser_use", "browser_use_external", "browser_use_full_cdp_access", "in_app_browser", "computer_use",
    "hooks", "multi_agent", "image_generation", "view_image", "sleep_tool",
    "skill_search", "skill_mcp_dependency_install", "tool_suggest", "tool_call_mcp_elicitation",
  ].flatMap((feature) => ["--disable", feature]),
  "-c", "mcp_servers={}",
  "-c", "plugins={}",
  "-c", "apps={}",
  "-c", 'shell_environment_policy.inherit="none"',
];

/** The feature names CODEX_ISOLATION_ARGS disables. */
export const CODEX_ISOLATION_FEATURES: readonly string[] = CODEX_ISOLATION_ARGS.flatMap((arg, i, all) =>
  arg === "--disable" && all[i + 1] ? [all[i + 1]!] : []);

/**
 * Whether this machine's codex knows every feature the isolation disables —
 * null when it does, or what is wrong.
 *
 * Feature names are version-specific, and codex EXITS on one it does not know
 * ("Unknown feature flag"). Unchecked, a codex older or newer than the one the
 * list was written against would fail every structuring call at call time. The
 * relay is meant to ask once at startup instead, and to refuse codex bindings
 * loudly if the answer is not a clean match — never running codex with a
 * shorter list.
 *
 * NOTHING CALLS THIS ON SLICE A, and the difference matters when reading it.
 * `CODEX_ISOLATION_ARGS` IS applied to every codex call (`codexSpec`), so the
 * isolation itself is in force; what is absent is the startup check that this
 * machine's codex understands the list, because that call lives in
 * `relay/server.ts`, which is Slice B. Until Slice B lands, a version mismatch
 * shows up as codex failing every call rather than as a refusal at startup —
 * noisy, not silent, which is the safe direction, but not the intended one.
 *
 * The full isolation for #58 is PR #91 (an env allowlist and
 * `--ignore-user-config`), which is still open. This probe is what #92 has that
 * #91 does not, and the agreed plan is to land #91 first and keep this. Neither
 * half is finished while the other is open, so do not read the presence of this
 * function as #58 being closed.
 */
export function codexIsolationProblem(bin = "codex", timeoutMs = 20_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ["features", "list"], { timeout: timeoutMs, cwd: tmpdir(), env: hermeticEnv(), maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) {
        resolve(`cannot run "${bin} features list": ${String((err as NodeJS.ErrnoException).code ?? err.message).slice(0, 120)}`);
        return;
      }
      const known = new Set(String(stdout).split("\n").map((line) => line.trim().split(/\s+/)[0]).filter(Boolean));
      const missing = CODEX_ISOLATION_FEATURES.filter((feature) => !known.has(feature));
      resolve(missing.length ? `codex does not know isolation feature(s): ${missing.join(", ")}` : null);
    });
  });
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
    ...CODEX_ISOLATION_ARGS,
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
      // hermeticEnv like the other CLIs: the relay's own environment — bot
      // tokens, provider keys — is nothing a structuring call should carry.
      const child = spawn(spec.bin, args, { cwd: spec.cwd, env: hermeticEnv(), stdio: ["ignore", "pipe", "pipe"] });
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
    // Codex prints "tokens used" and the total after its transcript. It is the
    // only usage it reports; there is no per-call price on a subscription.
    const tokens = /tokens used\s*[:\n]?\s*([\d,]+)/i.exec(exited.err)?.[1];
    const total = tokens ? Number(tokens.replace(/,/g, "")) : NaN;
    return { ok: true, stdout: answer, ...(Number.isFinite(total) ? { usage: { totalTokens: total } } : {}) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function codexRunner(specs: Record<string, CodexSpec>): StructuredModelRunner {
  return {
    describe(task) {
      const spec = specs[task];
      return spec ? { provider: "codex", model: spec.model } : null;
    },
    async run<T>(req: StructuredModelRequest<T>): Promise<RunnerResult<T>> {
      const started = Date.now();
      const spec = specs[req.task];
      if (!spec) return { ok: false, reason: "NOT_CONFIGURED", attempts: 0, ms: 0 };
      // See ATTACHMENT_RUNNERS: codex was seen dropping an attached image, so it
      // is never handed one.
      if (req.attachments?.length) {
        return { ok: false, reason: "NOT_CONFIGURED", detail: "codex cannot take attachments", attempts: 0, ms: 0 };
      }
      const timeoutMs = req.timeoutMs ?? spec.timeoutMs;
      let attempts = 0;
      let last: { reason: RunnerFailure; detail: string } = { reason: "FAILED", detail: "" };
      while (attempts < spec.maxAttempts) {
        attempts += 1;
        const out = await runCodexOnce({ ...spec, timeoutMs }, req);
        if (out.ok) {
          const used = out.usage ? { usage: out.usage } : {};
          const parsed = req.parse(firstJsonObject(out.stdout));
          if (parsed !== null) return { ok: true, value: parsed, attempts, ms: Date.now() - started, ...used };
          return { ok: false, reason: "BAD_OUTPUT", detail: out.stdout.slice(0, 250), attempts, ms: Date.now() - started, ...used };
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

async function callOpenRouter(
  spec: HttpSpec,
  prompt: string,
  doFetch: Fetcher,
  files: readonly ModelAttachment[] = [],
): Promise<RunOnce> {
  // Files as content parts beside the prompt: images as data URLs, a PDF as a
  // `file` part, which is OpenRouter's documented shape for both.
  const userContent = files.length === 0
    ? prompt
    : [
        ...files.map((file) => file.mime === "application/pdf"
          ? { type: "file", file: { filename: "document.pdf", file_data: `data:application/pdf;base64,${base64Of(file.bytes)}` } }
          : { type: "image_url", image_url: { url: `data:${file.mime};base64,${base64Of(file.bytes)}` } }),
        { type: "text", text: prompt },
      ];
  const useJsonMode = spec.jsonMode && !jsonModeRefused.has(spec.model);
  const body: Record<string, unknown> = {
    model: spec.model,
    // Deterministic: this is a structuring task, not a writing one.
    temperature: 0,
    messages: [{ role: "user", content: userContent }],
    ...(useJsonMode ? { response_format: { type: "json_object" } } : {}),
    // Token counts and the charged cost come back on the response.
    usage: { include: true },
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
  // A completion that carries no message at all is the host failing, not the
  // model answering: on 2026-09-13 one minimax/minimax-m3 call came back that
  // way, and the identical request answered normally minutes later. So it is
  // retried like any upstream error — on the SAME model, never another.
  if (content === null) {
    const finish = (payload as { choices?: { finish_reason?: unknown }[] })?.choices?.[0]?.finish_reason;
    return { ok: false, reason: "UPSTREAM_ERROR", detail: `no message content in completion (finish_reason: ${String(finish ?? "none")})` };
  }
  const reported = (payload as { usage?: Record<string, unknown> })?.usage ?? {};
  const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const usage: ModelUsage = {};
  if (n(reported.prompt_tokens) !== undefined) usage.inputTokens = n(reported.prompt_tokens)!;
  if (n(reported.completion_tokens) !== undefined) usage.outputTokens = n(reported.completion_tokens)!;
  if (n(reported.total_tokens) !== undefined) usage.totalTokens = n(reported.total_tokens)!;
  if (n(reported.cost) !== undefined) {
    usage.costUsd = n(reported.cost)!;
    usage.costKind = "billed";
  }
  return { ok: true, stdout: content, ...(Object.keys(usage).length ? { usage } : {}) };
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
    describe(task) {
      const spec = specs[task];
      return spec && spec.apiKey ? { provider: "openrouter", model: spec.model } : null;
    },
    async run<T>(req: StructuredModelRequest<T>): Promise<RunnerResult<T>> {
      const started = Date.now();
      const spec = specs[req.task];
      if (!spec) return { ok: false, reason: "NOT_CONFIGURED", attempts: 0, ms: 0 };
      if (!spec.apiKey) return { ok: false, reason: "NOT_CONFIGURED", detail: "no api key", attempts: 0, ms: 0 };
      const files = req.attachments ?? [];
      const problem = attachmentProblem(files);
      if (problem) return { ok: false, reason: "FAILED", detail: problem, attempts: 0, ms: 0 };
      const timeoutMs = req.timeoutMs ?? spec.timeoutMs;
      let attempts = 0;
      let last: { reason: RunnerFailure; detail: string } = { reason: "FAILED", detail: "" };
      while (attempts < spec.maxAttempts) {
        attempts += 1;
        const out = await callOpenRouter({ ...spec, timeoutMs }, req.prompt, doFetch, files);
        if (out.ok) {
          const used = out.usage ? { usage: out.usage } : {};
          const parsed = req.parse(firstJsonObject(out.stdout));
          if (parsed !== null) return { ok: true, value: parsed, attempts, ms: Date.now() - started, ...used };
          return { ok: false, reason: "BAD_OUTPUT", detail: out.stdout.slice(0, 250), attempts, ms: Date.now() - started, ...used };
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
    describe(task) {
      const spec = specs[task];
      if (!spec) return null;
      return { provider: spec.provider ?? spec.bin.split("/").pop() ?? spec.bin, model: spec.model };
    },
    async run<T>(req: StructuredModelRequest<T>): Promise<RunnerResult<T>> {
      const started = Date.now();
      const spec = specs[req.task];
      if (!spec) return { ok: false, reason: "NOT_CONFIGURED", attempts: 0, ms: 0 };
      const files = req.attachments ?? [];
      if (files.length > 0 && !spec.attachments) {
        return { ok: false, reason: "NOT_CONFIGURED", detail: `${spec.bin} cannot take attachments`, attempts: 0, ms: 0 };
      }
      const problem = attachmentProblem(files);
      if (problem) return { ok: false, reason: "FAILED", detail: problem, attempts: 0, ms: 0 };
      const timeoutMs = req.timeoutMs ?? spec.timeoutMs;
      let attempts = 0;
      let last: { reason: RunnerFailure; detail: string } = { reason: "FAILED", detail: "" };
      while (attempts < spec.maxAttempts) {
        attempts += 1;
        const out = files.length > 0
          ? await runAttached({ ...spec, timeoutMs }, req.prompt, files)
          : await runOnce({ ...spec, timeoutMs }, req.prompt);
        if (out.ok) {
          const used = out.usage ? { usage: out.usage } : {};
          const parsed = req.parse(firstJsonObject(out.stdout));
          if (parsed !== null) return { ok: true, value: parsed, attempts, ms: Date.now() - started, ...used };
          // Bad output is not retried: the same prompt to the same pinned model
          // is the same coin flip, and the caller has a correct fallback.
          return { ok: false, reason: "BAD_OUTPUT", detail: out.stdout.slice(0, 250), attempts, ms: Date.now() - started, ...used };
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
    describe(task) {
      const runner = byTask[task];
      return runner?.describe ? runner.describe(task) : null;
    },
    async run<T>(req: StructuredModelRequest<T>): Promise<RunnerResult<T>> {
      const runner = byTask[req.task];
      if (!runner) return { ok: false, reason: "NOT_CONFIGURED", attempts: 0, ms: 0 };
      return runner.run(req);
    },
  };
}

/**
 * The OpenRouter key: `OPENROUTER_API_KEY`, or a file holding it.
 *
 * The file may hold the bare key, or be an env file with an
 * `OPENROUTER_API_KEY=` line — which is where the key already lives: Hermes
 * keeps one in `~/.hermes/.env`, and a deployment that mounts a credentials
 * env file for its agents has one there too. Pointing `OPENROUTER_API_KEY_FILE`
 * at whichever it is uses the one credential that exists instead of a second
 * copy of it; WHICH file that is, is the deployment's to say and lives in
 * `kinerary-deploy` (hard rule 6). Only that line is read; the rest of the
 * file — other providers' keys, bot tokens — is never returned.
 */
export function openRouterKey(env: NodeJS.ProcessEnv = process.env): string {
  const direct = (env.OPENROUTER_API_KEY || "").trim();
  if (direct) return direct;
  const file = (env.OPENROUTER_API_KEY_FILE || "").trim();
  if (!file) return "";
  try {
    return openRouterKeyFromFile(readFileSync(file, "utf8"));
  } catch {
    return "";
  }
}

/** The key out of a key file's contents: an `OPENROUTER_API_KEY=` line, or a file that is only the key. */
export function openRouterKeyFromFile(content: string): string {
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  const assignment = lines.find((line) => /^(export\s+)?OPENROUTER_API_KEY\s*=/.test(line));
  if (assignment) {
    let value = assignment.replace(/^(export\s+)?OPENROUTER_API_KEY\s*=\s*/, "");
    const quoted = /^(["'])(.*)\1$/.exec(value);
    value = quoted ? quoted[2]! : value.replace(/\s+#.*$/, "");
    return value.trim();
  }
  const meaningful = lines.filter((line) => line && !line.startsWith("#"));
  // A bare key file. An env file without the line holds some other secret,
  // and must never be mistaken for this one.
  return meaningful.length === 1 && !meaningful[0]!.includes("=") ? meaningful[0]! : "";
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
 * The plan-review model. MiniMax M3 for the same reason `extract` uses it:
 * the prompt is a whole leg of an itinerary plus the source document, so
 * context length is what the task is bounded by, not cleverness.
 *
 * Pinned separately from `extract` even though the default is the same value.
 * They move independently — a review that reasons about whether a day is too
 * full is a different job from reading a PDF — and sharing an id is not the
 * same as sharing a decision.
 */
export const DEFAULT_PLAN_REVIEW_MODEL = "minimax/minimax-m3";

/**
 * Never route through `openrouter/auto`. It picks a model per request, which
 * is the fallback problem wearing a different hat: two runs of the same
 * interview could be served by two different models with no signal that
 * anything varied. Named here so the reason survives someone noticing that
 * `auto` exists and looks convenient.
 */
export const FORBIDDEN_MODELS: ReadonlySet<string> = new Set(["openrouter/auto", "openrouter/auto-beta"]);

/**
 * Every task a model can be pinned to, and how the environment names it.
 *
 * The two document tasks are separate jobs — "what does this document answer"
 * and "what happens on each day" — and can be pinned to different models. Until
 * they are, each inherits `EXTRACT_*` whole: runner, model and timeout together.
 * `extract` stays a task name so anything still asking for it by that name is
 * served exactly as before.
 */
export const MODEL_TASKS: readonly {
  task: string;
  prefix: string;
  inherits?: string;
  timeoutMs: number;
  /** OpenRouter's default model for the task, where one has been chosen. */
  openRouterModel?: string;
}[] = [
  { task: "interpret", prefix: "INTERPRET", timeoutMs: DEFAULT_TIMEOUT_MS, openRouterModel: DEFAULT_INTERPRET_MODEL },
  { task: "extract", prefix: "EXTRACT", timeoutMs: 90_000, openRouterModel: DEFAULT_EXTRACT_MODEL },
  { task: "plan_review", prefix: "PLAN_REVIEW", timeoutMs: 90_000, openRouterModel: DEFAULT_PLAN_REVIEW_MODEL },
  { task: "extract_intake", prefix: "EXTRACT_INTAKE", inherits: "EXTRACT", timeoutMs: 90_000, openRouterModel: DEFAULT_EXTRACT_MODEL },
  { task: "extract_itinerary", prefix: "EXTRACT_ITINERARY", inherits: "EXTRACT", timeoutMs: 90_000, openRouterModel: DEFAULT_EXTRACT_MODEL },
  // Reading a photo or a scan. Inherits nothing: the deployed EXTRACT_* binding
  // is codex on most stacks, and codex cannot take the file (ATTACHMENT_RUNNERS).
  // No OpenRouter default either — no vision model has been measured yet.
  { task: "read_image", prefix: "VISION", timeoutMs: 90_000 },
];

/** A task's timeout: its own `<PREFIX>_TIMEOUT_MS`, else what it inherits, else its default. */
export function taskTimeoutMs(task: string, env: NodeJS.ProcessEnv = process.env): number {
  const spec = MODEL_TASKS.find((t) => t.task === task);
  if (!spec) return DEFAULT_TIMEOUT_MS;
  const own = Number(env[`${spec.prefix}_TIMEOUT_MS`]);
  if (own > 0) return own;
  const inherited = spec.inherits ? Number(env[`${spec.inherits}_TIMEOUT_MS`]) : 0;
  return inherited > 0 ? inherited : spec.timeoutMs;
}

/**
 * The runner for one pinned binding of one task, or undefined when that binding
 * cannot serve a call — an OpenRouter binding with no key, an unknown runner, or
 * a model that picks models. The one place a binding becomes a runner, whether
 * it came from the environment or from a super admin's override, so the two can
 * never disagree about what a binding means.
 */
export function runnerForBinding(
  kind: string,
  model: string,
  timeoutMs: number,
  task: string,
  env: NodeJS.ProcessEnv = process.env,
): StructuredModelRunner | undefined {
  // A model that picks a model is the fallback problem again. Refused here
  // rather than trusted to configuration, because the failure it produces is
  // silent — see FORBIDDEN_MODELS.
  if (FORBIDDEN_MODELS.has(model)) return undefined;
  // A task that always sends files, on a runner that cannot send them, would
  // fail every call — so it is not a binding at all.
  if (ATTACHMENT_TASKS.has(task) && !ATTACHMENT_RUNNERS.has(kind)) return undefined;
  // Set by the relay when codex could not confirm it knows every isolation
  // feature (codexIsolationProblem): codex is then no binding at all, rather
  // than one that fails every call or runs with tools switched on.
  if (kind === "codex" && env.KINERARY_CODEX_ISOLATION_UNVERIFIED === "1") return undefined;
  if (kind === "openrouter") {
    const key = openRouterKey(env);
    if (!key) return undefined;
    return openRouterRunner({ [task]: openRouterSpec(model, key, timeoutMs) });
  }
  if (kind === "codex") return codexRunner({ [task]: codexSpec(model, timeoutMs, { bin: env.CODEX_BIN || "codex" }) });
  // `<TASK>_EFFORT`, read here because this is now the ONE place a claude
  // binding is built. It used to be read where modelRunnerFromEnv built its own
  // runners; moving the construction without moving this would leave every call
  // taking its effort from whatever settings the process's HOME holds — which
  // is not an error, just a slower and differently-behaved model (see
  // claudeSpec, and the 143s-against-a-60s-limit run of 2026-09-16).
  if (kind === "claude") {
    return cliRunner({
      [task]: claudeSpec(model, timeoutMs, env.CLAUDE_BIN || "claude", claudeEffort(`${task.toUpperCase()}_EFFORT`, env)),
    });
  }
  if (kind === "hermes") return cliRunner({ [task]: hermesSpec(model, timeoutMs, env.HERMES_BIN || "hermes") });
  return undefined;
}

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
 *   INTERPRET_RUNNER=openrouter|codex|claude|hermes    INTERPRET_MODEL=<id|profile>
 *   EXTRACT_RUNNER=openrouter|codex|claude|hermes      EXTRACT_MODEL=<id|profile>
 *   PLAN_REVIEW_RUNNER=…                               PLAN_REVIEW_MODEL=<id|profile>
 *   EXTRACT_INTAKE_RUNNER / EXTRACT_INTAKE_MODEL       (optional; else EXTRACT_*)
 *   EXTRACT_ITINERARY_RUNNER / EXTRACT_ITINERARY_MODEL (optional; else EXTRACT_*)
 *   VISION_RUNNER=claude|openrouter  VISION_MODEL=<id> (photos and scans; unset = not read)
 *   <PREFIX>_TIMEOUT_MS
 *   <PREFIX>_EFFORT=low|medium|high|xhigh|max          (claude only — see claudeSpec)
 *
 * The two document tasks are separate jobs — "what does this document answer"
 * and "what happens on each day" — and can be pinned to different models. Until
 * they are, each inherits `EXTRACT_*` whole: runner, model and timeout together.
 * A task given its own runner never borrows another runner's model, because a
 * model id is only meaningful to the runner it was written for.
 *
 * `plan_review` unset is a visible downgrade: the post-deploy review still
 * runs its deterministic half and records why the model did not contribute.
 */
export function modelRunnerFromEnv(env: NodeJS.ProcessEnv = process.env): StructuredModelRunner | undefined {
  const byTask: Record<string, StructuredModelRunner> = {};
  const build = (kind: string, model: string, timeoutMs: number, task: string) =>
    runnerForBinding(kind, model, timeoutMs, task, env);

  // The task table is MODEL_TASKS, declared once at module scope: the per-task
  // settings surface reads the same list, and a table that existed twice is how
  // a task acquires a slightly different spelling in one of them.
  for (const { task, prefix, inherits, timeoutMs, openRouterModel } of MODEL_TASKS) {
    const own = (env[`${prefix}_RUNNER`] || "").trim().toLowerCase();
    // Inherit the whole binding or none of it — see the doc comment above.
    const source = own ? prefix : inherits && (env[`${inherits}_RUNNER`] || "").trim() ? inherits : null;
    if (!source) continue;
    const kind = (env[`${source}_RUNNER`] || "").trim().toLowerCase();
    const model =
      (env[`${source}_MODEL`] || "").trim() ||
      (kind === "openrouter" ? openRouterModel ?? "" : kind === "codex" ? CODEX_LUNA_MODEL : "");
    if (!model) continue;
    const runner = build(kind, model, Number(env[`${source}_TIMEOUT_MS`] || timeoutMs), task);
    if (runner) byTask[task] = runner;
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
    describe: () => ({ provider: "fake", model: "fake" }),
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
