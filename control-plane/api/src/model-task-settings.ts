/**
 * Switching which model serves a task, at runtime, by the super admin.
 *
 * The environment pins a model per task. This lets the one person entitled to
 * do so override a task's binding without editing provisioning.env and
 * restarting the relay — to compare providers on the same documents, or to move
 * extraction off a quota that is running low. Migration 0054 records every
 * change, and who made it.
 *
 * WHAT THIS IS NOT: a fallback. Nothing here ever picks a model on its own. An
 * override is a recorded decision, it replaces a task's binding BETWEEN calls,
 * and a call already running finishes on the model it started with — its
 * retries included, exactly as the runner's retry policy promises. Code that
 * reads documents never learns which provider served it: every caller keeps its
 * own parse and validation gate, and `describe` is for recording, not deciding.
 */
import { randomBytes } from "node:crypto";
import type pg from "pg";
import {
  ATTACHMENT_RUNNERS,
  ATTACHMENT_TASKS,
  FORBIDDEN_MODELS,
  codexIsolationProblem,
  type RunnerResult,
  type StructuredModelRequest,
  type StructuredModelRunner,
} from "./model-runner.js";
import { structuredLog } from "./redaction.js";

/** The tasks an override may name. */
export const SWITCHABLE_TASKS = ["interpret", "extract_intake", "extract_itinerary", "read_image"] as const;
export type SwitchableTask = (typeof SWITCHABLE_TASKS)[number];

export const RUNNER_KINDS = ["claude", "codex", "openrouter", "hermes"] as const;
export type RunnerKind = (typeof RUNNER_KINDS)[number];

export interface TaskBinding {
  runner: RunnerKind;
  model: string;
}

/** `runner:model`, `default`, or nothing usable. A model may itself contain colons. */
export function parseBinding(text: string): TaskBinding | "default" | null {
  const trimmed = text.trim();
  if (trimmed === "default") return "default";
  const at = trimmed.indexOf(":");
  if (at <= 0) return null;
  const runner = trimmed.slice(0, at);
  const model = trimmed.slice(at + 1).trim();
  if (!(RUNNER_KINDS as readonly string[]).includes(runner) || !model || model.length > 200) return null;
  return { runner: runner as RunnerKind, model };
}

// ── Storage ──────────────────────────────────────────────────────────────────

export async function loadTaskOverrides(db: Pick<pg.Pool, "query">): Promise<Map<string, TaskBinding>> {
  const res = await db.query<{ task: string; runner: RunnerKind; model: string }>(
    "SELECT task, runner, model FROM control_plane.model_task_settings",
  );
  return new Map(res.rows.map((row) => [row.task, { runner: row.runner, model: row.model }]));
}

/** Set a task's override, or clear it with `null`. Recorded in the history either way. */
export async function setTaskOverride(
  db: pg.Pool,
  input: { task: SwitchableTask; binding: TaskBinding | null; changedBy: string },
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if (input.binding) {
      await client.query(
        `INSERT INTO control_plane.model_task_settings (task, runner, model, changed_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (task) DO UPDATE
           SET runner = EXCLUDED.runner, model = EXCLUDED.model,
               changed_by = EXCLUDED.changed_by, changed_at = now()`,
        [input.task, input.binding.runner, input.binding.model, input.changedBy],
      );
    } else {
      await client.query("DELETE FROM control_plane.model_task_settings WHERE task = $1", [input.task]);
    }
    await client.query(
      `INSERT INTO control_plane.model_task_setting_history (id, task, runner, model, changed_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        `mts_${randomBytes(16).toString("hex")}`,
        input.task,
        input.binding?.runner ?? null,
        input.binding?.model ?? null,
        input.changedBy,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}

// ── The switchable runner ────────────────────────────────────────────────────

export type BindingSource = "override" | "environment" | "none";

export interface SwitchableRunner extends StructuredModelRunner {
  /** Replace the overrides in force. Affects calls that START after this. */
  apply(overrides: ReadonlyMap<string, TaskBinding>): void;
  /** Whether a binding can actually serve a call — checked before it is saved. */
  canServe(task: string, binding: TaskBinding): boolean;
  /** The binding a task would be served by right now, and where it comes from. */
  effective(task: string): { binding: TaskBinding | null; source: BindingSource };
}

export function isSwitchableRunner(runner: StructuredModelRunner | undefined): runner is SwitchableRunner {
  return Boolean(runner && typeof (runner as Partial<SwitchableRunner>).apply === "function");
}

/**
 * The environment's runner, with per-task overrides laid over it.
 *
 * The runner for a call is chosen once, when the call starts; `apply` swaps
 * what later calls get and never touches one in flight.
 */
export function switchableRunner(
  base: StructuredModelRunner,
  build: (task: string, binding: TaskBinding) => StructuredModelRunner | undefined,
): SwitchableRunner {
  let overrides: ReadonlyMap<string, TaskBinding> = new Map();
  const built = new Map<string, StructuredModelRunner | undefined>();
  const runnerFor = (task: string, binding: TaskBinding) => {
    const key = `${task}|${binding.runner}|${binding.model}`;
    if (!built.has(key)) built.set(key, build(task, binding));
    return built.get(key);
  };
  const override = (task: string) => {
    const binding = overrides.get(task);
    return binding ? runnerFor(task, binding) : undefined;
  };

  return {
    apply(next) {
      overrides = new Map(next);
    },
    canServe(task, binding) {
      return !FORBIDDEN_MODELS.has(binding.model) && runnerFor(task, binding) !== undefined;
    },
    effective(task) {
      const binding = overrides.get(task);
      if (binding && override(task)) return { binding, source: "override" };
      const pinned = base.describe?.(task);
      return pinned
        ? { binding: { runner: pinned.provider as RunnerKind, model: pinned.model }, source: "environment" }
        : { binding: null, source: "none" };
    },
    describe(task) {
      const chosen = override(task);
      if (chosen) return chosen.describe?.(task) ?? null;
      return base.describe ? base.describe(task) : null;
    },
    run<T>(req: StructuredModelRequest<T>): Promise<RunnerResult<T>> {
      return (override(req.task) ?? base).run(req);
    },
  };
}

/** How a codex install is checked: null when it knows every isolation feature, else what is wrong. */
export type CodexProbe = (bin: string) => Promise<string | null>;

/**
 * The relay's startup check (relay/server.ts) only runs when a `*_RUNNER` ENV
 * variable names codex. An override saved in the database — or one loaded at
 * boot on a relay with no codex in its env — reaches codex without it. This is
 * the same check for that path: if any override names codex and it has not been
 * ruled out yet, probe, and on a problem set the same
 * `KINERARY_CODEX_ISOLATION_UNVERIFIED` flag the startup check sets, so
 * `runnerForBinding` then refuses codex bindings. Fail-safe: a probe that
 * cannot run is a problem, never a pass.
 */
export async function verifyCodexOverrides(
  overrides: ReadonlyMap<string, TaskBinding>,
  log: (line: string) => void,
  probe: CodexProbe = codexIsolationProblem,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (env.KINERARY_CODEX_ISOLATION_UNVERIFIED === "1") return;
  if (![...overrides.values()].some((binding) => binding.runner === "codex")) return;
  const problem = await probe(env.CODEX_BIN || "codex");
  if (!problem) return;
  env.KINERARY_CODEX_ISOLATION_UNVERIFIED = "1";
  log(structuredLog("error", "relay.codex_isolation_unverified", {
    detail: problem,
    source: "task_override",
    hint: "codex bindings are refused until the isolation list in model-runner.ts matches this codex",
  }));
}

/** Load the overrides now and every `intervalMs` after. Returns the stop function. */
export function startTaskOverrideRefresh(
  db: pg.Pool,
  runner: SwitchableRunner,
  log: (line: string) => void,
  intervalMs = 30_000,
  codexProbe: CodexProbe = codexIsolationProblem,
): () => void {
  let refreshing = false;
  const refresh = () => {
    if (refreshing) return;
    refreshing = true;
    loadTaskOverrides(db)
      .then(async (overrides) => {
        await verifyCodexOverrides(overrides, log, codexProbe);
        runner.apply(overrides);
      })
      .catch((error) => {
        // A failed read keeps the overrides already in force rather than
        // dropping to the environment: silently reverting a recorded decision
        // is worse than keeping it one refresh longer.
        log(structuredLog("warn", "relay.model_overrides_refresh_failed", {
          detail: String((error as Error)?.message ?? error).slice(0, 200),
        }));
      })
      .finally(() => {
        refreshing = false;
      });
  };
  refresh();
  const timer = setInterval(refresh, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

// ── The command ──────────────────────────────────────────────────────────────

const USAGE = [
  "/models — which model serves each task",
  "/model <task> <runner:model> — override a task",
  "/model <task> default — back to the environment's model",
  `tasks: ${SWITCHABLE_TASKS.join(", ")}`,
  `runners: ${RUNNER_KINDS.join(", ")}`,
].join("\n");

function describeTasks(runner: SwitchableRunner): string {
  return SWITCHABLE_TASKS.map((task) => {
    const { binding, source } = runner.effective(task);
    return `${task}: ${binding ? `${binding.runner}:${binding.model}` : "(not configured)"} — ${source}`;
  }).join("\n");
}

/**
 * `/models` and `/model`, for the super admin. The caller has already verified
 * the sender; this only parses, validates, records, and applies.
 */
export async function handleModelCommand(
  db: pg.Pool,
  runner: SwitchableRunner | undefined,
  command: { name: string; argument?: string | null; args?: string },
  changedBy: string,
  log: (line: string) => void = () => {},
  codexProbe: CodexProbe = codexIsolationProblem,
): Promise<string> {
  if (!runner) return "Model switching is not available on this relay: no model runner is configured.";
  const words = (command.argument ?? command.args ?? "").trim().split(/\s+/).filter(Boolean);
  if (command.name === "models" || words.length === 0) return `${describeTasks(runner)}\n\n${USAGE}`;
  if (words.length !== 2) return USAGE;

  const [task, requested] = words as [string, string];
  if (!(SWITCHABLE_TASKS as readonly string[]).includes(task)) {
    return `Unknown task "${task}".\n\n${USAGE}`;
  }
  const binding = parseBinding(requested);
  if (binding === null) return `"${requested}" is not a runner:model.\n\n${USAGE}`;

  if (binding === "default") {
    await setTaskOverride(db, { task: task as SwitchableTask, binding: null, changedBy });
  } else {
    if (FORBIDDEN_MODELS.has(binding.model)) {
      return `${binding.model} picks a model per request, which is a silent fallback. Name a model.`;
    }
    if (!runner.canServe(task, binding)) {
      const why = ATTACHMENT_TASKS.has(task) && !ATTACHMENT_RUNNERS.has(binding.runner)
        ? ` (${task} sends files, which only ${[...ATTACHMENT_RUNNERS].join(" or ")} can take)`
        : binding.runner === "openrouter" ? " (no OpenRouter key)" : "";
      return `${binding.runner}:${binding.model} cannot serve calls on this relay${why}. Nothing changed.`;
    }
    // canServe is synchronous and only reads the flag the startup check sets,
    // which that check sets only for an env-bound codex. Ask codex itself.
    if (binding.runner === "codex") {
      const problem = await codexProbe(process.env.CODEX_BIN || "codex");
      if (problem) {
        return `${binding.runner}:${binding.model} cannot serve calls on this relay (${problem}). Nothing changed.`;
      }
    }
    await setTaskOverride(db, { task: task as SwitchableTask, binding, changedBy });
  }
  runner.apply(await loadTaskOverrides(db));
  const now = runner.effective(task);
  log(structuredLog("info", "relay.model_override_changed", {
    task,
    runner: now.binding?.runner ?? null,
    model: now.binding?.model ?? null,
    source: now.source,
  }));
  return `${task} → ${now.binding ? `${now.binding.runner}:${now.binding.model}` : "(not configured)"} (${now.source}). ` +
    "Calls that start from now on use it; one already running finishes on its own model.";
}
