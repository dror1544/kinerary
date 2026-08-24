import { ArrowLeft, Mail } from "lucide-react";
import { FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { Brand } from "../components/Brand";

export default function ForgotPasswordPage() {
  const [submitted, setSubmitted] = useState(false);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
  };

  return (
    <main className="simple-auth-page">
      <header><Brand /><Link to="/sign-in"><ArrowLeft size={16} /> Back to sign in</Link></header>
      <section>
        <span className="section-label">Password help</span>
        <h1>Find your way back in.</h1>
        <p>Enter your email. When the control-plane account service is connected, Kinerary will send a secure, expiring reset link.</p>
        <form onSubmit={submit}>
          <label>Email<div className="input-wrap"><Mail size={18} /><input type="email" required autoComplete="email" placeholder="you@example.com" /></div></label>
          <button className="button button-coral" type="submit">Request reset link</button>
        </form>
        {submitted && <p className="form-notice" role="status">The reset screen is ready. No email was sent from this interface preview.</p>}
      </section>
    </main>
  );
}
