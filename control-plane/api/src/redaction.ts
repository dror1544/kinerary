// Kept in sync with control_plane.canonical_json_is_safe (db/migrations/0004).
const sensitiveKey = /(?:token|password|passphrase|credential|secret|authorization|cookie|api[_-]?key|private[_-]?key|telegram[_-]?id|chat[_-]?id)/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      sensitiveKey.test(key) ? "[REDACTED]" : redact(child),
    ]));
  }
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/PVEAPIToken=\S+/gi, "PVEAPIToken=[REDACTED]");
  }
  return value;
}

export function structuredLog(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>): string {
  return JSON.stringify({ level, event, ...redact(fields) as Record<string, unknown> });
}
