import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type ApprovalAction = "approve" | "reject";

interface ActionPayload {
  requestId: string;
  action: ApprovalAction;
  /** Unix milliseconds */
  expiresAt: number;
}

export interface SignedAction {
  /** Opaque token sent to the super-admin via Telegram. */
  token: string;
  /** sha256:hex of the full token, for log correlation. */
  digest: string;
  expiresAt: Date;
}

/**
 * Returns an opaque HMAC-signed token embedding requestId, action, and expiry.
 * The token structure is: base64url(payload_json) + "." + HMAC-SHA256-hex(base64url(payload_json)).
 * No raw requestId or timestamps appear after encoding.
 */
export function signApprovalAction(
  requestId: string,
  action: ApprovalAction,
  secret: string,
  options: { ttlSeconds?: number; nowMs?: number } = {},
): SignedAction {
  const ttlSeconds = options.ttlSeconds ?? 3600;
  const nowMs = options.nowMs ?? Date.now();
  const expiresAt = nowMs + ttlSeconds * 1000;

  const payload: ActionPayload = { requestId, action, expiresAt };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const hmac = createHmac("sha256", secret).update(payloadB64).digest("hex");
  const token = `${payloadB64}.${hmac}`;
  const digest = "sha256:" + createHash("sha256").update(token).digest("hex");

  return { token, digest, expiresAt: new Date(expiresAt) };
}

export type VerifyActionResult =
  | { valid: true; requestId: string; action: ApprovalAction }
  | { valid: false; reason: "INVALID_TOKEN" | "EXPIRED_TOKEN" | "INVALID_SIGNATURE" };

/** Verifies a token produced by {@link signApprovalAction}. Timing-safe. */
export function verifyApprovalAction(
  token: string,
  secret: string,
  options: { nowMs?: number } = {},
): VerifyActionResult {
  const nowMs = options.nowMs ?? Date.now();

  const dotIndex = token.lastIndexOf(".");
  if (dotIndex < 1) return { valid: false, reason: "INVALID_TOKEN" };

  const payloadB64 = token.slice(0, dotIndex);
  const providedHmex = token.slice(dotIndex + 1);

  const expectedHmex = createHmac("sha256", secret).update(payloadB64).digest("hex");
  let expectedBuf: Buffer, providedBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expectedHmex, "hex");
    providedBuf = Buffer.from(providedHmex, "hex");
  } catch {
    return { valid: false, reason: "INVALID_TOKEN" };
  }
  if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
    return { valid: false, reason: "INVALID_SIGNATURE" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
  } catch {
    return { valid: false, reason: "INVALID_TOKEN" };
  }
  if (!isActionPayload(payload)) return { valid: false, reason: "INVALID_TOKEN" };

  if (nowMs > payload.expiresAt) return { valid: false, reason: "EXPIRED_TOKEN" };

  return { valid: true, requestId: payload.requestId, action: payload.action };
}

function isActionPayload(v: unknown): v is ActionPayload {
  return (
    v !== null &&
    typeof v === "object" &&
    typeof (v as ActionPayload).requestId === "string" &&
    ((v as ActionPayload).action === "approve" || (v as ActionPayload).action === "reject") &&
    typeof (v as ActionPayload).expiresAt === "number"
  );
}
