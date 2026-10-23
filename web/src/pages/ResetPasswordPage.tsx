import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ApiError, getMe, resetPassword, safeReturnTo } from "../api";
import { AccountShell, Notice, readEmailToken } from "../components/AccountShell";

/** Opened from the reset email. The token is read from the fragment (or query) once and held in memory only. */
export default function ResetPasswordPage() {
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

  if (!token || error?.code === "TOKEN_INVALID") {
    return (
      <AccountShell eyebrow="Password help" title="This link didn't work">
        <Notice>{token ? error!.message : "This link is incomplete. Open the link from your email again."}</Notice>
        <p>Links work once and expire after an hour. <Link to="/forgot-password">Ask for a new one</Link>.</p>
      </AccountShell>
    );
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirm) { setError({ code: "MISMATCH", message: "The two passwords don't match." }); return; }
    setError(null);
    setPending(true);
    try {
      const { appPath } = await resetPassword({ token, password });
      queryClient.clear();
      await queryClient.fetchQuery({ queryKey: ["me"], queryFn: getMe });
      navigate(safeReturnTo(appPath), { replace: true });
    } catch (caught) {
      setError({ code: caught instanceof ApiError ? caught.code : "REQUEST_FAILED", message: caught instanceof Error ? caught.message : "The request could not be completed." });
      setPending(false);
    }
  };
  return (
    <AccountShell eyebrow="Password help" title="Choose a new password">
      <p>You'll be signed in afterwards, and signed out everywhere else.</p>
      <form className="compact-form" onSubmit={submit}>
        <label>New password<input required type="password" minLength={8} maxLength={1024} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <label>Repeat it<input required type="password" minLength={8} maxLength={1024} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
        <button className="button wide" disabled={pending}>{pending ? "Saving…" : "Set password and sign in"}</button>
        {error && <Notice>{error.message}</Notice>}
      </form>
    </AccountShell>
  );
}
