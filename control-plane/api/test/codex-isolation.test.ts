/**
 * Codex structures untrusted organizer text, so every invocation must run with
 * its agent tools disabled and without the relay process's secrets.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  CODEX_ISOLATION_FEATURES, codexChildEnv, codexIsolationProblem, codexRunner, codexSpec, runnerForBinding,
} from "../src/model-runner.js";
import {
  RELAY_SECRET_NAMES, plantedSecrets, withFakeBinDir, withPlantedEnv, writeFakeBin,
} from "./support/child-env-harness.js";

/**
 * THIS TEST OWNS ITS POLICY. It deliberately does not iterate
 * CODEX_ISOLATION_FEATURES to decide what to expect: a test that iterates the
 * implementation's own constant asserts that the code equals itself. Proven,
 * not theorised — renaming `shell_tool` to `shel_tool` in the source left this
 * file at `# pass 1 / # fail 0`, while a real codex exits 1 on an unknown
 * feature. Written out here, removing or renaming any of these FAILS. (The
 * constant is imported once, below, only to be DIFFED against this list.)
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
    await withFakeBinDir("kinerary-fake-codex-", async (dir) => {
      await withPlantedEnv({ ...plantedSecrets("codex"), CODEX_HOME: join(dir, "codex-home") }, async () => {
        const bin = await writeFakeBin(dir, "codex", [
          "const argv = process.argv.slice(2);",
          "const out = argv[argv.indexOf('-o') + 1];",
          "require('fs').writeFileSync(out, JSON.stringify({",
          "  argv,",
          "  secret: process.env.KINERARY_TEST_SECRET ?? null,",
          "  codexHome: process.env.CODEX_HOME ?? null,",
          "  inherited: Object.keys(process.env).sort(),",
          "}));",
        ]);

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
        assert.equal(codexHome, join(dir, "codex-home"), "Codex authentication/config remains available");
        for (const secretName of RELAY_SECRET_NAMES) {
          assert.ok(!inherited.includes(secretName), `${secretName} must not reach the Codex child process`);
        }
      });
    });
  });

  test("the exported feature constant equals this test's own independent list", () => {
    // The exported constant is what the startup probe checks against a real
    // codex, so it is pinned to the same list the argv test states.
    assert.deepEqual([...CODEX_ISOLATION_FEATURES].sort(), [...MUST_BE_DISABLED].sort());
  });

  test("codexChildEnv allows exactly the thirteen variables it always has", () => {
    // Behaviour pin for the move onto the shared builder: nothing added, nothing dropped.
    const everything = Object.fromEntries([
      "PATH", "HOME", "CODEX_HOME", "XDG_CONFIG_HOME", "TMPDIR", "TMP", "TEMP",
      "LANG", "LC_ALL", "LC_CTYPE", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
      "XDG_CACHE_HOME", "CLAUDE_CONFIG_DIR", "HERMES_HOME", "OPENROUTER_API_KEY", "TELEGRAM_BOT_TOKEN",
    ].map((key) => [key, "x"]));
    assert.deepEqual(Object.keys(codexChildEnv(everything)).sort(), [
      "CODEX_HOME", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "NODE_EXTRA_CA_CERTS", "PATH",
      "SSL_CERT_DIR", "SSL_CERT_FILE", "TEMP", "TMP", "TMPDIR", "XDG_CONFIG_HOME",
    ]);
  });
});

describe("codex isolation startup check (#58)", () => {
  const featureList = (names: readonly string[]) => names.map((n) => `${n}    stable    true`).join("\n");

  test("a codex that knows every isolation feature is clean", async () => {
    await withFakeBinDir("kinerary-fake-codex-probe-", async (dir) => {
      const bin = await writeFakeBin(dir, "codex", [`process.stdout.write(${JSON.stringify(featureList(MUST_BE_DISABLED))});`]);
      assert.equal(await codexIsolationProblem(bin, 10_000), null);
    });
  });

  test("a codex that lacks one feature is a problem naming it", async () => {
    await withFakeBinDir("kinerary-fake-codex-probe-", async (dir) => {
      const short = MUST_BE_DISABLED.filter((name) => name !== "shell_tool");
      const bin = await writeFakeBin(dir, "codex", [`process.stdout.write(${JSON.stringify(featureList(short))});`]);
      assert.match(String(await codexIsolationProblem(bin, 10_000)), /shell_tool/);
    });
  });

  test("REFUSES when it cannot run: missing binary, non-zero exit, empty output are problems, never null", async () => {
    assert.notEqual(await codexIsolationProblem("/nonexistent/codex", 5_000), null, "missing binary");
    await withFakeBinDir("kinerary-fake-codex-probe-", async (dir) => {
      const failing = await writeFakeBin(dir, "codex-fail", ["process.exit(3);"]);
      assert.notEqual(await codexIsolationProblem(failing, 10_000), null, "non-zero exit");
      const silent = await writeFakeBin(dir, "codex-silent", ["process.stdout.write('');"]);
      assert.notEqual(await codexIsolationProblem(silent, 10_000), null, "empty feature list");
    });
  });

  test("the probe itself does not inherit relay secrets", async () => {
    await withFakeBinDir("kinerary-fake-codex-probe-", async (dir) => {
      await withPlantedEnv(plantedSecrets("codex-probe"), async () => {
        // Exits non-zero if any planted secret is visible, which the check reports as a problem.
        const bin = await writeFakeBin(dir, "codex", [
          `const names = ${JSON.stringify(RELAY_SECRET_NAMES)};`,
          "if (names.some((n) => process.env[n] !== undefined)) process.exit(9);",
          `process.stdout.write(${JSON.stringify(featureList(MUST_BE_DISABLED))});`,
        ]);
        assert.equal(await codexIsolationProblem(bin, 10_000), null);
      });
    });
  });

  test("an unverified codex is no binding at all; a verified one is", () => {
    assert.equal(runnerForBinding("codex", "gpt-test", 1000, "extract", { KINERARY_CODEX_ISOLATION_UNVERIFIED: "1" }), undefined);
    assert.notEqual(runnerForBinding("codex", "gpt-test", 1000, "extract", {}), undefined);
  });
});
