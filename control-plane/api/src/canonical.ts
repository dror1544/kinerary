// Application-layer twin of control_plane.canonical_json_is_safe
// (db/migrations/0004_canonical_guardrail_key_matching.sql).
//
// The database constraint is the authority: it is the last thing a record
// passes before it becomes durable, and it holds even for a writer that never
// calls this module. This exists so a caller finds out *which* field is
// unsafe, at the point it builds the record, instead of getting an opaque
// CHECK violation from PostgreSQL at INSERT time.
//
// An earlier version of this file was transliterated by hand and drifted: it
// carried the same three defects later fixed in 0004 — key matching anchored
// to snake_case boundaries so camelCase walked through, a *_secret_ref
// exemption that never checked the value, and a private-address pattern that
// needed only three octets. Both layers are now driven from the shared
// fixtures in contracts/v1/canonical-fixtures.json, and a parity test asserts
// they agree on every one. Change the regexes here and in 0004 together, or
// the parity test fails.

const secretReferenceKey = /secret[_-]?ref$/i;
const opaqueReference = /^(?:env|file|vault):\/\//;
const sensitiveKey =
  /(?:token|password|passphrase|credential|secret|authorization|cookie|api[_-]?key|private[_-]?key|oauth[_-]?grant|host[_-]?path|ip[_-]?address|vmid|telegram[_-]?id|chat[_-]?id)/i;
const sensitiveValue = /(?:Bearer\s+\S+|PVEAPIToken=|\/Users\/|\/home\/)/i;
// A whole dotted quad, so a semver like 10.15.7 or a date like 10.11.2025 is
// not mistaken for an address.
const privateIpv4 =
  /(?:^|[^0-9.])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?:[^0-9.]|$)/;

export class UnsafeCanonicalRecordError extends Error {
  constructor(readonly path: string, readonly reason: string) {
    // The offending value is deliberately never interpolated — this error is
    // logged, and quoting the secret would defeat the check that caught it.
    super(`unsafe canonical record at ${path}: ${reason}`);
    this.name = "UnsafeCanonicalRecordError";
  }
}

/**
 * Throws {@link UnsafeCanonicalRecordError} naming the offending path.
 *
 * Expects JSON-compatible input, the same shape PostgreSQL sees as jsonb.
 */
export function assertCanonicalRecordSafe(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertCanonicalRecordSafe(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (secretReferenceKey.test(key)) {
        // A reference key may name a secret, never inline one.
        if (typeof child !== "string" || !opaqueReference.test(child)) {
          throw new UnsafeCanonicalRecordError(childPath, "secret reference must be env://, file:// or vault://");
        }
      } else if (sensitiveKey.test(key)) {
        throw new UnsafeCanonicalRecordError(childPath, "sensitive key may not appear in a canonical record");
      }
      assertCanonicalRecordSafe(child, childPath);
    }
    return;
  }
  if (typeof value === "string") {
    if (sensitiveValue.test(value)) {
      throw new UnsafeCanonicalRecordError(path, "credential or host path in value");
    }
    if (privateIpv4.test(value)) {
      throw new UnsafeCanonicalRecordError(path, "private address in value");
    }
  }
}

/**
 * The private-address definition this guard rejects, exposed so the release
 * sanitation scan (release-artifact.ts) tests shipped source against the exact
 * same pattern the canonical-record guard uses. The credential/host-path value
 * pattern is deliberately not re-exported: it matches `Bearer \S+`, which is a
 * legitimate literal in client fetch() code, so the scan carries its own
 * higher-signal credential set instead.
 */
export const privateIpv4Pattern: RegExp = privateIpv4;

/** Boolean form, mirroring the SQL function's return value for parity tests. */
export function isCanonicalRecordSafe(value: unknown): boolean {
  try {
    assertCanonicalRecordSafe(value);
    return true;
  } catch (error) {
    if (error instanceof UnsafeCanonicalRecordError) return false;
    throw error;
  }
}
