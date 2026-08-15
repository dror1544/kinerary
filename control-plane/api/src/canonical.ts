const forbiddenKey = /(?:^|_)(?:token|password|secret|api_key|private_key|oauth_grant|refresh_token|host_path|ip_address|vmid)(?:$|_)/i;
const forbiddenValue = /(?:\bBearer\s+[A-Za-z0-9._~+/-]+=*|PVEAPIToken=|-----BEGIN [A-Z ]*PRIVATE KEY-----|\/Users\/|\/home\/|(?:^|[^\d])(?:10\.|127\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)\d{1,3}\.\d{1,3})/i;

export class UnsafeCanonicalRecordError extends Error {}

export function assertCanonicalRecordSafe(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertCanonicalRecordSafe(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const isOpaqueSecretReference = key.endsWith("_secret_ref");
      if (forbiddenKey.test(key) && !isOpaqueSecretReference) {
        throw new UnsafeCanonicalRecordError(`forbidden canonical key at ${path}.${key}`);
      }
      assertCanonicalRecordSafe(child, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === "string" && forbiddenValue.test(value)) {
    throw new UnsafeCanonicalRecordError(`forbidden canonical value at ${path}`);
  }
}
