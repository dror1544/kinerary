import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ApiError, getMe, safeReturnTo, verifyEmail } from "../api";
import { AccountShell, Notice, readEmailToken } from "../components/AccountShell";

/**
 * The page the emailed link opens. OPENING IT SPENDS NOTHING: it reads the
 * one-time token (URL fragment, or query), removes it from the address bar and
 * holds it in memory, and asks the person to choose their password. Only the
 * submit sends the token, together with the password, to create the account.
 *
 * The password is chosen HERE and not at sign-up because anyone can start a
 * sign-up for anybody's address: a password typed there would be known to a
 * stranger the moment the real owner clicked the link. Here it is typed by the
 * person holding the mailbox. It also means a mail scanner that fetches the link
 * burns no token.
 */
export default function VerifyEmailPage() {
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
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [pending, setPending] = useState(false);

  if (!token || error?.code === "TOKEN_INVALID" || error?.code === "ACCOUNT_EXISTS") {
    const exists = error?.code === "ACCOUNT_EXISTS";
    return (
      <AccountShell eyebrow="Kinerary personal space" title={exists ? "You already have an account" : "This link didn't work"}>
        <Notice>{error ? error.message : "This link is incomplete. Open the link from your email again."}</Notice>
        {exists
          ? <p><Link to="/sign-in">Sign in</Link> or <Link to="/forgot-password">reset your password</Link>.</p>
          : <p>Links work once and expire. <Link to="/sign-up">Start sign-up again</Link> for a new one, or <Link to="/sign-in">sign in</Link> if you already finished.</p>}
      </AccountShell>
    );
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirm) { setError({ code: "MISMATCH", message: "The two passwords don't match." }); return; }
    setError(null);
    setPending(true);
    try {
      const { appPath } = await verifyEmail({ token, password });
      queryClient.clear();
      await queryClient.fetchQuery({ queryKey: ["me"], queryFn: getMe });
      navigate(safeReturnTo(appPath), { replace: true });
    } catch (caught) {
      setError({ code: caught instanceof ApiError ? caught.code : "REQUEST_FAILED", message: caught instanceof Error ? caught.message : "The request could not be completed." });
      setPending(false);
    }
  };
  return (
    <AccountShell eyebrow="Kinerary personal space" title="Choose your password">
      <p>Your email address is confirmed by this link. Choose a password to finish creating your account; you'll be signed in afterwards.</p>
      <form className="compact-form" onSubmit={submit}>
        <label>Password<input required type="password" minLength={8} maxLength={1024} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <label>Repeat it<input required type="password" minLength={8} maxLength={1024} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
        <p className="field-hint">At least 8 characters.</p>
        <button className="button wide" disabled={pending}>{pending ? "Creating your account…" : "Create account and sign in"}</button>
        {error && <Notice>{error.message}</Notice>}
      </form>
    </AccountShell>
  );
}
