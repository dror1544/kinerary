import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveSecretRef } from "../src/secrets.js";

test("env:// resolves to the named environment variable", async () => {
  process.env.KINERARY_TEST_SECRETS_ENV_CASE = "resolved-value";
  try {
    assert.equal(await resolveSecretRef("env://KINERARY_TEST_SECRETS_ENV_CASE"), "resolved-value");
  } finally {
    delete process.env.KINERARY_TEST_SECRETS_ENV_CASE;
  }
});

test("env:// rejects an unset or empty variable", async () => {
  delete process.env.KINERARY_TEST_SECRETS_ENV_MISSING;
  await assert.rejects(resolveSecretRef("env://KINERARY_TEST_SECRETS_ENV_MISSING"), /unset or empty/);
  process.env.KINERARY_TEST_SECRETS_ENV_MISSING = "";
  try {
    await assert.rejects(resolveSecretRef("env://KINERARY_TEST_SECRETS_ENV_MISSING"), /unset or empty/);
  } finally {
    delete process.env.KINERARY_TEST_SECRETS_ENV_MISSING;
  }
});

test("file:// resolves to the trimmed contents of the referenced file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kinerary-control-plane-secrets-"));
  try {
    const path = join(directory, "a-secret");
    await writeFile(path, "file-secret-value\n", { mode: 0o600 });
    assert.equal(await resolveSecretRef(`file://${path}`), "file-secret-value");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file:// rejects an empty file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kinerary-control-plane-secrets-"));
  try {
    const path = join(directory, "empty-secret");
    await writeFile(path, "\n", { mode: 0o600 });
    await assert.rejects(resolveSecretRef(`file://${path}`), /is empty/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file:// rejects a missing file rather than hanging", async () => {
  await assert.rejects(resolveSecretRef("file:///nonexistent/path/for/kinerary/secrets/test"));
});

test("vault:// is refused with a not-implemented error, not a silent wrong value", async () => {
  await assert.rejects(resolveSecretRef("vault://kv/data/kinerary"), /no resolver implementation/);
});

test("an unrecognized scheme is refused", async () => {
  await assert.rejects(resolveSecretRef("ftp://example/secret"), /unrecognized scheme/);
});
