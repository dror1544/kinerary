/**
 * Real documents, read and turned into intake answers the way the relay does it.
 *
 *   EXTRACT_RUNNER=claude EXTRACT_MODEL=claude-sonnet-5 \
 *     node --import tsx tools/extract-intake-check.ts <file-or-folder>
 *
 * Each file is read and extracted ON ITS OWN, then every reading meets in the one
 * shared gate — the same path `runDocumentPath` takes, minus the database. It
 * prints what the model proposed for each document, then what the gate did with
 * all of them together, because the second half is the point: a document is not
 * a privileged source, and `validateAnswer` decides.
 *
 * No database and no store: nothing is kept, and nothing here is a stored
 * reading. For the numbers across providers and repetitions, use
 * `tools/extract-eval.ts`.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { documentText } from "../src/document-text.js";
import { gateDocumentProposals, type DocumentReading } from "../src/document-intake.js";
import {
  DOCUMENT_ANSWERABLE_QUESTION_IDS,
  EXTRACT_INTAKE_TASK,
  extractIntakeFromDocument,
} from "../src/interpret.js";
import { INTAKE_QUESTIONS, partitionQuestions } from "../src/interview.js";
import { codexRunner, codexSpec, CODEX_LUNA_MODEL, modelRunnerFromEnv } from "../src/model-runner.js";

const path = process.argv[2];
if (!path) {
  console.error("usage: extract-intake-check.ts <file-or-folder>");
  process.exit(2);
}

const info = await stat(path);
const entries = info.isDirectory()
  ? (await readdir(path)).filter((f) => !f.startsWith(".")).sort().map((f) => join(path, f))
  : [path];
// Directories turn up inside a real folder (a cache, a subfolder) and readFile
// on one throws — which would end the run rather than skip an entry.
const files: string[] = [];
for (const entry of entries) {
  if ((await stat(entry)).isFile()) files.push(entry);
  else console.log(`  SKIP ${basename(entry)}: not a file`);
}

// The CONFIGURED runner first, so this reproduces what the relay actually does.
// With no environment it falls back to Codex — registered under the task the
// extractor actually asks for, which is what a fallback keyed to the old shared
// "extract" name silently failed to do.
const runner = modelRunnerFromEnv() ?? codexRunner({ [EXTRACT_INTAKE_TASK]: codexSpec(CODEX_LUNA_MODEL, 240_000) });
const pinned = runner.describe?.(EXTRACT_INTAKE_TASK);
console.log(`runner: ${pinned ? `${pinned.provider} ${pinned.model}` : "(not configured)"}\n`);

const readings: DocumentReading[] = [];
for (const file of files) {
  const bytes = new Uint8Array(await readFile(file));
  const read = await documentText(bytes, undefined, basename(file));
  if (!read.ok) {
    console.log(`  SKIP ${basename(file)}: ${read.reason}${read.detail ? ` — ${read.detail}` : ""}`);
    continue;
  }
  const unread = read.coverage.filter((u) => !u.usable || u.cut).length;
  console.log(
    `  read ${basename(file)}: ${read.pages}p ${read.text.length}ch` +
      `${read.truncated ? " TRUNCATED" : ""}${unread ? ` ${unread} unit(s) unread` : ""}`,
  );

  const started = Date.now();
  const result = await extractIntakeFromDocument(runner, {
    documentText: read.text,
    outstanding: DOCUMENT_ANSWERABLE_QUESTION_IDS,
    language: "he",
    timeoutMs: 240_000,
  });
  const ms = Date.now() - started;
  if (!result.ok) {
    console.log(`    extract failed after ${ms}ms: ${result.reason} ${result.detail ?? ""}\n`);
    continue;
  }
  console.log(`    ${result.payload.proposals.length} proposal(s), ${result.payload.malformed} malformed, ${ms}ms, ${result.attempts} attempt(s)`);
  for (const p of result.payload.proposals) {
    console.log(`      ${p.questionId.padEnd(16)} conf ${p.confidence.toFixed(2)}  ${JSON.stringify(p.value).slice(0, 110)}`);
  }
  console.log("");
  readings.push({ documentId: basename(file), text: read.text, payload: result.payload });
}

if (readings.length === 0) {
  console.error("nothing was read and extracted");
  process.exit(1);
}

// The gate, across every document at once — as if this were a fresh interview.
const { outstanding } = partitionQuestions({}, INTAKE_QUESTIONS);
const { decisions, sources } = gateDocumentProposals(readings, { outstanding, answered: [] });

console.log(`=== the gate, across ${readings.length} document(s) ===`);
console.log(`accepted (${decisions.accepted.length}):`);
for (const a of decisions.accepted) {
  console.log(`  ${a.questionId.padEnd(16)} from ${(sources.get(a.questionId) ?? []).join(", ")}`);
  console.log(`  ${" ".repeat(16)} ${JSON.stringify(a.answer).slice(0, 140)}`);
}
console.log(`rejected (${decisions.rejected.length}):`);
for (const r of decisions.rejected) console.log(`  ${r.questionId.padEnd(16)} ${r.reason}${r.detail ? ` — ${r.detail}` : ""}`);
if (decisions.conflicts.length) {
  console.log(`conflicts (${decisions.conflicts.length}):`);
  for (const c of decisions.conflicts) console.log(`  ${c.questionId} ${c.entryKey} ${c.path}: ${JSON.stringify(c.held)} vs ${JSON.stringify(c.incoming)}`);
}
if (decisions.ambiguous.length) {
  console.log(`ambiguous (${decisions.ambiguous.length}): ${decisions.ambiguous.map((a) => `${a.questionId}:${a.entryKey}`).join(", ")}`);
}
console.log(`still to ask (${decisions.askAnyway.length}): ${decisions.askAnyway.join(", ")}`);
