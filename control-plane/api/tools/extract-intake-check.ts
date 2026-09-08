/**
 * A real document, read and turned into intake answers, end to end.
 *
 *   INTERPRET_RUNNER=codex node --import tsx tools/extract-intake-check.ts <file>
 *
 * Prints what the model proposed, then what the gate did with each proposal —
 * because the second half is the point. A document is not a privileged source:
 * it produces proposals, and `validateAnswer` decides, exactly as it does for
 * something typed.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { documentText } from "../src/document-text.js";
import { extractIntakeFromDocument, applyProposals } from "../src/interpret.js";
import { INTAKE_QUESTIONS, partitionQuestions } from "../src/interview.js";
import { codexRunner, codexSpec, CODEX_LUNA_MODEL } from "../src/model-runner.js";

const path = process.argv[2];
if (!path) {
  console.error("usage: extract-intake-check.ts <file>");
  process.exit(2);
}

const bytes = new Uint8Array(await readFile(path));
const doc = await documentText(bytes, undefined, basename(path));
if (!doc.ok) {
  console.error(`could not read: ${doc.reason} ${doc.detail ?? ""}`);
  process.exit(1);
}
console.log(`read ${basename(path)}: ${doc.pages} pages, ${doc.text.length} chars${doc.truncated ? " (truncated)" : ""}\n`);

const { outstanding } = partitionQuestions({}, INTAKE_QUESTIONS);
const runner = codexRunner({ extract: codexSpec(CODEX_LUNA_MODEL, 240_000) });

const started = Date.now();
const result = await extractIntakeFromDocument(runner, {
  documentText: doc.text,
  outstanding,
  language: "he",
  timeoutMs: 240_000,
});
const ms = Date.now() - started;

if (!result.ok) {
  console.error(`extract failed after ${ms}ms: ${result.reason} ${result.detail ?? ""}`);
  process.exit(1);
}

console.log(`=== proposed in ${ms}ms (${result.payload.proposals.length} proposals, ${result.payload.malformed} malformed) ===`);
for (const p of result.payload.proposals) {
  const v = JSON.stringify(p.value).slice(0, 120);
  console.log(`  ${p.questionId.padEnd(18)} conf ${p.confidence.toFixed(2)}  ${v}`);
  console.log(`  ${" ".repeat(18)} evidence: ${JSON.stringify(p.evidence.slice(0, 90))}`);
}
if (result.payload.unclear.length) {
  console.log(`\nunclear: ${result.payload.unclear.map((u) => `${u.questionId} (${u.why})`).join(", ")}`);
}

// The gate. Evidence is checked against the document it came from.
const decisions = applyProposals(result.payload.proposals, {
  sourceText: doc.text,
  outstanding,
  answered: [],
});

console.log(`\n=== the gate ===`);
console.log(`accepted (${decisions.accepted.length}):`);
for (const a of decisions.accepted) console.log(`  ${a.questionId.padEnd(18)} ${JSON.stringify(a.answer).slice(0, 130)}`);
console.log(`rejected (${decisions.rejected.length}):`);
for (const r of decisions.rejected) console.log(`  ${r.questionId.padEnd(18)} ${r.reason}${r.detail ? ` — ${r.detail}` : ""}`);
console.log(`still to ask (${decisions.askAnyway.length}): ${decisions.askAnyway.join(", ")}`);
