/**
 * The group judge's offline benchmark: a labelled JSONL set through the judge
 * binding the environment configures, scored for precision, recall, latency and
 * errors against the owner's targets (precision >= 90%, recall >= 75%, p95 <=
 * 1.5 s, hard timeout 3 s). See src/relay/group-judge-benchmark.ts.
 *
 *   JUDGE_RUNNER=openrouter JUDGE_MODEL=<model id> OPENROUTER_API_KEY=... \
 *     node --import tsx tools/judge-benchmark.ts \
 *     [--set tools/judge-benchmark/starter-set.jsonl] [--reps 1] \
 *     [--min-confidence 0.7] [--names "Solo,סולו"] [--timeout-ms 3000] \
 *     [--json] [--strict]
 *
 * Uses the SAME binding the relay would (`modelRunnerFromEnv`, task
 * `group_judge`): JUDGE_RUNNER / JUDGE_MODEL / JUDGE_TIMEOUT_MS, including the
 * OpenRouter provider routing with data collection denied. Compare candidate
 * models by running it once per JUDGE_MODEL.
 *
 * A HARNESS, not a test: it calls a live model and spends whatever it costs (a
 * free model costs nothing but is rate limited, and a rate limit shows up here
 * as errors). The test suite never runs it against the network - the unit test
 * drives the same code with a fake runner. It prints case ids, never message
 * text. `--strict` exits 1 when a target is missed.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { modelRunnerFromEnv } from "../src/model-runner.js";
import { formatReport, parseCases, runBenchmark } from "../src/relay/group-judge-benchmark.js";

function flags(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq >= 0) out.set(arg.slice(2, eq), arg.slice(eq + 1));
    else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) { out.set(arg.slice(2), argv[i + 1]!); i += 1; }
    else out.set(arg.slice(2), "true");
  }
  return out;
}

async function main(): Promise<void> {
  const f = flags(process.argv.slice(2));
  const setPath = f.get("set") ?? fileURLToPath(new URL("./judge-benchmark/starter-set.jsonl", import.meta.url));
  const runner = modelRunnerFromEnv();
  if (!runner?.describe?.("group_judge")) {
    console.error("the group_judge task has no binding: set JUDGE_RUNNER and JUDGE_MODEL (and OPENROUTER_API_KEY for openrouter)");
    process.exitCode = 2;
    return;
  }
  const cases = parseCases(await readFile(setPath, "utf8"));
  const names = (f.get("names") ?? "Solo,סולו").split(",").map((n) => n.trim()).filter(Boolean);
  const report = await runBenchmark({
    runner,
    cases,
    assistantNames: names,
    reps: Number(f.get("reps") ?? "1"),
    ...(f.get("min-confidence") ? { minConfidence: Number(f.get("min-confidence")) } : {}),
    ...(f.get("timeout-ms") ? { timeoutMs: Number(f.get("timeout-ms")) } : {}),
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) process.stderr.write(`\r${done}/${total}`);
    },
  });
  process.stderr.write("\n");
  console.log(f.has("json") ? JSON.stringify(report, null, 2) : formatReport(report));
  if (f.get("out")) await writeFile(f.get("out")!, JSON.stringify(report, null, 2));
  if (f.has("strict") && !report.meetsTargets.allMet) process.exitCode = 1;
}

await main();
