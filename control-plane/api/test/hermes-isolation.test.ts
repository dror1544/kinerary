/**
 * The Hermes structuring path (`hermes` as INTERPRET_/EXTRACT_RUNNER) hands
 * untrusted organizer text to an agent CLI. Like `codex-isolation` and
 * `claude-isolation`, this states the environment rule as a black-box fact:
 * plant the relay's secrets in the parent, spawn a fake `hermes`, read back
 * what it received. Hermes keeps its own credentials in `~/.hermes/.env`, so
 * it needs a way to run and to find its own config, and nothing else.
 *
 * THIS TEST OWNS ITS POLICY — it does not import the allow-list it checks.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cliRunner, hermesSpec } from "../src/model-runner.js";
import {
  OS_INJECTED, RELAY_SECRET_NAMES, plantedSecrets, withFakeBinDir, withPlantedEnv, writeFakeBin,
} from "./support/child-env-harness.js";

const MAY_REACH_THE_CHILD = new Set([
  "PATH", "HOME", "HERMES_HOME",
  "XDG_CONFIG_HOME",
  "TMPDIR", "TMP", "TEMP",
  "LANG", "LC_ALL", "LC_CTYPE",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
]);

describe("hermes isolation", () => {
  test("a hermes structuring call sees its own config location and none of the relay's secrets", async () => {
    await withFakeBinDir("kinerary-fake-hermes-", async (dir) => {
      await withPlantedEnv({ ...plantedSecrets("hermes"), HERMES_HOME: "/planted/hermes-home" }, async () => {
        const bin = await writeFakeBin(dir, "hermes", [
          "process.stdout.write(JSON.stringify({",
          "  argv: process.argv.slice(2),",
          "  inherited: Object.keys(process.env).sort(),",
          "  hermesHome: process.env.HERMES_HOME ?? null,",
          "}));",
        ]);
        const runner = cliRunner({ extract: hermesSpec("kinerary-extract", 20_000, bin) });
        const result = await runner.run({
          task: "extract",
          prompt: "extract this untrusted document",
          parse: (raw: unknown) => raw as { argv: string[]; inherited: string[]; hermesHome: string | null },
        });
        assert.equal(result.ok, true, result.ok ? "" : `${result.reason}: ${result.detail}`);
        if (!result.ok) return;
        const { argv, inherited, hermesHome } = result.value;

        for (const name of RELAY_SECRET_NAMES) {
          assert.ok(!inherited.includes(name), `${name} must not reach the Hermes child process`);
        }
        const unsanctioned = inherited.filter((key) => !MAY_REACH_THE_CHILD.has(key) && !OS_INJECTED.has(key));
        assert.deepEqual(unsanctioned, [], `the child inherited variables this test does not sanction: ${unsanctioned.join(", ")}`);
        // Fail-safe the other way: isolation that hides Hermes's own config is a silent downgrade.
        assert.equal(hermesHome, "/planted/hermes-home", "Hermes must still find its own config directory");
        assert.deepEqual(argv.slice(0, 4), ["-p", "kinerary-extract", "chat", "-q"]);
      });
    });
  });
});
