import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ApiError, forgotPassword, getAuthCapabilities } from "../api";
import { AccountShell, Notice, mailLanguage } from "../components/AccountShell";

export default function ForgotPasswordPage() {
  const capabilities = useQuery({ queryKey: ["auth-capabilities"], queryFn: getAuthCapabilities, retry: false });
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const request = useMutation({
    mutationFn: () => forgotPassword({ email: email.trim(), language: mailLanguage() }),
    onSuccess: () => setSentTo(email.trim()),
  });

  if ((capabilities.data && capabilities.data.emailSignUp !== true) || (request.error instanceof ApiError && request.error.code === "SIGN_UP_UNAVAILABLE")) {
    return (
      <AccountShell eyebrow="Password help" title="Password reset isn't open yet">
        <p>We can't send reset links right now. Please check back soon, or sign in with Google or Telegram if that's how you joined.</p>
        <Link className="button wide" to="/sign-in">Back to sign in</Link>
      </AccountShell>
    );
  }
  if (sentTo) {
    return (
      <AccountShell eyebrow="Password help" title="Check your email">
        <p>If there's an account for <strong>{sentTo}</strong>, we've sent a link to choose a new password. It works once and expires in an hour.</p>
        <p><Link to="/sign-in">Back to sign in</Link></p>
      </AccountShell>
    );
  }
  const submit = (event: FormEvent) => { event.preventDefault(); request.mutate(); };
  return (
    <AccountShell eyebrow="Password help" title="Find your way back in">
      <p>Enter your email and we'll send a link to choose a new password. This also works if you joined through an invitation or Google and never set one.</p>
      {capabilities.isPending && <p>Loading…</p>}
      {capabilities.data?.emailSignUp === true && (
        <form className="compact-form" onSubmit={submit}>
          <label>Email<input required type="email" maxLength={254} autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <button className="button wide" disabled={request.isPending}>{request.isPending ? "Sending…" : "Send reset link"}</button>
          {request.isError && <Notice>{request.error.message}</Notice>}
        </form>
      )}
      <p><Link to="/sign-in">Back to sign in</Link></p>
    </AccountShell>
  );
}
