"use client";

import { useEffect, useState } from "react";
import { ArrowRight, LoaderCircle } from "lucide-react";
import AuthCanvasPreview from "@/components/ui/auth-canvas-preview";
import BrandMark from "@/components/BrandMark";
import { editionClient } from "@/editions/current/client";

const workflowMoments = [
  { stage: "Import", text: "Paste a TikTok link. Scenelith reads the slideshow and keeps the source intact." },
  { stage: "Slides", text: "Every imported image becomes its own connected, reusable canvas node." },
  { stage: "Identity", text: "Connect the original composition and a saved identity to one image generator." },
  { stage: "Generate", text: "Replace the subject while preserving the original pose, framing, and scene." },
];

type AuthMode = "login" | "register";

export default function AuthSectionTwo({ googleEnabled, registrationEnabled = true, initialMode = "login", initialEmail = "", registrationVariant = "default", lockRegistrationEmail = false, lastAuthMethod = null, initialError = "", initialNotice = "", returnTo = "/canvas" }: { googleEnabled: boolean; registrationEnabled?: boolean; initialMode?: AuthMode; initialEmail?: string; registrationVariant?: string; lockRegistrationEmail?: boolean; lastAuthMethod?: "email" | "google" | null; initialError?: string; initialNotice?: string; returnTo?: string }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [cycleRevision, setCycleRevision] = useState(0);
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [terms, setTerms] = useState(false);
  const [error, setError] = useState(initialError);
  const [loading, setLoading] = useState(false);
  const registrationCopy = editionClient.registrationCopy(registrationVariant);
  const AuthRecoveryLink = editionClient.AuthRecoveryLink;
  const RegistrationConsent = editionClient.RegistrationConsent;

  useEffect(() => {
    const interval = window.setInterval(() => setActiveIndex((current) => (current + 1) % workflowMoments.length), 3200);
    return () => window.clearInterval(interval);
  }, [cycleRevision]);

  function showStep(index: number) {
    setActiveIndex(index);
    setCycleRevision((revision) => revision + 1);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (mode === "register" && RegistrationConsent && !terms) { setError("Accept the Terms and Privacy Policy to continue"); return; }
    if (mode === "register" && password !== confirmPassword) { setError("Passwords do not match"); return; }
    setLoading(true);
    setError("");
    const response = await fetch(mode === "register" ? "/api/auth/register" : "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mode === "register" ? { name, email, password, confirmPassword } : { email, password }),
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    setLoading(false);
    if (!response.ok) { setError(body.error || "Could not continue"); return; }
    window.location.href = returnTo;
  }

  return (
    <main className="auth-v2-page">
      <section className="auth-v2-showcase">
        <div className="auth-v2-showcase-inner">
          <div className="auth-v2-wordmark"><BrandMark />SCENELITH</div>
          <AuthCanvasPreview activeStep={activeIndex} mediaUrl={editionClient.authPreviewMedia} />
          <div className="auth-v2-prompt">
            <div className="auth-v2-flow-copy">
              <div className="auth-v2-flow-label"><span>0{activeIndex + 1}</span><b>{workflowMoments[activeIndex].stage}</b></div>
              <p>{workflowMoments[activeIndex].text}</p>
            </div>
            <button type="button" onClick={() => showStep((activeIndex + 1) % workflowMoments.length)} aria-label="Show next workflow step"><ArrowRight size={17} /></button>
          </div>
          <h2>From source to final output.<br />Everything stays connected.</h2>
          <div className="auth-v2-dots">{workflowMoments.map((item, index) => <button key={item.stage} type="button" className={index === activeIndex ? "is-active" : ""} onClick={() => showStep(index)} aria-label={`Show ${item.stage} workflow step`} />)}</div>
        </div>
      </section>

      <section className="auth-v2-form-side">
        <div className="auth-v2-form-wrap">
          <div className="auth-v2-mode" role="tablist" aria-label="Authentication mode">
            <button type="button" role="tab" aria-selected={mode === "login"} className={mode === "login" ? "is-active" : ""} onClick={() => { setMode("login"); setError(""); }}>Sign in</button>
            {registrationEnabled && <button type="button" role="tab" aria-selected={mode === "register"} className={mode === "register" ? "is-active" : ""} onClick={() => { setMode("register"); setError(""); }}>Create account</button>}
          </div>
          <h1>{mode === "register" ? registrationCopy.title : "Welcome back"}</h1>
          <p className="auth-v2-lead">{mode === "register" ? registrationCopy.lead : "Continue building in your private creative graph."}</p>

          {!(registrationCopy.hideSocialRegistration && mode === "register") && <>
            <a className={`auth-v2-google ${googleEnabled ? "" : "is-disabled"}`} href={googleEnabled ? `/api/auth/google?next=${encodeURIComponent(returnTo)}` : undefined} aria-disabled={!googleEnabled} onClick={(event) => { if (!googleEnabled) { event.preventDefault(); setError("Google sign-in is not configured yet"); } }}><GoogleIcon /><span>Continue with Google</span>{lastAuthMethod === "google" && <small>Last used</small>}</a>
            <div className="auth-v2-divider"><span />or continue with email<span /></div>
          </>}

          <form onSubmit={submit} className="auth-v2-form">
            {mode === "register" && <AuthField label="Name" type="text" value={name} onChange={setName} autoComplete="name" placeholder="Your name" />}
            <AuthField label={mode === "register" ? registrationCopy.emailLabel : "Email"} type="email" value={email} onChange={setEmail} autoComplete="email" placeholder="you@company.com" readOnly={lockRegistrationEmail && mode === "register"} />
            <AuthField label="Password" type="password" value={password} onChange={setPassword} autoComplete={mode === "register" ? "new-password" : "current-password"} placeholder="At least 8 characters" />
            {mode === "register" && <AuthField label="Confirm password" type="password" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" placeholder="Enter the same password again" />}
            {mode === "login" && AuthRecoveryLink && <AuthRecoveryLink />}
            {mode === "register" && RegistrationConsent && <RegistrationConsent accepted={terms} onAcceptedChange={setTerms} />}
            {initialNotice && !error && <p className="auth-v2-notice" role="status">{initialNotice}</p>}
            {error && <p className="auth-v2-error" role="alert">{error}</p>}
            <button className="auth-v2-submit" type="submit" disabled={loading || !email || !password || (mode === "register" && (!name || !confirmPassword || password !== confirmPassword || (Boolean(RegistrationConsent) && !terms)))}>{loading ? <LoaderCircle className="spin" size={17} /> : <>{mode === "register" ? registrationCopy.submitLabel : "Sign in"}<ArrowRight size={16} /></>}</button>
          </form>
          <p className="auth-v2-security">Protected with isolated workspaces, hashed passwords and secure server sessions.</p>
        </div>
      </section>
    </main>
  );
}

function AuthField({ label, type, value, onChange, autoComplete, placeholder, readOnly = false }: { label: string; type: string; value: string; onChange: (value: string) => void; autoComplete: string; placeholder: string; readOnly?: boolean }) {
  return <label className={`auth-v2-field ${readOnly ? "is-readonly" : ""}`}><span>{label}</span><input type={type} value={value} onChange={(event) => onChange(event.target.value)} autoComplete={autoComplete} placeholder={placeholder} readOnly={readOnly} required /></label>;
}

function GoogleIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09Z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23Z" fill="#34A853"/><path d="M5.84 14.1A6.6 6.6 0 0 1 5.49 12c0-.74.13-1.44.35-2.1V7.06H2.18A10.98 10.98 0 0 0 1 12c0 1.78.43 3.45 1.18 4.94l3.66-2.84Z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z" fill="#EB4335"/></svg>;
}
