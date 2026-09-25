/**
 * What a nested CLI inherits from the relay.
 *
 * Two real failures pull in opposite directions, and both are pinned here
 * against the allow-list that replaced the old deny-list `hermeticEnv`:
 *
 *  - 2026-09-10: a relay started from inside a Claude Code session handed that
 *    session's CLAUDE_CODE_* variables to the nested CLI, which then returned
 *    well-formed, empty extractions. So the calling session's state stays out.
 *  - 2026-09-11: on the Proxmox VM the relay runs in a container with no
 *    keychain, and `claude setup-token`'s CLAUDE_CODE_OAUTH_TOKEN is the CLI's
 *    only credential. Stripping it made every interpret call exit non-zero
 *    (FAILED), and the automated organizer's interview stalled on its first
 *    typed answer.
 *
 * The token is a credential, not session state. That is the line these hold.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { claudeChildEnv, cliRunner, specEnv, structuringChildEnv, type CliSpec } from "../src/model-runner.js";
import { OS_INJECTED, plantedSecrets, withFakeBinDir, withPlantedEnv, writeFakeBin } from "./support/child-env-harness.js";

describe("the nested Claude CLI's environment", () => {
  const source: NodeJS.ProcessEnv = {
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/home/node",
    CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-token",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CODE_SSE_PORT: "54321",
    CLAUDE_PID: "4242",
    CLAUDE_EFFORT: "high",
    INTERPRET_RUNNER: "claude",
    TELEGRAM_BOT_TOKEN: "secret",
  };

  test("keeps the CLI's own credential", () => {
    assert.equal(claudeChildEnv(source).CLAUDE_CODE_OAUTH_TOKEN, "test-oauth-token");
  });

  test("strips the calling session's state and everything else the relay holds", () => {
    const env = claudeChildEnv(source);
    for (const key of ["CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "CLAUDE_PID", "CLAUDE_EFFORT", "INTERPRET_RUNNER", "TELEGRAM_BOT_TOKEN"]) {
      assert.equal(key in env, false, `${key} leaked into the nested CLI`);
    }
  });

  test("keeps what the binary needs to be found", () => {
    const env = claudeChildEnv(source);
    assert.equal(env.PATH, source.PATH);
    assert.equal(env.HOME, source.HOME);
  });

  test("defaults to the process environment", () => {
    const before = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "from-process";
    try {
      assert.equal(claudeChildEnv().CLAUDE_CODE_OAUTH_TOKEN, "from-process");
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = before;
    }
  });
});

describe("the spawn chokepoint fails safe", () => {
  test("a spec whose env function returns nothing gives the child an EMPTY environment, not the relay's", async () => {
    await withFakeBinDir("kinerary-fake-cli-", async (dir) => {
      await withPlantedEnv(plantedSecrets("undefined-env"), async () => {
        const bin = await writeFakeBin(dir, "cli", ["process.stdout.write(JSON.stringify({ inherited: Object.keys(process.env) }));"]);
        const spec: CliSpec = {
          // Node by absolute path: an EMPTY env has no PATH for `#!/usr/bin/env node` to search.
          bin: process.execPath, model: "m", timeoutMs: 20_000, maxAttempts: 1,
          args: () => [bin],
          env: (() => undefined) as unknown as CliSpec["env"],
        };
        assert.deepEqual(specEnv(spec), {});
        const result = await cliRunner({ t: spec }).run({ task: "t", prompt: "x", parse: (raw: unknown) => raw as { inherited: string[] } });
        assert.equal(result.ok, true, result.ok ? "" : `${result.reason}: ${result.detail}`);
        if (!result.ok) return;
        const leaked = result.value.inherited.filter((key) => !OS_INJECTED.has(key));
        assert.deepEqual(leaked, [], `the child inherited: ${leaked.join(", ")}`);
      });
    });
  });

  test("a spec with no env at all gets the base allow-list only", () => {
    const env = specEnv({});
    for (const key of Object.keys(env)) {
      assert.ok(Object.keys(structuringChildEnv([], process.env)).includes(key));
    }
    assert.equal("TELEGRAM_BOT_TOKEN" in structuringChildEnv([], { PATH: "/bin", TELEGRAM_BOT_TOKEN: "x" }), false);
  });
});
