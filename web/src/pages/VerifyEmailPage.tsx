import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ApiError, getMe, safeReturnTo, verifyEmail } from "../api";
import { AccountShell, Notice, readEmailToken } from "../components/AccountShell";

type State = { kind: "working" } | { kind: "failed"; code: string; message: string };

/**
 * The page the emailed link opens. It reads the one-time token (URL fragment, or
 * query), removes it from the address bar, spends it exactly once, and carries
 * the person on to where they were headed (`returnTo` rode along in the token).
 */
export default function VerifyEmailPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [state, setState] = useState<State>({ kind: "working" });
  // StrictMode runs effects twice in development; a token can only be spent once.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = readEmailToken(location);
    if (token) window.history.replaceState(window.history.state, "", location.pathname);
    if (!token) { setState({ kind: "failed", code: "TOKEN_INVALID", message: "This link is incomplete. Open the link from your email again." }); return; }
    verifyEmail(token).then(async ({ appPath }) => {
      queryClient.clear();
      await queryClient.fetchQuery({ queryKey: ["me"], queryFn: getMe });
      navigate(safeReturnTo(appPath), { replace: true });
    }).catch((error: unknown) => {
      setState({ kind: "failed", code: error instanceof ApiError ? error.code : "REQUEST_FAILED", message: error instanceof Error ? error.message : "The request could not be completed." });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state.kind === "working") {
    return <AccountShell eyebrow="Kinerary personal space" title="Confirming your email…"><p role="status">One moment while we finish creating your account.</p></AccountShell>;
  }
  return (
    <AccountShell eyebrow="Kinerary personal space" title={state.code === "ACCOUNT_EXISTS" ? "You already have an account" : "This link didn't work"}>
      <Notice>{state.message}</Notice>
      {state.code === "ACCOUNT_EXISTS"
        ? <p><Link to="/sign-in">Sign in</Link> or <Link to="/forgot-password">reset your password</Link>.</p>
        : <p>Links work once and expire. <Link to="/sign-up">Start sign-up again</Link> for a new one, or <Link to="/sign-in">sign in</Link> if you already confirmed.</p>}
    </AccountShell>
  );
}
