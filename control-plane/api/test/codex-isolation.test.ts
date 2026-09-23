/**
 * Codex structures untrusted organizer text, so every invocation must run with
 * its agent tools disabled and without the relay process's secrets.
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { codexRunner, codexSpec } from "../src/model-runner.js";

/**
 * THIS TEST OWNS ITS POLICY. It deliberately does not import
 * CODEX_ISOLATION_FEATURES: a test that iterates the implementation's own
 * constant asserts that the code equals itself. Proven, not theorised —
 * renaming `shell_tool` to `shel_tool` in the source left this file at
 * `# pass 1 / # fail 0`, while a real codex exits 1 on an unknown feature.
 * Written out here, removing or renaming any of these FAILS.
 */
const MUST_BE_DISABLED = [
  // Anything that can reach a shell, a file or this machine.
  "shell_tool", "unified_exec", "shell_snapshot", "code_mode_host",
  // Anything that can reach the network or another service.
  "browser_use", "browser_use_external", "browser_use_full_cdp_access",
  "in_app_browser", "computer_use",
  // Anything that can load more capability at run time.
  "apps", "plugins", "remote_plugin", "plugin_sharing",
  "skill_search", "skill_mcp_dependency_install",
  // Anything that can act on its own or fan out.
  "hooks", "multi_agent", "sleep_tool",
  "tool_suggest", "tool_call_mcp_elicitation",
  // Output side channels.
  "image_generation", "view_image",
];

describe("codex isolation", () => {
  test("every call disables tools and does not inherit relay secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kinerary-fake-codex-"));
    const previousSecret = process.env.KINERARY_TEST_SECRET;
    const previousHome = process.env.CODEX_HOME;
    const previousOpenRouterKey = process.env.OPENROUTER_API_KEY;
    const previousDatabaseUrl = process.env.CONTROL_PLANE_DATABASE_URL;
    const previousTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.KINERARY_TEST_SECRET = "must-not-reach-codex";
    process.env.CODEX_HOME = join(dir, "codex-home");
    process.env.OPENROUTER_API_KEY = "must-not-reach-codex";
    process.env.CONTROL_PLANE_DATABASE_URL = "postgres://must-not-reach-codex";
    process.env.TELEGRAM_BOT_TOKEN = "must-not-reach-codex";
    try {
      const bin = join(dir, "codex");
      await writeFile(bin, [
        "#!/usr/bin/env node",
        "const argv = process.argv.slice(2);",
        "const out = argv[argv.indexOf('-o') + 1];",
        "require('fs').writeFileSync(out, JSON.stringify({",
        "  argv,",
        "  secret: process.env.KINERARY_TEST_SECRET ?? null,",
        "  codexHome: process.env.CODEX_HOME ?? null,",
        "  inherited: Object.keys(process.env).sort(),",
        "}));",
      ].join("\n"));
      await chmod(bin, 0o755);

      const runner = codexRunner({ extract: codexSpec("gpt-test", 20_000, { bin }) });
      const result = await runner.run({
        task: "extract",
        prompt: "extract this untrusted document",
        parse: (raw: unknown) => raw as { argv: string[]; secret: string | null; codexHome: string | null; inherited: string[] },
      });

      assert.equal(result.ok, true, result.ok ? "" : `${result.reason}: ${result.detail}`);
      if (!result.ok) return;
      const { argv, secret, codexHome, inherited } = result.value;
      for (const feature of MUST_BE_DISABLED) {
        assert.ok(argv.some((arg, index) => arg === "--disable" && argv[index + 1] === feature), `--disable ${feature}`);
      }
      for (const override of ["mcp_servers={}", "plugins={}", "apps={}", 'shell_environment_policy.inherit="none"']) {
        assert.ok(argv.some((arg, index) => arg === "-c" && argv[index + 1] === override), `-c ${override}`);
      }
      assert.equal(argv[argv.indexOf("-s") + 1], "read-only");
      assert.ok(argv.includes("--ignore-user-config"), "must not load a Codex config that can re-enable a capability");
      assert.ok(!argv.some((arg) => /danger|bypass/i.test(arg)), "must not use a sandbox bypass flag");
      // Nothing is re-enabled behind the isolation set's back: every --disable
      // the invocation carries has to be one this test sanctioned, so a flag
      // quietly dropped from the source is caught by the count, not by faith.
      const disabled = argv.flatMap((arg, i) => (arg === "--disable" ? [argv[i + 1]] : []));
      assert.deepEqual(
        [...disabled].sort(),
        [...MUST_BE_DISABLED].sort(),
        "the disabled set must be exactly the policy this test states",
      );
      assert.equal(argv.at(-1), "extract this untrusted document");
      assert.equal(secret, null, "relay secrets must not reach the Codex child process");
      assert.equal(codexHome, process.env.CODEX_HOME, "Codex authentication/config remains available");
      for (const secretName of ["OPENROUTER_API_KEY", "CONTROL_PLANE_DATABASE_URL", "TELEGRAM_BOT_TOKEN"]) {
        assert.ok(!inherited.includes(secretName), `${secretName} must not reach the Codex child process`);
      }
    } finally {
      if (previousSecret === undefined) delete process.env.KINERARY_TEST_SECRET;
      else process.env.KINERARY_TEST_SECRET = previousSecret;
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
      if (previousOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousOpenRouterKey;
      if (previousDatabaseUrl === undefined) delete process.env.CONTROL_PLANE_DATABASE_URL;
      else process.env.CONTROL_PLANE_DATABASE_URL = previousDatabaseUrl;
      if (previousTelegramToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = previousTelegramToken;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
