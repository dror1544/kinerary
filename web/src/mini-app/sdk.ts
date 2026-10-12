import { useEffect, useState, type CSSProperties } from "react";

export interface MiniSdk {
  ready?: () => void;
  expand?: () => void;
  platform?: unknown;
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

/** SDK is presentation-only. Never reads initData, users, chats or tokens. */
export function useMiniSdk(): MiniSdk | null {
  const [sdk, setSdk] = useState<MiniSdk | null>(availableSdk);
  useEffect(() => {
    if (availableSdk()) { setSdk(availableSdk()); return; }
    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-web-app.js";
    script.async = true;
    script.onload = () => setSdk(availableSdk());
    script.onerror = () => setSdk(null);
    document.head.append(script);
    return () => { script.onload = null; script.onerror = null; script.remove(); };
  }, []);
  return sdk;
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
