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
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { claudeSpec, cliRunner } from "../src/model-runner.js";

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
  "TMPDIR", "TMP", "TEMP",
  "LANG", "LC_ALL", "LC_CTYPE",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
]);

/**
 * Added by the operating system to every child, not inherited from us, so the
 * subset check below must not count them. Verified rather than assumed: a Node
 * child spawned with `env: { PATH }` and nothing else still reports
 * `__CF_USER_TEXT_ENCODING`, because macOS CoreFoundation sets it. It carries a
 * user id and a text encoding, never a credential. Anything added here needs
 * the same demonstration — an OS that injects a secret would be the story.
 */
const OS_INJECTED = new Set(["__CF_USER_TEXT_ENCODING"]);

/**
 * Secret-shaped names the relay genuinely holds. Named individually as well as
 * covered by the subset check, so a failure says which secret leaked rather
 * than only that the set grew.
 */
const MUST_NOT_REACH_THE_CHILD = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "TELEGRAM_BOT_TOKEN",
  "CONTROL_PLANE_DATABASE_URL",
  "CONTROL_PLANE_INTERVIEW_AGENT_KEY",
  "CONTROL_PLANE_CHAT_ROUTING_KEY",
  "INTERVIEW_MCP_KEY",
  "KINERARY_TEST_SECRET",
];

describe("claude isolation", () => {
  test("a nested claude -p sees its own login and none of the relay's secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kinerary-fake-claude-"));
    const saved = new Map<string, string | undefined>();
    const set = (key: string, value: string) => {
      saved.set(key, process.env[key]);
      process.env[key] = value;
    };
    try {
      for (const name of MUST_NOT_REACH_THE_CHILD) set(name, `must-not-reach-claude:${name}`);
      set("CLAUDE_CODE_OAUTH_TOKEN", "the-cli-own-login");

      // `claudeSpec()` now passes `--output-format json` and reads the answer
      // through `claudeStreamAnswer`, which expects one `{"type":"result",...}`
      // line rather than the bare object this fixture used to print directly —
      // added during this merge (integration/sprint-6's toolless structuring
      // call landed after this test was written) so the isolation assertions
      // below still actually run, instead of failing at `result.ok` before
      // ever inspecting `inherited`.
      const bin = join(dir, "claude");
      await writeFile(bin, [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({",
        "  type: 'result',",
        "  subtype: 'success',",
        "  result: JSON.stringify({",
        "    argv: process.argv.slice(2),",
        "    inherited: Object.keys(process.env).sort(),",
        "    login: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,",
        "  }),",
        "}));",
      ].join("\n"));
      await chmod(bin, 0o755);

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
      for (const name of MUST_NOT_REACH_THE_CHILD) {
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
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});
