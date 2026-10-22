import { useEffect, useState, type CSSProperties } from "react";

export interface MiniSdk {
  ready?: () => void;
  expand?: () => void;
  platform?: unknown;
  openLink?: (url: string, options?: Record<string, unknown>) => void;
  /** The signed launch string. Read only to be sent to the server; see readLaunch. */
  initData?: unknown;
  themeParams?: Record<string, unknown>;
  safeAreaInset?: Record<string, unknown>;
  contentSafeAreaInset?: Record<string, unknown>;
  BackButton?: { show?: () => void; hide?: () => void; onClick?: (handler: () => void) => void; offClick?: (handler: () => void) => void };
  onEvent?: (event: string, handler: () => void) => void;
  offEvent?: (event: string, handler: () => void) => void;
}
function availableSdk(): MiniSdk | null {
  const telegram = (window as unknown as { Telegram?: { WebApp?: unknown } }).Telegram;
  return telegram?.WebApp && typeof telegram.WebApp === "object" ? telegram.WebApp as MiniSdk : null;
}
export function safely(operation: (() => void) | undefined) {
  try { if (typeof operation === "function") operation(); } catch { /* Older hosts keep ordinary browser controls. */ }
}

/**
 * Whether this page was opened by Telegram at all, decided WITHOUT waiting for
 * the SDK script: Telegram puts its launch parameters in the URL fragment, and
 * the SDK keeps them in sessionStorage for reloads. An ordinary browser has
 * neither, and must not sit waiting for a script that will never identify it.
 */
export function openedByTelegram(): boolean {
  if (new URLSearchParams(window.location.hash.slice(1)).has("tgWebAppData")) return true;
  try { if (window.sessionStorage.getItem("__telegram__initParams")) return true; } catch { /* storage may be blocked */ }
  const initData = availableSdk()?.initData;
  return typeof initData === "string" && initData.length > 0;
}

export interface MiniLaunch {
  /** The signed string exactly as Telegram gave it, or null. Sent to the server, never parsed here. */
  initData: string | null;
  platform: string | null;
}

/**
 * The ONE place the client touches `initData`, and only to send it to
 * `POST /v1/auth/telegram-mini-app`. It never reads `initDataUnsafe` or decodes
 * the string: the server verifies the signature and decides who this is, and a
 * client-side "user.id" would be the unsigned half of the same data.
 *
 * The SDK's value wins; the URL fragment is the fallback for the moments before
 * the SDK script has loaded.
 */
export function readLaunch(sdk: MiniSdk | null): MiniLaunch {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const fromSdk = typeof sdk?.initData === "string" && sdk.initData.length > 0 ? sdk.initData : null;
  const fromHash = params.get("tgWebAppData");
  const platform = typeof sdk?.platform === "string" ? sdk.platform : params.get("tgWebAppPlatform");
  return { initData: fromSdk ?? (fromHash && fromHash.length > 0 ? fromHash : null), platform: platform || null };
}

/** Telegram's own names for the web clients, which run Mini Apps in an iframe on web.telegram.org. */
const WEB_CLIENT_PLATFORMS = new Set(["web", "weba", "webk"]);

/** Telegram's browser clients run the Mini App inside a page frame, which a top-level trip site cannot be shown in. */
export function isWebClient(sdk: MiniSdk | null): boolean {
  return typeof sdk?.platform === "string" && WEB_CLIENT_PLATFORMS.has(sdk.platform);
}

/**
 * Is this page inside a frame on another site? True in Telegram Web, where a
 * `SameSite=Lax` cookie is never sent and the session has to be the partitioned
 * cross-site variant. Both signals count: the frame itself (`window.top`, which
 * throws across origins — also "embedded"), and the platform Telegram reports,
 * which is definitive for its own web clients.
 */
export function isEmbedded(platform: string | null): boolean {
  if (platform && WEB_CLIENT_PLATFORMS.has(platform)) return true;
  try { return window.self !== window.top; } catch { return true; }
}

/** Removes the launch fragment from the address bar (and so from history, screenshots, logs and shares). */
export function stripLaunchFragment(): void {
  if (!new URLSearchParams(window.location.hash.slice(1)).has("tgWebAppData")) return;
  try {
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
  } catch { /* a host that forbids it keeps the fragment; nothing else depends on it */ }
}

export interface MiniSdkState { sdk: MiniSdk | null; settled: boolean }

/**
 * SDK is presentation-only except for `readLaunch`. Never reads initDataUnsafe, users, chats or tokens.
 * `settled` says whether the script has finished loading (or failed, or been
 * given up on after a few seconds), so the trip launcher knows the platform
 * before it chooses between submitting in place and handing a browser tab the link.
 */
export function useMiniSdkState(): MiniSdkState {
  const [state, setState] = useState<MiniSdkState>(() => { const sdk = availableSdk(); return { sdk, settled: Boolean(sdk) }; });
  useEffect(() => {
    if (availableSdk()) { setState({ sdk: availableSdk(), settled: true }); return; }
    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-web-app.js";
    script.async = true;
    const giveUp = window.setTimeout(() => setState((current) => current.settled ? current : { sdk: availableSdk(), settled: true }), 4000);
    script.onload = () => setState({ sdk: availableSdk(), settled: true });
    script.onerror = () => setState({ sdk: null, settled: true });
    document.head.append(script);
    return () => { window.clearTimeout(giveUp); script.onload = null; script.onerror = null; script.remove(); };
  }, []);
  return state;
}

export function useMiniSdk(): MiniSdk | null {
  return useMiniSdkState().sdk;
}

export function miniStyles(sdk: MiniSdk | null): CSSProperties {
  const styles: Record<string, string> = {};
  for (const [field, variable] of [["bg_color", "--mini-bg"], ["text_color", "--mini-text"], ["button_color", "--mini-accent"]]) {
    const value = sdk?.themeParams?.[field];
    if (typeof value === "string" && /^#[a-fA-F0-9]{6}$/.test(value)) styles[variable] = value;
  }
  for (const side of ["top", "bottom", "left", "right"]) {
    const values = [sdk?.safeAreaInset?.[side], sdk?.contentSafeAreaInset?.[side]];
    const bounded = values.map(value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 256 ? value : 0);
    styles[`--mini-${side}`] = `${Math.max(...bounded)}px`;
  }
  return styles as CSSProperties;
}
