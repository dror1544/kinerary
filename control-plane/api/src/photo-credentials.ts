/**
 * The photo-library credential at rest (docs/specs/sprint-9/699-user-photo-library.md, AC-3).
 *
 * AES-256-GCM under a key the deployment supplies by secret reference (`photo_library.credential_key_secret_ref`,
 * resolved through secrets.ts on every use, so a rotated file is picked up without a restart). The key is 32 random
 * bytes, written base64; anything else is refused loudly, never padded or hashed into shape.
 *
 *   - A fresh random 96-bit nonce per encryption.
 *   - `credential_key_id` = "k_" + the first 16 hex characters of sha256(key): a fingerprint that names the key without
 *     revealing it, so a row says which key sealed it.
 *   - The authenticated data is `photo-credential:v1:<key id>:<connection id>:<user id>`: a sealed credential cannot be
 *     copied onto another row or another user's row and still open.
 *   - Stored as base64url(nonce || tag || ciphertext).
 *
 * A row sealed under a key that is not the current one cannot be opened (`credential_key_rotated`): the connection then
 * reads `needs_reconnect` and its owner reconnects. Rotating without a reconnect (a list of earlier keys) is a later item.
 *
 * No error here carries the key, the plaintext or the ciphertext.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { resolveSecretRef } from "./secrets.js";

export interface CredentialKey {
  id: string;
  key: Buffer;
}

export type CredentialErrorCode = "credential_key_invalid" | "credential_key_unresolved" | "credential_key_rotated" | "credential_unreadable";

export class PhotoCredentialError extends Error {
  readonly code: CredentialErrorCode;
  constructor(code: CredentialErrorCode, message: string) {
    super(message);
    this.name = "PhotoCredentialError";
    this.code = code;
  }
  toJSON(): { code: CredentialErrorCode } { return { code: this.code }; }
}

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function credentialKeyId(key: Buffer): string {
  return `k_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

/** Decodes the configured secret. Exactly 32 bytes of standard or URL-safe base64, nothing else. */
export function credentialKeyFromSecret(secret: string): CredentialKey {
  const text = secret.trim();
  if (!/^[A-Za-z0-9+/_-]{43}={0,1}$/.test(text)) {
    throw new PhotoCredentialError("credential_key_invalid", "the photo-library credential key must be 32 bytes, written base64");
  }
  const key = Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (key.length !== 32) throw new PhotoCredentialError("credential_key_invalid", "the photo-library credential key must be 32 bytes, written base64");
  return { id: credentialKeyId(key), key };
}

/** Resolves the reference and decodes the key. The error names the failure, never the value behind the reference. */
export async function loadCredentialKey(ref: string, resolve: (ref: string) => Promise<string> = resolveSecretRef): Promise<CredentialKey> {
  let secret: string;
  try {
    secret = await resolve(ref);
  } catch {
    throw new PhotoCredentialError("credential_key_unresolved", "the photo-library credential key reference could not be resolved");
  }
  return credentialKeyFromSecret(secret);
}

function additionalData(keyId: string, binding: { connectionId: string; userId: string }): Buffer {
  return Buffer.from(`photo-credential:v1:${keyId}:${binding.connectionId}:${binding.userId}`, "utf8");
}

export function encryptCredential(key: CredentialKey, plaintext: string, binding: { connectionId: string; userId: string }): { ciphertext: string; keyId: string } {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key.key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(additionalData(key.id, binding));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext: Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64url"), keyId: key.id };
}

export function decryptCredential(
  key: CredentialKey,
  sealed: { ciphertext: string; keyId: string },
  binding: { connectionId: string; userId: string },
): string {
  if (sealed.keyId !== key.id) {
    throw new PhotoCredentialError("credential_key_rotated", "the credential was sealed under a key that is no longer configured");
  }
  try {
    const raw = Buffer.from(sealed.ciphertext, "base64url");
    if (raw.length < NONCE_BYTES + TAG_BYTES) throw new Error("short");
    const decipher = createDecipheriv("aes-256-gcm", key.key, raw.subarray(0, NONCE_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAAD(additionalData(sealed.keyId, binding));
    decipher.setAuthTag(raw.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(NONCE_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    throw new PhotoCredentialError("credential_unreadable", "the stored credential could not be opened");
  }
}
