/**
 * hermeticEnv — what a nested `claude -p` inherits from the relay.
 *
 * Two real failures pull in opposite directions:
 *
 *  - 2026-09-10: a relay started from inside a Claude Code session handed that
 *    session's CLAUDE_CODE_* variables to the nested CLI, which then returned
 *    well-formed, empty extractions. So the calling session's state is stripped.
 *  - 2026-09-11: on the Proxmox VM the relay runs in a container with no
 *    keychain, and `claude setup-token`'s CLAUDE_CODE_OAUTH_TOKEN is the CLI's
 *    only credential. Stripping it along with the session variables made every
 *    interpret call exit non-zero (FAILED), and the automated organizer's
 *    interview stalled on its first typed answer.
 *
 * The token is a credential, not session state. That is the line these hold.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { hermeticEnv } from "../src/model-runner.js";

describe("hermeticEnv", () => {
  const source: NodeJS.ProcessEnv = {
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/home/node",
    CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-token",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CODE_SSE_PORT: "54321",
    CLAUDE_PID: "4242",
    CLAUDE_EFFORT: "high",
    INTERPRET_RUNNER: "claude",
  };

  test("keeps the CLI's own credential", () => {
    assert.equal(hermeticEnv(source).CLAUDE_CODE_OAUTH_TOKEN, "test-oauth-token");
  });

  test("still strips the calling session's state", () => {
    const env = hermeticEnv(source);
    for (const key of ["CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "CLAUDE_PID", "CLAUDE_EFFORT"]) {
      assert.equal(key in env, false, `${key} leaked into the nested CLI`);
    }
  });

  test("keeps what the binary needs to be found and to find its config", () => {
    const env = hermeticEnv(source);
    assert.equal(env.PATH, source.PATH);
    assert.equal(env.HOME, source.HOME);
    assert.equal(env.INTERPRET_RUNNER, "claude");
  });

  test("defaults to the process environment", () => {
    const before = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "from-process";
    try {
      assert.equal(hermeticEnv().CLAUDE_CODE_OAUTH_TOKEN, "from-process");
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = before;
    }
  });
});
