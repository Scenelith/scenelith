"use client";

import { useState, type ComponentType, type ReactNode } from "react";
import { ArrowRight, LoaderCircle } from "lucide-react";
import type { AuthMode, AuthPageProps } from "@/editions/contracts/client";

export type AuthRegistrationCopy = {
  title: string;
  lead: string;
  emailLabel: string;
  submitLabel: string;
  hideSocialRegistration: boolean;
};

export type AuthSocialAction = {
  enabled: boolean;
  href: string;
  icon: ReactNode;
  label: string;
  lastUsed: boolean;
  unavailableError: string;
};

type RegistrationConsentProps = {
  accepted: boolean;
  onAcceptedChange: (accepted: boolean) => void;
};

type AuthCredentialsPanelProps = Omit<AuthPageProps, "providerSettings"> & {
  registrationCopy: AuthRegistrationCopy;
  signInLead: string;
  securityCopy: string;
  socialAction?: AuthSocialAction;
  AuthRecoveryLink?: ComponentType;
  RegistrationConsent?: ComponentType<RegistrationConsentProps>;
};

export default function AuthCredentialsPanel({
  registrationEnabled,
  initialMode,
  initialEmail,
  lockRegistrationEmail,
  initialError,
  initialNotice,
  returnTo,
  registrationCopy,
  signInLead,
  securityCopy,
  socialAction,
  AuthRecoveryLink,
  RegistrationConsent,
}: AuthCredentialsPanelProps) {
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [terms, setTerms] = useState(false);
  const [error, setError] = useState(initialError);
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (mode === "register" && RegistrationConsent && !terms) {
      setError("Accept the Terms and Privacy Policy to continue");
      return;
    }
    if (mode === "register" && password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    setLoading(true);
    setError("");
    const response = await fetch(mode === "register" ? "/api/auth/register" : "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mode === "register" ? { name, email, password, confirmPassword } : { email, password }),
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    setLoading(false);
    if (!response.ok) {
      setError(body.error || "Could not continue");
      return;
    }
    window.location.href = returnTo;
  }

  const showSocial = Boolean(socialAction) && !(registrationCopy.hideSocialRegistration && mode === "register");

  return (
    <div className="auth-v2-form-wrap">
      <div className="auth-v2-mode" role="tablist" aria-label="Authentication mode">
        <button type="button" role="tab" aria-selected={mode === "login"} className={mode === "login" ? "is-active" : ""} onClick={() => { setMode("login"); setError(""); }}>Sign in</button>
        {registrationEnabled && <button type="button" role="tab" aria-selected={mode === "register"} className={mode === "register" ? "is-active" : ""} onClick={() => { setMode("register"); setError(""); }}>Create account</button>}
      </div>
      <h1>{mode === "register" ? registrationCopy.title : "Welcome back"}</h1>
      <p className="auth-v2-lead">{mode === "register" ? registrationCopy.lead : signInLead}</p>

      {showSocial && socialAction && <>
        <a className={`auth-v2-google ${socialAction.enabled ? "" : "is-disabled"}`} href={socialAction.enabled ? socialAction.href : undefined} aria-disabled={!socialAction.enabled} onClick={(event) => { if (!socialAction.enabled) { event.preventDefault(); setError(socialAction.unavailableError); } }}>{socialAction.icon}<span>{socialAction.label}</span>{socialAction.lastUsed && <small>Last used</small>}</a>
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
      <p className="auth-v2-security">{securityCopy}</p>
    </div>
  );
}

function AuthField({ label, type, value, onChange, autoComplete, placeholder, readOnly = false }: { label: string; type: string; value: string; onChange: (value: string) => void; autoComplete: string; placeholder: string; readOnly?: boolean }) {
  return <label className={`auth-v2-field ${readOnly ? "is-readonly" : ""}`}><span>{label}</span><input type={type} value={value} onChange={(event) => onChange(event.target.value)} autoComplete={autoComplete} placeholder={placeholder} readOnly={readOnly} required /></label>;
}
