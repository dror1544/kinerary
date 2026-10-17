/**
 * The Claude CLI structures untrusted organizer text, so every invocation must
 * run without the relay process's secrets — the same rule `codex-isolation`
 * states for the other runner, applied to the one the production configuration
 * actually uses (`INTERPRET_RUNNER=claude`, `EXTRACT_RUNNER=claude`).
 *
 * THIS TEST OWNS ITS POLICY. It deliberately does not import the allowlist it
 * is checking. A test that iterates the implementation's own constant asserts
 * that the code equals itself and passes no matter what the constant says: the
 * codex test was written that way, and renaming a disabled feature to a typo
 * still gave `# pass 1 / # fail 0`. The names below are written out here so
 * that widening the real policy FAILS, which is the only version of this test
 * worth having.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { claudeChildEnv, claudeSpec, cliRunner } from "../src/model-runner.js";
import {
  OS_INJECTED, RELAY_SECRET_NAMES, plantedSecrets, withFakeBinDir, withPlantedEnv, writeFakeBin,
} from "./support/child-env-harness.js";

/**
 * Everything the child is allowed to see, restated independently of the source.
 * Two kinds only: how to run at all, and the CLI's OWN credentials — which stay
 * because withholding them does not shrink a prompt injection's blast radius
 * and does break the call, and a child that cannot authenticate exits non-zero,
 * returns FAILED, and makes the router quietly do less (the VM, 2026-09-11).
 */
const MAY_REACH_THE_CHILD = new Set([
  "PATH", "HOME",
  "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME",
  // Who is logged in — not a secret. On macOS the CLI finds its login in the
  // Keychain by account name, taken from USER: without it every call answers
  // "Not logged in" and the task returns FAILED (found 2026-09-25, running the
  // real-model harness on the Mac after #192 narrowed the environment).
  "USER", "LOGNAME",
  "TMPDIR", "TMP", "TEMP",
  "LANG", "LC_ALL", "LC_CTYPE",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
]);

describe("claude isolation", () => {
  test("a nested claude -p sees its own login and none of the relay's secrets", async () => {
    await withFakeBinDir("kinerary-fake-claude-", async (dir) => {
      await withPlantedEnv({ ...plantedSecrets("claude"), CLAUDE_CODE_OAUTH_TOKEN: "the-cli-own-login" }, async () => {
        // `claudeSpec()` passes `--output-format json` and reads the answer
        // through `claudeStreamAnswer`, which expects one `{"type":"result",...}`
        // line rather than a bare object.
        const bin = await writeFakeBin(dir, "claude", [
          "process.stdout.write(JSON.stringify({",
          "  type: 'result',",
          "  subtype: 'success',",
          "  result: JSON.stringify({",
          "    argv: process.argv.slice(2),",
          "    inherited: Object.keys(process.env).sort(),",
          "    login: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,",
          "  }),",
          "}));",
        ]);

        const runner = cliRunner({ interpret: claudeSpec("claude-test-model", 20_000, bin) });
        const result = await runner.run({
          task: "interpret",
          prompt: "interpret this untrusted organizer message",
          parse: (raw: unknown) => raw as { argv: string[]; inherited: string[]; login: string | null },
        });

        assert.equal(result.ok, true, result.ok ? "" : `${result.reason}: ${result.detail}`);
        if (!result.ok) return;
        const { argv, inherited, login } = result.value;

        // Named, so a failure says which secret got through.
        for (const name of RELAY_SECRET_NAMES) {
          assert.ok(!inherited.includes(name), `${name} must not reach the Claude child process`);
        }

        // The subset check is the one that catches a policy that was widened:
        // anything the child can see that this test did not sanction fails here,
        // including a name nobody has thought of yet.
        const unsanctioned = inherited.filter((key) => !MAY_REACH_THE_CHILD.has(key) && !OS_INJECTED.has(key));
        assert.deepEqual(
          unsanctioned,
          [],
          `the child inherited variables this test does not sanction: ${unsanctioned.join(", ")}`,
        );

        // Fail-safe in the other direction: isolation that breaks the call is the
        // silent downgrade, not a fix.
        assert.equal(login, "the-cli-own-login", "the CLI's own credential must still reach it");
        assert.equal(argv[0], "-p", "print mode: one response, no session");
        assert.equal(argv.at(-1) === "interpret this untrusted organizer message" || argv[1] === "interpret this untrusted organizer message", true, "the prompt is passed");
      });
    });
  });

  test("claudeChildEnv allows exactly the set it did before the shared builder", () => {
    // Behaviour pin: the subset check above cannot notice a variable DROPPED.
    const everything = Object.fromEntries(
      [...MAY_REACH_THE_CHILD, "CODEX_HOME", "HERMES_HOME", "OPENROUTER_API_KEY"].map((key) => [key, "x"]),
    );
    assert.deepEqual(Object.keys(claudeChildEnv(everything)).sort(), [...MAY_REACH_THE_CHILD].sort());
  });
});
