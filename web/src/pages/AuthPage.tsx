import { ArrowLeft, ArrowRight, Eye, EyeOff, LockKeyhole, Mail, ShieldCheck } from "lucide-react";
import { FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { Brand } from "../components/Brand";

type AuthPageProps = { mode: "sign-in" | "sign-up" };

export function AuthPage({ mode }: AuthPageProps) {
  const [showPassword, setShowPassword] = useState(false);
  const [notice, setNotice] = useState("");
  const isSignUp = mode === "sign-up";

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice("The account screen is ready. Secure control-plane authentication is the next implementation slice.");
  };

  return (
    <main className="auth-layout">
      <section className="auth-scene" aria-label="A calm coastal trip scene">
        <div className="auth-sun" />
        <div className="auth-hill auth-hill-one" />
        <div className="auth-hill auth-hill-two" />
        <div className="auth-route"><i /><i /><i /><b /></div>
        <div className="auth-scene-copy">
          <ShieldCheck />
          <h2>The trip brain<br />for your family.</h2>
          <p>Private plans, clear answers, and one current version everyone can trust.</p>
        </div>
      </section>

      <section className="auth-panel">
        <div className="auth-topline"><Brand /><Link to="/"><ArrowLeft size={16} /> Back home</Link></div>
        <div className="auth-card">
          <span className="section-label">{isSignUp ? "Create your account" : "Welcome back"}</span>
          <h1>{isSignUp ? "Start traveling lighter." : "Good to see you."}</h1>
          <p>{isSignUp ? "Create an organizer account, then start your first private trip." : "Sign in to continue planning, traveling, or reliving a trip."}</p>

          <button className="google-button" type="button" onClick={() => setNotice("Google sign-in is ready for control-plane wiring.")}>
            <span>G</span> Continue with Google
          </button>
          <div className="auth-divider"><span>or continue with email</span></div>

          <form onSubmit={handleSubmit}>
            {isSignUp && <label>Full name<div className="input-wrap"><input type="text" name="name" autoComplete="name" required placeholder="Your name" /></div></label>}
            <label>Email<div className="input-wrap"><Mail size={18} /><input type="email" name="email" autoComplete="email" required placeholder="you@example.com" /></div></label>
            <label>Password<div className="input-wrap"><LockKeyhole size={18} /><input type={showPassword ? "text" : "password"} name="password" autoComplete={isSignUp ? "new-password" : "current-password"} required minLength={8} placeholder={isSignUp ? "At least 8 characters" : "Your password"} /><button type="button" aria-label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword((show) => !show)}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></label>
            {!isSignUp && <div className="form-meta"><label className="checkbox-label"><input type="checkbox" /> Remember me</label><Link to="/forgot-password">Forgot password?</Link></div>}
            <button className="button button-coral auth-submit" type="submit">{isSignUp ? "Create account" : "Sign in"} <ArrowRight size={17} /></button>
          </form>

          {notice && <p className="form-notice" role="status">{notice}</p>}
          <p className="auth-switch">{isSignUp ? "Already have an account?" : "New to Kinerary?"} <Link to={isSignUp ? "/sign-in" : "/sign-up"}>{isSignUp ? "Sign in" : "Create an account"}</Link></p>
          <Link className="preview-link" to="/trips">Preview the signed-in trip home <ArrowRight size={15} /></Link>
        </div>
      </section>
    </main>
  );
}
