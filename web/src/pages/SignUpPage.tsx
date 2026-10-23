import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { ApiError, emailSignUp, getAuthCapabilities, getMe, safeReturnTo, signIn } from "../api";
import { AccountShell, Notice, mailLanguage } from "../components/AccountShell";

/** The unavailable state is its own page, not an error under a form: there is nothing here to fill in. */
export function SignUpClosed({ returnTo }: { returnTo: string }) {
  return (
    <AccountShell eyebrow="Kinerary personal space" title="Sign-up isn't open yet">
      <p>We can't create new accounts right now. If you already have one, sign in. Otherwise please check back soon.</p>
      <Link className="button wide" to={`/sign-in?return_to=${encodeURIComponent(returnTo)}`}>Sign in</Link>
    </AccountShell>
  );
}

export default function SignUpPage() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  // /trips/new links here with `returnTo`; the sign-in page and the Google redirect say `return_to`.
  const returnTo = safeReturnTo(params.get("returnTo") ?? params.get("return_to"));
  const me = useQuery({ queryKey: ["me"], queryFn: getMe, retry: false });
  const capabilities = useQuery({ queryKey: ["auth-capabilities"], queryFn: getAuthCapabilities, retry: false });
  const [form, setForm] = useState({ email: "" });
  const [sentTo, setSentTo] = useState<string | null>(null);
  const request = useMutation({
    mutationFn: () => emailSignUp({ ...form, email: form.email.trim(), returnTo, language: mailLanguage() }),
    onSuccess: () => setSentTo(form.email.trim()),
  });

  if (me.data && me.data.scope !== "telegram") return <Navigate replace to={returnTo} />;
  if ((capabilities.data && capabilities.data.emailSignUp !== true) || (request.error instanceof ApiError && request.error.code === "SIGN_UP_UNAVAILABLE")) {
    return <SignUpClosed returnTo={returnTo} />;
  }

  if (sentTo) {
    return (
      <AccountShell eyebrow="Kinerary personal space" title="Check your email">
        <p>If <strong>{sentTo}</strong> can be used to create an account, we've sent a link. Open it to choose your name and password and finish; it works once and expires in 24 hours.</p>
        <p>Nothing arrived? Check your spam folder, or <button type="button" className="link-button" onClick={() => { request.reset(); setSentTo(null); }}>use a different address</button>.</p>
      </AccountShell>
    );
  }

  const submit = (event: FormEvent) => { event.preventDefault(); request.mutate(); };
  return (
    <AccountShell eyebrow="Kinerary personal space" title="Create your account">
      <p>Create an organizer account to plan trips. We'll email you a link; you choose your name and password there, and the account is created once you do.</p>
      {capabilities.isPending && <p>Loading sign-up options…</p>}
      {capabilities.isError && <Notice>Sign-up is unavailable. Please retry in a moment.</Notice>}
      {capabilities.data?.emailSignUp === true && (
        <form className="compact-form" onSubmit={submit}>
          <label>Email<input required type="email" maxLength={254} autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
          <button className="button wide" disabled={request.isPending}>{request.isPending ? "Sending…" : "Email me a link"}</button>
          {request.isError && <Notice>{request.error.message}</Notice>}
        </form>
      )}
      {capabilities.data?.google && <button className="button wide" type="button" onClick={() => signIn(returnTo)}>Continue with Google</button>}
      <p>Already have an account? <Link to={`/sign-in?return_to=${encodeURIComponent(returnTo)}`}>Sign in</Link></p>
    </AccountShell>
  );
}
