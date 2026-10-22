export type MiniAppLaunch = { kind: "account" } | { kind: "trip"; tripId: string } | { kind: "invalid" };
export const tripIdPattern = /^trip_[A-Za-z0-9]{8,64}$/;

/** Routing hints only; the ordinary API session remains the authority. */
export function miniAppLaunch(search: string): MiniAppLaunch {
  const params = new URLSearchParams(search);
  const selectors = [...params.getAll("startapp"), ...params.getAll("tgWebAppStartParam")];
  if (selectors.length === 0) return { kind: "account" };
  if (selectors.length !== 1) return { kind: "invalid" };
  const value = selectors[0];
  if (value === "account") return { kind: "account" };
  return tripIdPattern.test(value) ? { kind: "trip", tripId: value } : { kind: "invalid" };
}

const MARKER_KEY = "kinerary-mini-app-launch";

/**
 * A short digest of the launch string, so the page can tell "this exact launch
 * already signed in" (a WebView reload) from "Telegram opened me again" (a new
 * launch, new initData). Not a secret and not stored in the clear: the marker
 * is a fingerprint, never the string itself.
 *
 * SubtleCrypto is the real SHA-256; the FNV-1a fallback is for a host without
 * it (an insecure context), where a collision costs at worst one redundant
 * exchange.
 */
export async function digestInitData(initData: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const bytes = new TextEncoder().encode(initData);
    const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
    return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  let hash = 0x811c9dc5;
  for (let i = 0; i < initData.length; i++) { hash ^= initData.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return `fnv1a:${hash.toString(16)}:${initData.length}`;
}

export const launchMarker = {
  read(): string | null {
    try { return window.sessionStorage.getItem(MARKER_KEY); } catch { return null; }
  },
  write(digest: string): void {
    try { window.sessionStorage.setItem(MARKER_KEY, digest); } catch { /* the cost is one redundant exchange on reload */ }
  },
  clear(): void {
    try { window.sessionStorage.removeItem(MARKER_KEY); } catch { /* nothing to clear */ }
  },
};
