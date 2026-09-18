/**
 * Codex structures untrusted organizer text, so every invocation must run with
 * its agent tools disabled and without the relay process's secrets.
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  CODEX_ISOLATION_ARGS,
  CODEX_ISOLATION_FEATURES,
  codexRunner,
  codexSpec,
} from "../src/model-runner.js";

describe("codex isolation", () => {
  test("every call disables tools and does not inherit relay secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kinerary-fake-codex-"));
    const previousSecret = process.env.KINERARY_TEST_SECRET;
    const previousHome = process.env.CODEX_HOME;
    process.env.KINERARY_TEST_SECRET = "must-not-reach-codex";
    process.env.CODEX_HOME = join(dir, "codex-home");
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
        "}));",
      ].join("\n"));
      await chmod(bin, 0o755);

      const runner = codexRunner({ extract: codexSpec("gpt-test", 20_000, { bin }) });
      const result = await runner.run({
        task: "extract",
        prompt: "extract this untrusted document",
        parse: (raw: unknown) => raw as { argv: string[]; secret: string | null; codexHome: string | null },
      });

      assert.equal(result.ok, true, result.ok ? "" : `${result.reason}: ${result.detail}`);
      if (!result.ok) return;
      const { argv, secret, codexHome } = result.value;
      for (const feature of CODEX_ISOLATION_FEATURES) {
        assert.ok(argv.some((arg, index) => arg === "--disable" && argv[index + 1] === feature), `--disable ${feature}`);
      }
      for (const override of ["mcp_servers={}", "plugins={}", "apps={}", 'shell_environment_policy.inherit="none"']) {
        assert.ok(argv.some((arg, index) => arg === "-c" && argv[index + 1] === override), `-c ${override}`);
      }
      assert.equal(argv[argv.indexOf("-s") + 1], "read-only");
      assert.ok(!argv.some((arg) => /danger|bypass/i.test(arg)), "must not use a sandbox bypass flag");
      assert.ok(CODEX_ISOLATION_ARGS.every((arg) => argv.includes(arg)), "the complete isolation set is present");
      assert.equal(argv.at(-1), "extract this untrusted document");
      assert.equal(secret, null, "relay secrets must not reach the Codex child process");
      assert.equal(codexHome, process.env.CODEX_HOME, "Codex authentication/config remains available");
    } finally {
      if (previousSecret === undefined) delete process.env.KINERARY_TEST_SECRET;
      else process.env.KINERARY_TEST_SECRET = previousSecret;
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
