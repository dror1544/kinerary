import type { ReactNode } from "react";
import { Brand } from "./Brand";

/** The frame the account pages (sign-up, verify, forgot, reset) share with the sign-in page. */
export function AccountShell({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return (
    <div className="product-shell">
      <header className="product-header"><Brand /></header>
      <main className="placeholder-card">
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {children}
      </main>
    </div>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return <div className="notice" role="alert">{children}</div>;
}

/** The language the emails go out in: Hebrew for a Hebrew browser, English otherwise. */
export function mailLanguage(): "he" | "en" {
  return typeof navigator !== "undefined" && /^he\b/i.test(navigator.language || "") ? "he" : "en";
}

/**
 * The one-time token from an emailed link. The link carries it in the URL
 * FRAGMENT (`#token=…`), which the browser never sends to a server; a query
 * string (`?token=…`) is accepted too. It is removed from the address bar once
 * read so it does not sit in history or a screenshot.
 */
export function readEmailToken(location: { hash: string; search: string }): string {
  const fromHash = new URLSearchParams(location.hash.replace(/^#/, "")).get("token");
  const fromQuery = new URLSearchParams(location.search).get("token");
  return fromHash ?? fromQuery ?? "";
}
