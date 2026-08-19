import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveSecretRef, type VaultAccess } from "../src/secrets.js";

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

test("an unrecognized scheme is refused", async () => {
  await assert.rejects(resolveSecretRef("ftp://example/secret"), /unrecognized scheme/);
});

// ── vault:// transport and shape rules (no Vault server required) ───────────

const unreachable: VaultAccess = { address: "https://vault.invalid:8200", token: "t", timeoutMs: 1000 };

test("vault:// requires both a path and a field", async () => {
  await assert.rejects(
    resolveSecretRef("vault://secret/data/kinerary", unreachable),
    /must be vault:\/\/<path>#<field>/,
  );
});

test("vault:// refuses plain http to a non-loopback address", async () => {
  await assert.rejects(
    resolveSecretRef("vault://secret/data/x#f", { address: "http://vault.internal:8200", token: "t" }),
    /must use https/,
  );
});

test("vault:// permits plain http on loopback only", async () => {
  // Nothing is listening, so this must fail at the connection, not at the pin —
  // which is what proves loopback http got past the scheme check.
  for (const address of ["http://127.0.0.1:1/", "http://localhost:1/"]) {
    await assert.rejects(
      resolveSecretRef("vault://secret/data/x#f", { address, token: "t", timeoutMs: 1000 }),
      /could not reach Vault/,
      `expected ${address} to pass the scheme pin`,
    );
  }
});

test("vault:// accepts https and fails at the connection instead of the pin", async () => {
  await assert.rejects(resolveSecretRef("vault://secret/data/x#f", unreachable), /could not reach Vault/);
});

test("vault:// rejects a malformed address", async () => {
  await assert.rejects(
    resolveSecretRef("vault://secret/data/x#f", { address: "not-a-url", token: "t" }),
    /not a valid URL/,
  );
});

const VAULT_ENV_KEYS = ["VAULT_ADDR", "VAULT_TOKEN", "VAULT_TOKEN_FILE"] as const;

/** Assigning `undefined` to process.env stores the string "undefined", so unset must be a delete. */
function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearVaultEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of VAULT_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return saved;
}

test("vault:// requires an address and a token from the environment", async () => {
  const saved = clearVaultEnv();
  try {
    await assert.rejects(resolveSecretRef("vault://secret/data/x#f"), /requires VAULT_ADDR/);
    process.env.VAULT_ADDR = "https://vault.invalid:8200";
    await assert.rejects(resolveSecretRef("vault://secret/data/x#f"), /requires VAULT_TOKEN/);
  } finally {
    restoreEnv(saved);
  }
});

test("vault:// reads its token from VAULT_TOKEN_FILE when VAULT_TOKEN is unset", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kinerary-control-plane-vault-"));
  const saved = clearVaultEnv();
  try {
    const path = join(directory, "vault-token");
    await writeFile(path, "token-from-file\n", { mode: 0o600 });
    process.env.VAULT_ADDR = "https://vault.invalid:8200";
    process.env.VAULT_TOKEN_FILE = path;
    // Reaching the connection failure means the token file was read without
    // complaint; an unreadable or empty file fails earlier with its own error.
    await assert.rejects(resolveSecretRef("vault://secret/data/x#f"), /could not reach Vault/);
    await writeFile(path, "\n", { mode: 0o600 });
    await assert.rejects(resolveSecretRef("vault://secret/data/x#f"), /VAULT_TOKEN_FILE is empty/);
  } finally {
    await rm(directory, { recursive: true, force: true });
    restoreEnv(saved);
  }
});

// ── vault:// against a real Vault ───────────────────────────────────────────
// Started by control-plane/db/compose.test.yml; the address is passed in
// explicitly so a developer without the container simply skips these.

const vaultAddress = process.env.CONTROL_PLANE_TEST_VAULT_ADDR;
const vaultToken = process.env.CONTROL_PLANE_TEST_VAULT_TOKEN ?? "kinerary-test-root-token";
const skipVault = !vaultAddress;
const access: VaultAccess = { address: vaultAddress ?? "", token: vaultToken, timeoutMs: 5000 };

async function vaultWrite(path: string, body: unknown): Promise<void> {
  const response = await fetch(new URL(`/v1/${path}`, vaultAddress), {
    method: "POST",
    headers: { "X-Vault-Token": vaultToken, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok && response.status !== 204) {
    throw new Error(`vault seed write to ${path} failed with ${response.status}`);
  }
}

test("vault:// reads a field from a real KV v2 secret", { skip: skipVault }, async () => {
  await vaultWrite("secret/data/kinerary/telegram", {
    data: { bot_token: "kv2-bot-token-value", other_field: "not-this-one" },
  });
  assert.equal(
    await resolveSecretRef("vault://secret/data/kinerary/telegram#bot_token", access),
    "kv2-bot-token-value",
  );
  // The selector must actually select, not return the first pair.
  assert.equal(
    await resolveSecretRef("vault://secret/data/kinerary/telegram#other_field", access),
    "not-this-one",
  );
});

test("vault:// reads a field from a real KV v1 secret", { skip: skipVault }, async () => {
  // Dev mode mounts KV v2 at secret/; mount a v1 engine so the version-agnostic
  // extraction is exercised against both engines rather than assumed.
  const mount = await fetch(new URL("/v1/sys/mounts/kv1-test", vaultAddress), {
    method: "POST",
    headers: { "X-Vault-Token": vaultToken, "content-type": "application/json" },
    body: JSON.stringify({ type: "kv", options: { version: "1" } }),
  });
  assert.ok(mount.ok || mount.status === 400, `unexpected mount status ${mount.status}`);
  await vaultWrite("kv1-test/kinerary", { action_secret: "kv1-action-secret-value" });
  assert.equal(
    await resolveSecretRef("vault://kv1-test/kinerary#action_secret", access),
    "kv1-action-secret-value",
  );
});

test("vault:// rejects a field the secret does not carry", { skip: skipVault }, async () => {
  await vaultWrite("secret/data/kinerary/partial", { data: { present: "yes" } });
  await assert.rejects(
    resolveSecretRef("vault://secret/data/kinerary/partial#absent", access),
    /has no non-empty string field "absent"/,
  );
});

test("vault:// surfaces a refused token as a status, without echoing the token", { skip: skipVault }, async () => {
  const wrong: VaultAccess = { ...access, token: "definitely-not-the-root-token" };
  await assert.rejects(
    resolveSecretRef("vault://secret/data/kinerary/telegram#bot_token", wrong),
    (error: Error) => {
      assert.match(error.message, /refused by Vault with status 40[34]/);
      assert.doesNotMatch(error.message, /definitely-not-the-root-token/);
      return true;
    },
  );
});

test("vault:// surfaces a missing path as a status, not as a silent empty value", { skip: skipVault }, async () => {
  await assert.rejects(
    resolveSecretRef("vault://secret/data/kinerary/no-such-secret#any", access),
    /refused by Vault with status 404/,
  );
});
