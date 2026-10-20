import { useEffect, useState, type CSSProperties } from "react";

export interface MiniSdk {
  ready?: () => void;
  expand?: () => void;
  platform?: unknown;
  openLink?: (url: string, options?: Record<string, unknown>) => void;
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

/** Telegram's browser clients run the Mini App inside a page frame, which a top-level trip site cannot be shown in. */
const WEB_PLATFORMS = new Set(["web", "weba", "webk"]);
export function isWebClient(sdk: MiniSdk | null): boolean {
  return typeof sdk?.platform === "string" && WEB_PLATFORMS.has(sdk.platform);
}

export interface MiniSdkState { sdk: MiniSdk | null; settled: boolean }

/**
 * SDK is presentation-only. Never reads initData, users, chats or tokens.
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
