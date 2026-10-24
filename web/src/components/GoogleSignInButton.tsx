import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Link } from "react-router-dom";
import { ApiError, getMe, googleNonce, googleSignIn, safeReturnTo } from "../api";
import { isEmbedded, openedByTelegram } from "../mini-app/sdk";
import { Notice } from "./AccountShell";

/** The part of Google Identity Services this page uses (https://accounts.google.com/gsi/client). */
interface GoogleIdentityApi {
  initialize(config: { client_id: string; nonce?: string; callback: (response: { credential?: string }) => void; ux_mode?: "popup"; auto_select?: boolean }): void;
  renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
}
declare global {
  interface Window { google?: { accounts?: { id?: GoogleIdentityApi } } }
}

export const GSI_SCRIPT = "https://accounts.google.com/gsi/client";
let loading: Promise<GoogleIdentityApi> | null = null;

/** Loads Google's script once, on the pages that draw the button and nowhere else. */
export function loadGoogleIdentity(): Promise<GoogleIdentityApi> {
  const ready = window.google?.accounts?.id;
  if (ready) return Promise.resolve(ready);
  // A pending load whose script element is gone (removed by the page, or a test) is not coming; ask again.
  if (loading && !document.head.querySelector(`script[src="${GSI_SCRIPT}"]`)) loading = null;
  loading ??= new Promise<GoogleIdentityApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GSI_SCRIPT;
    script.async = true;
    script.onload = () => {
      const api = window.google?.accounts?.id;
      if (api) resolve(api); else { loading = null; reject(new Error("GOOGLE_SCRIPT_EMPTY")); }
    };
    script.onerror = () => { loading = null; script.remove(); reject(new Error("GOOGLE_SCRIPT_BLOCKED")); };
    document.head.appendChild(script);
  });
  return loading;
}

/** Google's sign-in opens a popup, which Telegram's Mini App window (and any frame) does not allow. */
export function googleSignInUnavailableHere(): boolean {
  return openedByTelegram() || isEmbedded(null);
}

/**
 * "Continue with Google": Google Identity Services draws the button from the PUBLIC client ID the server's
 * capabilities named (never hard-coded here), and hands back a signed ID token, which is posted to
 * POST /v1/auth/google. The server decides who that is; this page only forwards the credential. Sign-up and
 * sign-in are the same act. Renders nothing inside the Telegram Mini App.
 */
export function GoogleSignInButton({ clientId, returnTo }: { clientId: string; returnTo: string }) {
  const container = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  // Google vouched for the token but is not the authority for this address (an outlook.com or company address): the
  // person is sent to the email sign-up instead, whether or not they already have an account.
  const [useEmail, setUseEmail] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const hidden = googleSignInUnavailableHere();
  // The latest values, read by the callback Google holds on to (initialize runs once per mount).
  const latest = useRef({ returnTo, navigate, queryClient });
  latest.current = { returnTo, navigate, queryClient };

  useEffect(() => {
    if (hidden) return;
    let live = true;
    // Each sign-in is single use: the server hands out a nonce (the secret stays in an HttpOnly cookie), Google puts it
    // in the token, and the server spends it on the first attempt. So the button is (re)armed with a fresh nonce on mount
    // and again after every attempt that did not leave the page.
    const arm = async (id: GoogleIdentityApi): Promise<void> => {
      const { nonce } = await googleNonce();
      if (!live || !container.current) return;
      id.initialize({
        client_id: clientId,
        nonce,
        ux_mode: "popup",
        auto_select: false,
        callback: async ({ credential }) => {
          if (!credential) { setError("Google sign-in didn't complete. Please try again."); await arm(id).catch(() => setBlocked(true)); return; }
          setError("");
          setUseEmail(false);
          try {
            const { appPath } = await googleSignIn({ credential, returnTo: latest.current.returnTo });
            latest.current.queryClient.clear();
            await latest.current.queryClient.fetchQuery({ queryKey: ["me"], queryFn: getMe });
            latest.current.navigate(safeReturnTo(appPath));
          } catch (failure) {
            if (failure instanceof ApiError && failure.code === "GOOGLE_USE_EMAIL_SIGN_UP") setUseEmail(true);
            else setError(failure instanceof Error ? failure.message : "Google sign-in didn't work. Please try again.");
            await arm(id).catch(() => setBlocked(true));
          }
        },
      });
      container.current.replaceChildren();
      id.renderButton(container.current, { type: "standard", theme: "outline", size: "large", text: "continue_with", shape: "rectangular", logo_alignment: "left" });
    };
    loadGoogleIdentity().then(arm).catch(() => { if (live) setBlocked(true); });
    return () => { live = false; };
  }, [clientId, hidden]);

  if (hidden) return null;
  return (
    <div className="google-signin">
      <div ref={container} data-testid="google-signin-button" />
      {blocked && <Notice>Google sign-in couldn't load here. Use your email instead.</Notice>}
      {error && <Notice>{error}</Notice>}
      {useEmail && (
        <Notice>
          This address isn't a Google account &mdash; sign up or sign in with your email instead.{" "}
          <Link to={`/sign-up?returnTo=${encodeURIComponent(returnTo)}`}>Sign up</Link> &middot; <Link to={`/sign-in?return_to=${encodeURIComponent(returnTo)}`}>Sign in</Link>
        </Notice>
      )}
    </div>
  );
}
