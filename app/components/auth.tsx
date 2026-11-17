import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { errorMessage, write } from "./api";
import { Icon, Notice } from "./ui";

export function AuthPage({ mode, onAuthenticated, children }: { mode: "signup" | "signin"; onAuthenticated: () => Promise<void>; children?: ReactNode }) {
  const location = useLocation();
  const [signUp, setSignUp] = useState(mode === "signup");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = new FormData(event.currentTarget);
    try { await write(`/api/auth/${signUp ? "sign-up" : "sign-in"}/email`, "POST", { ...(signUp ? { name: String(form.get("name")).trim() } : {}), email: String(form.get("email")).trim(), password: String(form.get("password")) }); await onAuthenticated(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  return <main className="auth-page"><Link className="wordmark" to="/"><span className="brand-mark"><Icon name="video" size={20} /></span>Video workspace</Link><div className="auth-layout"><section className="auth-card"><h1>{signUp ? "Create account" : "Sign in"}</h1>{location.pathname === "/join" && <p>Sign in to the account named by the invitation. Your link stays open while you sign in.</p>}<form className="stack-form" onSubmit={submit}>{signUp && children}{signUp && <label>Your name<input autoComplete="name" name="name" required maxLength={100} placeholder="First and last name" disabled={busy} /></label>}<label>Email address<input name="email" type="email" autoComplete="email" required placeholder="you@company.com" disabled={busy} /></label><label>Password<input name="password" type="password" autoComplete={signUp ? "new-password" : "current-password"} required minLength={12} maxLength={128} placeholder={signUp ? "At least 12 characters" : "Your password"} disabled={busy} /></label>{error && <Notice error>{error}</Notice>}<button className="button primary auth-submit" disabled={busy}>{busy ? "Opening your workspace…" : signUp ? "Create account" : "Sign in"}</button></form><p className="auth-switch">{signUp ? "Already have an account?" : "New to the workspace?"} <button className="text-button" onClick={() => { setSignUp(!signUp); setError(""); }} disabled={busy}>{signUp ? "Sign in" : "Create an account"}</button></p></section></div></main>;
}
