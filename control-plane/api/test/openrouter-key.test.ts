/**
 * The OpenRouter key comes from wherever it already lives — never a copy.
 *
 * Hermes keeps it as a line in `~/.hermes/.env`, beside bot tokens and other
 * providers' keys; the VM mounts `/opt/agent-auth/openrouter.env`. Pointing
 * OPENROUTER_API_KEY_FILE at either must yield that one key and nothing else
 * from the file. The values here are fakes.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { openRouterKey, openRouterKeyFromFile } from "../src/model-runner.js";

describe("openRouterKeyFromFile", () => {
  test("an env file yields only the OpenRouter line", () => {
    const env = [
      "# Hermes",
      "TELEGRAM_BOT_TOKEN=123:not-this-one",
      "ANTHROPIC_API_KEY=sk-ant-not-this-one",
      "OPENROUTER_API_KEY=sk-or-fake-1",
      "OPENAI_API_KEY=sk-not-this-one",
    ].join("\n");
    assert.equal(openRouterKeyFromFile(env), "sk-or-fake-1");
  });

  test("export, quotes and a trailing comment are the shell's, not the key's", () => {
    assert.equal(openRouterKeyFromFile('export OPENROUTER_API_KEY="sk-or-fake-2"\n'), "sk-or-fake-2");
    assert.equal(openRouterKeyFromFile("OPENROUTER_API_KEY='sk-or-fake-3'"), "sk-or-fake-3");
    assert.equal(openRouterKeyFromFile("OPENROUTER_API_KEY=sk-or-fake-4  # rotated"), "sk-or-fake-4");
  });

  test("a bare key file still works, and an env file without the line yields nothing", () => {
    assert.equal(openRouterKeyFromFile("sk-or-fake-5\n"), "sk-or-fake-5");
    assert.equal(openRouterKeyFromFile("TELEGRAM_BOT_TOKEN=123:abc\n"), "", "some other secret is never this key");
    assert.equal(openRouterKeyFromFile("a\nb\n"), "");
  });
});

describe("openRouterKey", () => {
  test("the variable wins; otherwise the file; a missing file is no key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "or-key-"));
    try {
      const file = join(dir, ".env");
      await writeFile(file, "OTHER=1\nOPENROUTER_API_KEY=sk-or-fake-6\n");
      assert.equal(openRouterKey({ OPENROUTER_API_KEY: "sk-or-direct", OPENROUTER_API_KEY_FILE: file }), "sk-or-direct");
      assert.equal(openRouterKey({ OPENROUTER_API_KEY_FILE: file }), "sk-or-fake-6");
      assert.equal(openRouterKey({ OPENROUTER_API_KEY_FILE: join(dir, "missing") }), "");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
