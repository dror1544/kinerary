/**
 * Review a trip.config.json from the command line and print what the pass
 * would file.
 *
 * This is the honest way to see whether the review is any good, because it
 * runs the exact code the background loop runs against a real plan, on a
 * laptop, touching no trip and no container:
 *
 *   node --import tsx tools/plan-review.ts ../../trips/japan-2025/trip.config.json --destination Japan
 *
 * Add an intake and a document when you have them — the pace judgement and the
 * arrival proposal need `trip_pace` and `travel_anchors`, which live in the
 * intake and never reach trip.config.json:
 *
 *   node --import tsx tools/plan-review.ts <config.json> \
 *     --answers <intake_versions.data.json> --document <plan.txt> --destination Japan
 *
 * With no `PLAN_REVIEW_RUNNER` in the environment this prints the
 * deterministic half only, and says so. That is a smaller review, not a
 * broken one.
 */
import { readFileSync } from "node:fs";
import { modelRunnerFromEnv } from "../src/model-runner.js";
import { reviewPlan, type PlanProposal } from "../src/plan-review.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readJson(path: string | undefined): unknown {
  if (!path) return undefined;
  return JSON.parse(readFileSync(path, "utf8"));
}

const configPath = process.argv[2];
if (!configPath || configPath.startsWith("--")) {
  process.stderr.write("usage: plan-review.ts <trip.config.json> [--answers f] [--document f] [--destination name]\n");
  process.exit(2);
}

const review = await reviewPlan({
  config: readJson(configPath),
  answers: readJson(arg("answers")),
  documentText: arg("document") ? readFileSync(arg("document")!, "utf8") : "",
  destination: arg("destination") ?? "",
  runner: modelRunnerFromEnv(),
});

const byKind = new Map<string, number>();
for (const proposal of review.proposals) byKind.set(proposal.kind, (byKind.get(proposal.kind) ?? 0) + 1);

process.stdout.write(`\n${review.proposals.length} proposal(s)  ${[...byKind].map(([k, n]) => `${k}=${n}`).join("  ")}\n`);
process.stdout.write(
  `model: ${review.modelUsed ? "contributed" : `did not contribute (${review.modelSkipped ?? "nothing to add"})`}`
  + `  rejected=${review.rejected.length}\n\n`,
);

function render(proposal: PlanProposal): string {
  const head = `${proposal.severity === "warning" ? "!" : "·"} [${proposal.kind}] ${proposal.phaseId}`
    + `${proposal.date ? ` ${proposal.date}` : ""} — ${proposal.title}`;
  const lines = [head];
  if (proposal.detail) lines.push(`    ${proposal.detail}`);
  if (proposal.ask) lines.push(`    ask: ${proposal.ask}`);
  if (proposal.patch) lines.push(`    patch: ${JSON.stringify(proposal.patch)}`);
  for (const entry of proposal.evidence) lines.push(`    <${entry.source}> ${entry.quote}`);
  return lines.join("\n");
}

for (const proposal of review.proposals) process.stdout.write(`${render(proposal)}\n\n`);

for (const rejection of review.rejected) {
  process.stdout.write(`  REJECTED ${rejection.reason}: ${rejection.detail}\n`);
}
