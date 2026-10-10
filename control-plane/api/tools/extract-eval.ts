/**
 * The document extraction benchmark: the same golden scenarios, through the same
 * per-document path and gate as production, once per provider and repetition.
 *
 *   node --import tsx tools/extract-eval.ts \
 *     --scenario japan --scenario multi \
 *     --provider claude:claude-sonnet-5 --provider codex:gpt-5.6-luna \
 *     --reps 3 [--out results.jsonl] [--keep-readings]
 *
 * `--keep-readings` adds each document's text and the model's answer to the row,
 * so a change to the gate can be re-measured on the same answers without new
 * model calls.
 *
 * WHAT IT MEASURES, per run: which expected questions were answered, which
 * expected stops and places reached the answers, duplicate stops (a false
 * split), disagreements and ambiguities the gate reported, latency per
 * document, attempts, and failures. The expectations are read out of
 * `test/fixtures/make_documents.py` at run time — the same `SCENARIOS` the
 * documents are generated from — so a document and what is asserted about it
 * cannot drift apart.
 *
 * WHAT IT DOES NOT MEASURE, and says so: token cost. The CLI runners (claude,
 * codex) report no usage, and a subscription CLI has no marginal price to
 * attribute; OpenRouter bills per token, but the runner does not surface usage
 * either. Cost is printed as "unmeasured" rather than estimated. A number
 * nobody measured is worse than none.
 *
 * A HARNESS, not a test: it calls live models, takes minutes, and spends whatever
 * the providers charge. It needs no database.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { identityFold, isRecord, sameVisit } from "../src/answer-merge.js";
import { documentText } from "../src/document-text.js";
import { gateDocumentProposals, type DocumentReading } from "../src/document-gate.js";
import { DOCUMENT_ANSWERABLE_QUESTION_IDS, EXTRACT_INTAKE_TASK, extractIntakeFromDocument } from "../src/interpret.js";
import { INTAKE_QUESTIONS, partitionQuestions } from "../src/interview.js";
import {
  claudeSpec,
  cliRunner,
  codexRunner,
  codexSpec,
  openRouterKey,
  openRouterRunner,
  openRouterSpec,
  type StructuredModelRunner,
} from "../src/model-runner.js";

const FIXTURES = fileURLToPath(new URL("../test/fixtures/", import.meta.url));
const TIMEOUT_MS = 240_000;

interface Scenario {
  expect_answers?: string[];
  expect_in_phases?: string[];
  expect_planned?: string[];
  /** Each stop with its exact dates — the fact-level label. */
  expect_stops?: { name: string; start: string; end: string }[];
  /** Booking references the documents really carry. */
  expect_refs?: string[];
  /** Numbers that must never become a booking reference (a quote number). */
  forbid_refs?: string[];
}

/** A reference as matching compares it: case, spaces and dashes aside. */
const refFold = (value: string) => identityFold(value).replace(/[\s-]/g, "");

/** Every booking reference anywhere in the accepted answers. */
function referencesIn(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) referencesIn(item, out);
  else if (isRecord(value)) {
    for (const [key, field] of Object.entries(value)) {
      if (/^(confirmation|reference|booking_reference|pnr)$/i.test(key) && typeof field === "string" && field.trim()) out.push(field);
      else referencesIn(field, out);
    }
  }
  return out;
}

/**
 * Facts against the label: stops with exact dates, false merges (one stop whose
 * dates cover two or more labelled stops), false splits (a labelled stop found
 * as two overlapping entries), stops nobody labelled, and references found,
 * invented or forbidden. Null fields when the scenario carries no such label.
 */
function factMetrics(expected: Scenario, phases: Record<string, unknown>[], anchors: Record<string, unknown>[]) {
  const stops = expected.expect_stops;
  const nameOf = (entry: Record<string, unknown>) => identityFold(String(entry.name_en ?? entry.name ?? ""));
  const overlaps = (a: Record<string, unknown>, b: { start: string; end: string }) =>
    typeof a.start === "string" && typeof a.end === "string" && a.start < b.end && b.start < a.end;
  const stopFacts = stops
    ? {
        stops_exact: `${stops.filter((s) => phases.some((p) => nameOf(p) === identityFold(s.name) && p.start === s.start && p.end === s.end)).length}/${stops.length}`,
        stops_wrong_dates: stops
          .filter((s) => phases.some((p) => nameOf(p) === identityFold(s.name)))
          .filter((s) => !phases.some((p) => nameOf(p) === identityFold(s.name) && p.start === s.start && p.end === s.end))
          .map((s) => s.name),
        stops_missing: stops.filter((s) => !phases.some((p) => nameOf(p) === identityFold(s.name))).map((s) => s.name),
        false_merges: phases.filter((p) => stops.filter((s) => overlaps(p, s)).length >= 2).length,
        false_splits: stops.filter((s) =>
          phases.filter((p) => nameOf(p) === identityFold(s.name) && (typeof p.start !== "string" || overlaps(p, s))).length >= 2,
        ).length,
        extra_stops: phases.filter((p) => !stops.some((s) => identityFold(s.name) === nameOf(p))).map((p) => String(p.name ?? "")),
      }
    : { stops_exact: null, stops_wrong_dates: null, stops_missing: null, false_merges: null, false_splits: null, extra_stops: null };

  const found = [...new Set(referencesIn([phases, anchors]).map(refFold))];
  const expectedRefs = (expected.expect_refs ?? []).map(refFold);
  const forbidden = (expected.forbid_refs ?? []).map(refFold);
  const refFacts = expected.expect_refs
    ? {
        refs_found: `${expectedRefs.filter((r) => found.includes(r)).length}/${expectedRefs.length}`,
        invented_refs: found.filter((r) => !expectedRefs.includes(r)),
        forbidden_refs: found.filter((r) => forbidden.includes(r)),
      }
    : { refs_found: null, invented_refs: null, forbidden_refs: null };
  return { ...stopFacts, ...refFacts };
}

type Usage = { inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsd?: number; costKind?: string };

function sumUsage(list: readonly (Usage | undefined)[]): Usage | null {
  const present = list.filter((u): u is Usage => Boolean(u));
  if (present.length === 0) return null;
  const out: Usage = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "costUsd"] as const) {
    if (present.some((u) => u[key] !== undefined)) out[key] = present.reduce((n, u) => n + (u[key] ?? 0), 0);
  }
  const kind = present.find((u) => u.costKind)?.costKind;
  if (kind) out.costKind = kind;
  return out;
}

function args(): { scenarios: string[]; providers: string[]; reps: number; out: string | null } {
  const argv = process.argv.slice(2);
  const all = (flag: string) => argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]!] : []));
  const scenarios = all("--scenario");
  const providers = all("--provider");
  const reps = Number(all("--reps")[0] ?? "1");
  if (scenarios.length === 0 || providers.length === 0 || !Number.isInteger(reps) || reps < 1) {
    console.error("usage: extract-eval.ts --scenario <name>… --provider <runner:model>… [--reps N] [--out file.jsonl]");
    process.exit(2);
  }
  return { scenarios, providers, reps, out: all("--out")[0] ?? null };
}

/** One provider, pinned to the intake-extraction task only — never a fallback chain. */
function runnerFor(provider: string): StructuredModelRunner {
  const [kind, ...rest] = provider.split(":");
  const model = rest.join(":");
  if (!model) throw new Error(`provider ${provider} needs a model: runner:model`);
  if (kind === "claude") return cliRunner({ [EXTRACT_INTAKE_TASK]: claudeSpec(model, TIMEOUT_MS) });
  if (kind === "codex") return codexRunner({ [EXTRACT_INTAKE_TASK]: codexSpec(model, TIMEOUT_MS) });
  if (kind === "openrouter") {
    const key = openRouterKey();
    if (!key) throw new Error("openrouter needs OPENROUTER_API_KEY or OPENROUTER_API_KEY_FILE");
    return openRouterRunner({ [EXTRACT_INTAKE_TASK]: openRouterSpec(model, key, TIMEOUT_MS) });
  }
  throw new Error(`unknown runner ${kind} (claude | codex | openrouter)`);
}

function scenarioExpectations(name: string): Scenario {
  const script = [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(FIXTURES)})`,
    "from make_documents import SCENARIOS",
    "print(json.dumps(SCENARIOS[sys.argv[1]]))",
  ].join("\n");
  return JSON.parse(execFileSync("python3", ["-c", script, name], { encoding: "utf8" })) as Scenario;
}

async function scenarioDocuments(name: string): Promise<{ dir: string; files: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), `extract-eval-${name}-`));
  execFileSync("python3", [join(FIXTURES, "make_documents.py"), name, dir], { stdio: "ignore" });
  const files = (await readdir(dir)).filter((f) => !f.startsWith(".")).sort().map((f) => join(dir, f));
  return { dir, files };
}

function structuredData(answer: unknown): unknown[] {
  return isRecord(answer) && answer.kind === "structured" && Array.isArray(answer.data) ? answer.data : [];
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

const { scenarios, providers, reps, out } = args();
const keepReadings = process.argv.includes("--keep-readings");
const { outstanding } = partitionQuestions({}, INTAKE_QUESTIONS);
const rows: Record<string, unknown>[] = [];

for (const scenario of scenarios) {
  const expected = scenarioExpectations(scenario);
  const { dir, files } = await scenarioDocuments(scenario);
  try {
    for (const provider of providers) {
      const runner = runnerFor(provider);
      for (let rep = 1; rep <= reps; rep += 1) {
        const perDocument: Record<string, unknown>[] = [];
        const readings: DocumentReading[] = [];
        for (const file of files) {
          const read = await documentText(new Uint8Array(await readFile(file)), undefined, basename(file));
          if (!read.ok) {
            perDocument.push({ file: basename(file), ok: false, reason: read.reason });
            continue;
          }
          const started = Date.now();
          const result = await extractIntakeFromDocument(runner, {
            documentText: read.text,
            outstanding: DOCUMENT_ANSWERABLE_QUESTION_IDS,
            language: "he",
            timeoutMs: TIMEOUT_MS,
          });
          const ms = Date.now() - started;
          perDocument.push({
            file: basename(file),
            ok: result.ok,
            ms,
            attempts: result.attempts,
            ...(result.ok
              ? { proposals: result.payload.proposals.length, malformed: result.payload.malformed }
              : { reason: result.reason }),
            ...(result.usage ? { usage: result.usage } : {}),
          });
          if (result.ok) readings.push({ documentId: basename(file), text: read.text, payload: result.payload });
        }

        const { decisions } = gateDocumentProposals(readings, { outstanding, answered: [] });
        const answered = decisions.accepted.map((a) => a.questionId);
        const answerOf = (id: string) => decisions.accepted.find((a) => a.questionId === id)?.answer;
        const phases = structuredData(answerOf("phases")).filter(isRecord);
        const anchors = structuredData(answerOf("travel_anchors")).filter(isRecord);
        const haystack = identityFold(JSON.stringify([phases, anchors]));
        const found = (names: string[] | undefined) =>
          (names ?? []).filter((name) => haystack.includes(identityFold(name)));
        // A stop split in two: the same place on overlapping dates, twice.
        const duplicates = phases.filter((stop, i) =>
          phases.some((other, j) => j < i && identityFold(String(other.name ?? "")) === identityFold(String(stop.name ?? "")) && sameVisit(other, stop)),
        ).length;

        const expectAnswers = expected.expect_answers ?? [];
        const row = {
          scenario,
          provider,
          rep,
          documents: files.length,
          extracted: readings.length,
          failed: perDocument.filter((d) => d.ok === false).length,
          answered,
          // The share of expected questions the documents actually answered.
          answer_recall: expectAnswers.length ? expectAnswers.filter((q) => answered.includes(q)).length / expectAnswers.length : null,
          stops_found: `${found(expected.expect_in_phases).length}/${(expected.expect_in_phases ?? []).length}`,
          places_found: `${found(expected.expect_planned).length}/${(expected.expect_planned ?? []).length}`,
          duplicate_stops: duplicates,
          ...factMetrics(expected, phases, anchors),
          conflicts: decisions.conflicts.length,
          ambiguous: decisions.ambiguous.length,
          // What disagreed with what. A golden scenario whose documents agree
          // should report none, so every entry here is worth reading.
          conflict_detail: decisions.conflicts.map((c) => JSON.stringify(c).slice(0, 400)),
          rejected: decisions.rejected.map((r) => `${r.questionId}:${r.reason}`),
          per_document: perDocument,
          failures_by_reason: perDocument
            .filter((d) => d.ok === false)
            .reduce<Record<string, number>>((acc, d) => ({ ...acc, [String(d.reason)]: (acc[String(d.reason)] ?? 0) + 1 }), {}),
          bad_output: perDocument.filter((d) => d.reason === "BAD_OUTPUT").length,
          malformed_proposals: perDocument.reduce((n, d) => n + Number(d.malformed ?? 0), 0),
          // Runner retries of the pinned model (transient failures only).
          retries: perDocument.reduce((n, d) => n + Math.max(0, Number(d.attempts ?? 1) - 1), 0),
          usage: sumUsage(perDocument.map((d) => d.usage as Usage | undefined)),
          // The model's answers themselves, so the gate can be re-run on them
          // without paying for the calls again. Opt-in: a real document's
          // answers are that document's contents.
          ...(keepReadings ? { readings: readings.map((r) => ({ documentId: r.documentId, text: r.text, payload: r.payload })) } : {}),
        };
        // `answer_recall` is a ratio of expected questions actually answered.
        row.answer_recall = expectAnswers.length ? expectAnswers.filter((q) => answered.includes(q)).length / expectAnswers.length : null;
        rows.push(row);
        console.log(JSON.stringify(row));
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log("\n=== summary ===");
for (const scenario of scenarios) {
  for (const provider of providers) {
    const mine = rows.filter((r) => r.scenario === scenario && r.provider === provider);
    const latencies = mine.flatMap((r) => (r.per_document as { ms?: number }[]).flatMap((d) => (typeof d.ms === "number" ? [d.ms] : [])));
    const documents = mine.reduce((n, r) => n + (r.documents as number), 0);
    const failed = mine.reduce((n, r) => n + (r.failed as number), 0);
    const recall = mine.map((r) => r.answer_recall).filter((v): v is number => typeof v === "number");
    const total = (key: string) => mine.reduce((n, r) => n + (typeof r[key] === "number" ? (r[key] as number) : 0), 0);
    const listed = (key: string) => mine.reduce((n, r) => n + (Array.isArray(r[key]) ? (r[key] as unknown[]).length : 0), 0);
    const usage = sumUsage(mine.map((r) => (r.usage as Usage | null) ?? undefined));
    console.log(
      `${scenario.padEnd(8)} ${provider.padEnd(34)} runs ${mine.length}` +
        `  recall ${recall.length ? (recall.reduce((a, b) => a + b, 0) / recall.length).toFixed(2) : "n/a"}` +
        `  stops ${mine.map((r) => r.stops_found).join(" ")}` +
        `  exact ${mine.map((r) => r.stops_exact ?? "-").join(" ")}` +
        `  refs ${mine.map((r) => r.refs_found ?? "-").join(" ")}` +
        `  places ${mine.map((r) => r.places_found).join(" ")}` +
        `  merges ${total("false_merges")} splits ${total("false_splits")} dup ${total("duplicate_stops")}` +
        `  invented_refs ${listed("invented_refs")} forbidden ${listed("forbidden_refs")} conflicts ${total("conflicts")}` +
        `  p50 ${percentile(latencies, 50) ?? "n/a"}ms p95 ${percentile(latencies, 95) ?? "n/a"}ms` +
        `  failed ${failed}/${documents} bad_output ${total("bad_output")} malformed ${total("malformed_proposals")} retries ${total("retries")}` +
        `  tokens ${usage?.totalTokens ?? ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) || "n/a")}` +
        `  cost ${usage?.costUsd !== undefined ? `$${usage.costUsd.toFixed(4)} (${usage.costKind})` : "not reported"}`,
    );
  }
}

if (out) await writeFile(out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
