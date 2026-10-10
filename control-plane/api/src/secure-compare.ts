/**
 * Constant-time comparison for a caller-supplied secret against a configured
 * one — the TS side of `server/server.js`'s `timingSafeKeyMatch` (#184),
 * which this mirrors exactly rather than the weaker
 * `a.length === b.length && timingSafeEqual(a, b)` shape already in
 * `interview-mcp.ts` and the plain `===` already in `app.ts`'s `adminAuth`.
 * Those two predate this helper and are untouched here — fixing them is a
 * separate change, not part of this one — but a NEW key check has no excuse
 * to repeat either weaker shape now that this exists.
 *
 * Why hash first rather than just `timingSafeEqual(a, b)` after a length
 * check: `crypto.timingSafeEqual` THROWS on a length mismatch, and the
 * length check needed to avoid that throw is itself the leak — a caller that
 * can measure response time learns the configured secret's length one probe
 * at a time. Hashing both sides to a fixed 32-byte SHA-256 digest first means
 * the two buffers compared are always the same length regardless of what the
 * caller sent, so `timingSafeEqual` never throws and never takes a path whose
 * timing depends on the supplied value's length.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * `expected` empty means the feature is unconfigured — refused without ever
 * hashing or comparing the (irrelevant) supplied value, so an unconfigured
 * key cannot be probed into a false positive by an empty or absent header.
 */
export function timingSafeKeyMatch(supplied: unknown, expected: string): boolean {
  if (!expected) return false;
  const suppliedStr = typeof supplied === "string" ? supplied : "";
  const suppliedDigest = createHash("sha256").update(suppliedStr).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}
