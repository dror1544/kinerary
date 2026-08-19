import { readFile } from "node:fs/promises";

/**
 * How to reach Vault. Resolved from the environment by default so a
 * `vault://` reference in the architecture profile needs no extra profile
 * fields — the profile stays free of environment-specific addressing, which
 * is the same reason the database URL arrives by secret file rather than by
 * profile value.
 */
export interface VaultAccess {
  address: string;
  /** Either the token itself, or `tokenFile` pointing at one. */
  token?: string;
  tokenFile?: string;
  timeoutMs?: number;
}

const VAULT_DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Resolves an opaque secret reference validated by config.ts's
 * `secretReference` schema into its actual value.
 *
 *   env://NAME                  — process environment
 *   file:///path/to/secret      — file contents, trimmed
 *   vault://<api-path>#<field>  — Vault KV, e.g.
 *                                 vault://secret/data/kinerary/telegram#bot_token
 *
 * Every caller passes an already-schema-validated string, so an unrecognized
 * scheme here means the schema and this resolver have drifted, not bad input.
 *
 * `vaultAccess` is injected by tests; production resolves it from
 * VAULT_ADDR / VAULT_TOKEN(_FILE) when a vault:// reference is first seen.
 */
export async function resolveSecretRef(ref: string, vaultAccess?: VaultAccess): Promise<string> {
  if (ref.startsWith("env://")) {
    const name = ref.slice("env://".length);
    const value = process.env[name];
    if (!value) {
      throw new Error(`secret reference env://${name} is unset or empty`);
    }
    return value;
  }
  if (ref.startsWith("file://")) {
    const path = ref.slice("file://".length);
    const value = (await readFile(path, "utf8")).trim();
    if (!value) {
      throw new Error(`secret reference file://${path} is empty`);
    }
    return value;
  }
  if (ref.startsWith("vault://")) {
    return resolveVaultRef(ref, vaultAccess ?? loadVaultAccessFromEnv());
  }
  throw new Error(`secret reference has an unrecognized scheme: ${ref}`);
}

/** Splits `vault://<path>#<field>`. The schema already requires both halves. */
function parseVaultRef(ref: string): { path: string; field: string } {
  const body = ref.slice("vault://".length);
  const separator = body.indexOf("#");
  const path = separator < 0 ? "" : body.slice(0, separator);
  const field = separator < 0 ? "" : body.slice(separator + 1);
  if (!path || !field) {
    throw new Error(`secret reference ${ref} must be vault://<path>#<field>`);
  }
  return { path, field };
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

/**
 * Pins the Vault transport, for the same reason ProxmoxHttpTransport pins
 * https: VAULT_ADDR comes from the operator environment, and plain http would
 * put the Vault token — which unlocks every other secret — on the wire in
 * cleartext. Loopback is the one exception, since that traffic never leaves
 * the host; it is what lets a dev-mode Vault be exercised in tests without
 * weakening the deployed path.
 */
function assertUsableVaultAddress(address: string): URL {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error("VAULT_ADDR is not a valid URL");
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return url;
  throw new Error(`VAULT_ADDR must use https:// (plain http:// is permitted only for loopback, not ${url.protocol}//${url.hostname})`);
}

/**
 * Read only when a vault:// reference is actually resolved, never at module
 * load: an installation whose profile holds no vault:// reference must not
 * need VAULT_ADDR or a Vault token to start.
 */
function loadVaultAccessFromEnv(): VaultAccess {
  const address = process.env.VAULT_ADDR;
  if (!address) {
    throw new Error("a vault:// secret reference requires VAULT_ADDR to be set");
  }
  return { address, token: process.env.VAULT_TOKEN, tokenFile: process.env.VAULT_TOKEN_FILE };
}

async function resolveVaultToken(access: VaultAccess): Promise<string> {
  if (access.token) return access.token;
  if (!access.tokenFile) {
    throw new Error("a vault:// secret reference requires VAULT_TOKEN or VAULT_TOKEN_FILE to be set");
  }
  const value = (await readFile(access.tokenFile, "utf8")).trim();
  if (!value) {
    throw new Error("VAULT_TOKEN_FILE is empty");
  }
  return value;
}

/**
 * Reads one field out of a Vault KV secret.
 *
 * Errors deliberately carry only the reference and an HTTP status — never the
 * token, and never the response body, which holds the other fields of the
 * same secret.
 */
async function resolveVaultRef(ref: string, access: VaultAccess): Promise<string> {
  const { path, field } = parseVaultRef(ref);
  const base = assertUsableVaultAddress(access.address);
  const token = await resolveVaultToken(access);
  const url = new URL(`/v1/${path}`, base);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "X-Vault-Token": token, accept: "application/json" },
      signal: AbortSignal.timeout(access.timeoutMs ?? VAULT_DEFAULT_TIMEOUT_MS),
    });
  } catch {
    // The cause carries the address but can also carry request detail, so it
    // is not chained through.
    throw new Error(`secret reference ${ref} could not reach Vault`);
  }

  if (!response.ok) {
    throw new Error(`secret reference ${ref} was refused by Vault with status ${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`secret reference ${ref} returned a non-JSON Vault response`);
  }

  // KV v2 nests the pairs under data.data; KV v1 puts them directly under
  // data. Supporting both means the reference does not have to encode which
  // engine version a mount happens to be.
  const data = (body as { data?: unknown } | null)?.data;
  const inner = (data as { data?: unknown } | null)?.data;
  const pairs = (inner && typeof inner === "object" ? inner : data) as Record<string, unknown> | null | undefined;

  const value = pairs?.[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`secret reference ${ref} has no non-empty string field "${field}"`);
  }
  return value;
}
