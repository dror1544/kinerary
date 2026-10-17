/**
 * A task that inherits EXTRACT_* for its runner and model must inherit the
 * effort too. It looked up only `<ITS OWN PREFIX>_EFFORT`, so with
 * `EXTRACT_RUNNER=claude EXTRACT_EFFORT=medium` the `extract` task was isolated
 * (`--effort --setting-sources "" --strict-mcp-config`) while `extract_intake`
 * and `extract_itinerary` ran `claude -p` on untrusted documents with the
 * operator's PERSONAL settings, hooks and MCP connectors — at whatever effort
 * that settings file says (xhigh on the Mac: 143s against a 60s limit).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { claudeEffortForTask, modelRunnerFromEnv } from "../src/model-runner.js";
import { withFakeBinDir, writeFakeBin } from "./support/child-env-harness.js";

async function argvFor(env: NodeJS.ProcessEnv, task: string): Promise<string[]> {
  return withFakeBinDir("kinerary-fake-claude-effort-", async (dir) => {
    const bin = await writeFakeBin(dir, "claude", [
      "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success',",
      "  result: JSON.stringify({ argv: process.argv.slice(2) }) }));",
    ]);
    const runner = modelRunnerFromEnv({ ...env, CLAUDE_BIN: bin });
    assert.ok(runner, "a runner is built");
    const result = await runner.run({ task, prompt: "untrusted", parse: (raw: unknown) => raw as { argv: string[] } });
    assert.equal(result.ok, true, result.ok ? "" : `${result.reason}: ${result.detail}`);
    return result.ok ? result.value.argv : [];
  });
}

const EXTRACT_ENV = { EXTRACT_RUNNER: "claude", EXTRACT_MODEL: "claude-test", EXTRACT_EFFORT: "medium" };

describe("claude effort is inherited like runner and model", () => {
  for (const task of ["extract", "extract_intake", "extract_itinerary"]) {
    test(`${task} gets the effort flags AND the isolation flags from EXTRACT_EFFORT`, async () => {
      const argv = await argvFor(EXTRACT_ENV, task);
      assert.equal(argv[argv.indexOf("--effort") + 1], "medium", `${task}: --effort medium`);
      assert.ok(argv.includes("--setting-sources"), `${task}: --setting-sources (no personal settings.json)`);
      assert.ok(argv.includes("--strict-mcp-config"), `${task}: --strict-mcp-config (no MCP connectors)`);
      assert.ok(argv.includes("--tools"), `${task}: still tool-less`);
    });
  }

  test("a task's own effort wins over the inherited one", async () => {
    const argv = await argvFor({ ...EXTRACT_ENV, EXTRACT_INTAKE_EFFORT: "high" }, "extract_intake");
    assert.equal(argv[argv.indexOf("--effort") + 1], "high");
  });

  test("the vision task reads VISION_EFFORT, not READ_IMAGE_EFFORT", () => {
    assert.equal(claudeEffortForTask("read_image", { VISION_EFFORT: "low" }), "low");
  });

  test("an unrecognised effort still refuses to start", () => {
    assert.throws(() => claudeEffortForTask("extract_intake", { EXTRACT_EFFORT: "meduim" }), /not an effort level/);
  });

  test("a claude binding with NO effort anywhere is announced, naming the task and the variable", async () => {
    const lines: string[] = [];
    const original = console.warn;
    console.warn = (line: unknown) => { lines.push(String(line)); };
    try {
      modelRunnerFromEnv({ EXTRACT_RUNNER: "claude", EXTRACT_MODEL: "claude-test-unset" });
    } finally {
      console.warn = original;
    }
    const text = lines.join("\n");
    assert.match(text, /claude_effort_unset/);
    for (const task of ["extract", "extract_intake", "extract_itinerary"]) assert.ok(text.includes(`"task":"${task}"`), `names ${task}`);
    assert.match(text, /EXTRACT_EFFORT/);
  });
});
