/**
 * The three OLDER Hermes spawns — the itinerary-extract fallback, the venue-link
 * search and the consular/destination web search — read organizer document text
 * or destinations. They used to `execFile` with no `env`, so the child got the
 * relay's whole environment, including loader variables (LD_PRELOAD,
 * DYLD_INSERT_LIBRARIES) that a child HONOURS. Black-box, like the other
 * isolation tests: plant the secrets, run a fake `hermes`, read what it saw.
 *
 * HERMES_BIN is read when the module loads, so the fake is installed and the
 * modules imported afterwards.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { OS_INJECTED, RELAY_SECRET_NAMES, plantedSecrets, withFakeBinDir, withPlantedEnv, writeFakeBin } from "./support/child-env-harness.js";

/** Not secrets by name, but a child must not inherit them either. */
const AMBIENT_HAZARDS = ["LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "PYTHONPATH", "BASH_ENV", "NODE_OPTIONS", "HTTPS_PROXY", "SSH_AUTH_SOCK", "PROXMOX_TOKEN_SECRET"];
const MAY_REACH_THE_CHILD = new Set([
  "PATH", "HOME", "HERMES_HOME", "XDG_CONFIG_HOME", "TMPDIR", "TMP", "TEMP",
  "LANG", "LC_ALL", "LC_CTYPE", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
]);

let cleanup: () => void = () => {};
let seenFile = "";
let extractItinerary: typeof import("../src/itinerary-extract.js").extractItinerary;
let searchVenueUrls: typeof import("../src/itinerary-extract.js").searchVenueUrls;
let runHermesWebSearch: typeof import("../src/hermes-search.js").runHermesWebSearch;
const savedEnv: Record<string, string | undefined> = {};

before(async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => {
    void withFakeBinDir("kinerary-fake-hermes-spawns-", async (dir) => {
      seenFile = join(dir, "seen.json");
      const bin = await writeFakeBin(dir, "hermes", [
        "const fs = require('fs'), path = require('path');",
        "fs.writeFileSync(path.join(__dirname, 'seen.json'), JSON.stringify({ inherited: Object.keys(process.env).sort(), argv: process.argv.slice(2) }));",
        "process.stdout.write('{}');",
      ]);
      for (const [k, v] of Object.entries({ HERMES_BIN: bin, HERMES_EXTRACT_PROFILE: "p-extract", HERMES_SEARCH_PROFILE: "p-search" })) {
        savedEnv[k] = process.env[k];
        process.env[k] = v;
      }
      ({ extractItinerary, searchVenueUrls } = await import("../src/itinerary-extract.js"));
      ({ runHermesWebSearch } = await import("../src/hermes-search.js"));
      resolve();
      await held;
    });
  });
  await ready;
  cleanup = release;
});

after(() => {
  cleanup();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function seenBy(spawn: () => Promise<unknown>): Promise<{ inherited: string[]; argv: string[] }> {
  const planted = { ...plantedSecrets("hermes-spawn"), HERMES_HOME: "/planted/hermes-home" };
  for (const name of AMBIENT_HAZARDS) (planted as Record<string, string>)[name] = `must-not-reach:${name}`;
  await withPlantedEnv(planted, async () => {
    await spawn().catch(() => undefined);
  });
  return JSON.parse(readFileSync(seenFile, "utf8"));
}

function assertIsolated(seen: { inherited: string[] }) {
  for (const name of [...RELAY_SECRET_NAMES, ...AMBIENT_HAZARDS]) {
    assert.ok(!seen.inherited.includes(name), `${name} must not reach the Hermes child`);
  }
  const unsanctioned = seen.inherited.filter((key) => !MAY_REACH_THE_CHILD.has(key) && !OS_INJECTED.has(key));
  assert.deepEqual(unsanctioned, [], `unsanctioned variables reached the child: ${unsanctioned.join(", ")}`);
  assert.ok(seen.inherited.includes("HERMES_HOME"), "Hermes must still find its own config");
}

describe("older hermes spawns carry no relay environment", () => {
  test("extractItinerary's Hermes fallback (runExtract)", async () => {
    const seen = await seenBy(() => extractItinerary({ documentText: "Day 1: Tokyo", phases: [] } as never, undefined));
    assert.equal(seen.argv[1], "p-extract", "the fallback profile was the one spawned");
    assertIsolated(seen);
  });

  test("the venue-link web search (runVenueLinkSearch)", async () => {
    const seen = await seenBy(() => searchVenueUrls(["Tokyo Skytree"], "Japan"));
    assert.equal(seen.argv[1], "p-search");
    assertIsolated(seen);
  });

  test("the consular / destination web search (runHermesWebSearch)", async () => {
    const seen = await seenBy(() => runHermesWebSearch({ profile: "p-consular", prompt: "embassy", timeoutMs: 20_000 }));
    assert.equal(seen.argv[1], "p-consular");
    assertIsolated(seen);
  });
});
