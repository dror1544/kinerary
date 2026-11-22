import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ApiError, getMe, redeemSignInLink, safeReturnTo, setSignInLinkPassword } from "../api";
import { AccountShell, Notice, readEmailToken } from "../components/AccountShell";

/**
 * The page a sign-in link opens (docs/specs/sprint-9/x-member-sign-in.md, S3). The token is read from the URL FRAGMENT once,
 * held in memory and taken out of the address bar, exactly like the reset page.
 *
 * OPENING THIS PAGE SPENDS NOTHING. Telegram and mail clients fetch a link to draw a preview, and a fragment never leaves the
 * browser, so the fetch carries no token; and the page itself posts only when the person presses "Sign in". The same shape as
 * `/verify-email` and `/reset-password`.
 *
 * AFTER SIGNING IN, if the account has a password that can be replaced (the server says so; a Telegram-scoped session has
 * none), the page offers once to set a new one, and the person may skip. Nothing is offered that the server will refuse.
 */
export default function SignInLinkPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [token] = useState(() => readEmailToken(location));
  const scrubbed = useRef(false);
  useEffect(() => {
    if (scrubbed.current) return;
    scrubbed.current = true;
    if (token) window.history.replaceState(window.history.state, "", location.pathname);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [stage, setStage] = useState<{ name: "ready" } | { name: "password"; appPath: string }>({ name: "ready" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [pending, setPending] = useState(false);

  const fail = (caught: unknown) => {
    setError({ code: caught instanceof ApiError ? caught.code : "REQUEST_FAILED", message: caught instanceof Error ? caught.message : "The request could not be completed." });
    setPending(false);
  };

  if (!token || error?.code === "TOKEN_INVALID") {
    return (
      <AccountShell eyebrow="Sign-in link" title="This link didn't work">
        <Notice>{token ? error!.message : "This link is incomplete. Open the link from your message again."}</Notice>
        <p>Links work once and expire after 30 minutes. Go back to the <Link to="/sign-in">sign-in screen</Link> and ask for a new one.</p>
      </AccountShell>
    );
  }

  const signIn = async () => {
    setError(null);
    setPending(true);
    try {
      const { appPath, canSetPassword } = await redeemSignInLink({ token });
      queryClient.clear();
      await queryClient.fetchQuery({ queryKey: ["me"], queryFn: getMe });
      if (canSetPassword) { setStage({ name: "password", appPath }); setPending(false); return; }
      navigate(safeReturnTo(appPath), { replace: true });
    } catch (caught) { fail(caught); }
  };

  if (stage.name === "password") {
    const go = () => navigate(safeReturnTo(stage.appPath), { replace: true });
    const submit = async (event: FormEvent) => {
      event.preventDefault();
      if (password !== confirm) { setError({ code: "MISMATCH", message: "The two passwords don't match." }); return; }
      setError(null);
      setPending(true);
      try { await setSignInLinkPassword({ password }); go(); } catch (caught) { fail(caught); }
    };
    return (
      <AccountShell eyebrow="Sign-in link" title="Set a new password?">
        <p>You're signed in. If you forgot your password, choose a new one now; you'll be signed out on your other devices. Or skip it and keep the one you have.</p>
        <form className="compact-form" onSubmit={submit}>
          <label>New password<input required type="password" minLength={8} maxLength={1024} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <label>Repeat it<input required type="password" minLength={8} maxLength={1024} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
          <button className="button wide" disabled={pending}>{pending ? "Saving…" : "Save password"}</button>
          {error && <Notice>{error.message}</Notice>}
        </form>
        <p><button type="button" className="text-button" onClick={go}>Skip for now</button></p>
      </AccountShell>
    );
  }
  return (
    <AccountShell eyebrow="Sign-in link" title="Sign in to Kinerary">
      <p>Press the button to sign in. This link works once.</p>
      <button className="button wide" disabled={pending} onClick={() => void signIn()}>{pending ? "Signing in…" : "Sign in"}</button>
      {error && <Notice>{error.message}</Notice>}
    </AccountShell>
  );
}
