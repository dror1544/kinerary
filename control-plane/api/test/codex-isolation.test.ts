/**
 * A codex structuring call runs with no tools — asserted on the actual process.
 *
 * `codex exec` offers whatever its CODEX_HOME configures, and on 2026-09-13 that
 * was a shell, web access, apply_patch and computer-use tools, handed to a model
 * reading an untrusted document. The runner switches every one off per call.
 * This test runs the runner against a fake `codex` that records its arguments
 * and environment, so a flag dropped in a refactor fails here rather than in a
 * transcript nobody reads.
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  CODEX_ISOLATION_ARGS,
  CODEX_ISOLATION_FEATURES,
  codexIsolationProblem,
  codexRunner,
  codexSpec,
  runnerForBinding,
} from "../src/model-runner.js";

describe("codexIsolationProblem", () => {
  const fakeFeatures = async (lines: string[]) => {
    const dir = await mkdtemp(join(tmpdir(), "kinerary-fake-codex-features-"));
    const bin = join(dir, "codex");
    await writeFile(bin, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(lines.join("\n") + "\n")});\n`);
    await chmod(bin, 0o755);
    return { dir, bin };
  };

  test("a codex that knows every isolation feature is fine; one missing a name is named", async () => {
    const all = await fakeFeatures(CODEX_ISOLATION_FEATURES.map((f) => `${f}   stable   true`));
    const short = await fakeFeatures(CODEX_ISOLATION_FEATURES.slice(1).map((f) => `${f}   stable   true`));
    try {
      assert.equal(await codexIsolationProblem(all.bin), null);
      assert.match(await codexIsolationProblem(short.bin) ?? "", new RegExp(CODEX_ISOLATION_FEATURES[0]!));
      assert.match(await codexIsolationProblem(join(all.dir, "nope")) ?? "", /cannot run/);
    } finally {
      await rm(all.dir, { recursive: true, force: true });
      await rm(short.dir, { recursive: true, force: true });
    }
  });

  test("an unverified codex is no binding at all", () => {
    assert.ok(runnerForBinding("codex", "gpt-5.6-luna", 1000, "extract_intake", {}));
    assert.equal(runnerForBinding("codex", "gpt-5.6-luna", 1000, "extract_intake", { KINERARY_CODEX_ISOLATION_UNVERIFIED: "1" }), undefined);
    assert.ok(runnerForBinding("claude", "claude-sonnet-5", 1000, "extract_intake", { KINERARY_CODEX_ISOLATION_UNVERIFIED: "1" }), "other runners unaffected");
  });

  test("the probe agrees with the codex installed here, when there is one", async () => {
    const problem = await codexIsolationProblem("codex");
    if (problem?.startsWith("cannot run")) return; // no codex on this machine
    assert.equal(problem, null, "the isolation list must match the installed codex");
  });
});

describe("codex isolation", () => {
  test("every call disables the tool features, empties MCP/plugins/apps, and carries no relay secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kinerary-fake-codex-"));
    const previous = process.env.KINERARY_TEST_SECRET;
    process.env.KINERARY_TEST_SECRET = "must-not-reach-codex";
    try {
      const bin = join(dir, "codex");
      await writeFile(bin, [
        "#!/usr/bin/env node",
        "const argv = process.argv.slice(2);",
        "const out = argv[argv.indexOf('-o') + 1];",
        "require('fs').writeFileSync(out, JSON.stringify({ argv, secret: process.env.KINERARY_TEST_SECRET ?? null, claude: process.env.CLAUDE_CODE_ENTRYPOINT ?? null }));",
      ].join("\n"));
      await chmod(bin, 0o755);
      const runner = codexRunner({ extract_intake: codexSpec("gpt-5.6-luna", 20_000, { bin }) });
      const res = await runner.run({
        task: "extract_intake",
        prompt: "extract",
        parse: (raw: unknown) => raw as { argv: string[]; secret: string | null },
      });
      assert.equal(res.ok, true, res.ok ? "" : `${res.reason} ${res.detail}`);
      if (!res.ok) return;
      const { argv } = res.value;

      for (const feature of ["shell_tool", "unified_exec", "code_mode_host", "apps", "plugins", "browser_use", "computer_use", "image_generation", "view_image"]) {
        assert.ok(argv.some((a, i) => a === "--disable" && argv[i + 1] === feature), `--disable ${feature}`);
      }
      for (const override of ["mcp_servers={}", "plugins={}", "apps={}", 'shell_environment_policy.inherit="none"']) {
        assert.ok(argv.some((a, i) => a === "-c" && argv[i + 1] === override), `-c ${override}`);
      }
      assert.equal(argv[argv.indexOf("-s") + 1], "read-only");
      assert.ok(!argv.some((a) => /danger|bypass/i.test(a)), "never a bypass flag");
      assert.ok(CODEX_ISOLATION_ARGS.every((a) => argv.includes(a)), "the whole isolation set, in every call");
      assert.equal(argv[argv.length - 1], "extract", "the prompt stays the final argument");
    } finally {
      if (previous === undefined) delete process.env.KINERARY_TEST_SECRET;
      else process.env.KINERARY_TEST_SECRET = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
