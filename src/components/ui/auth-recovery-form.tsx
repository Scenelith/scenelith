"use client";

import { useState } from "react";
import { ArrowRight, Check, LoaderCircle } from "lucide-react";
import BrandMark from "@/components/BrandMark";

export default function AuthRecoveryForm({ mode, token = "" }: { mode: "forgot" | "reset"; token?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (mode === "reset" && password !== confirmPassword) { setError("Passwords do not match"); return; }
    setLoading(true);
    setError("");
    const response = await fetch(mode === "forgot" ? "/api/auth/password/forgot" : "/api/auth/password/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mode === "forgot" ? { email } : { token, password }),
    });
    const body = await response.json().catch(() => ({})) as { error?: string };
    setLoading(false);
    if (!response.ok) { setError(body.error || "Could not continue"); return; }
    if (mode === "reset") { window.location.href = "/login?reset=1"; return; }
    setSent(true);
  }

  return (
    <main className="auth-recovery-page">
      <section className="auth-recovery-card">
        <a className="auth-recovery-brand" href="/login"><BrandMark />SCENELITH</a>
        {sent ? (
          <div className="auth-recovery-success"><span><Check size={21} /></span><h1>Check your inbox</h1><p>If an account exists for <b>{email}</b>, we sent a secure password-reset link.</p><a href="/login">Back to sign in</a></div>
        ) : (
          <>
            <h1>{mode === "forgot" ? "Reset your password" : "Choose a new password"}</h1>
            <p>{mode === "forgot" ? "Enter the email connected to your Scenelith account." : "Your new password must contain at least 8 characters."}</p>
            <form onSubmit={submit} className="auth-v2-form">
              {mode === "forgot" ? <RecoveryField label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" /> : <><RecoveryField label="New password" type="password" value={password} onChange={setPassword} autoComplete="new-password" /><RecoveryField label="Confirm password" type="password" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" /></>}
              {error && <p className="auth-v2-error" role="alert">{error}</p>}
              <button className="auth-v2-submit" type="submit" disabled={loading || (mode === "forgot" ? !email : !password || !confirmPassword || !token)}>{loading ? <LoaderCircle className="spin" size={17} /> : <>{mode === "forgot" ? "Send reset link" : "Update password"}<ArrowRight size={16} /></>}</button>
            </form>
            <a className="auth-recovery-back" href="/login">Back to sign in</a>
          </>
        )}
      </section>
    </main>
  );
}

function RecoveryField({ label, type, value, onChange, autoComplete }: { label: string; type: string; value: string; onChange: (value: string) => void; autoComplete: string }) {
  return <label className="auth-v2-field"><span>{label}</span><input type={type} value={value} onChange={(event) => onChange(event.target.value)} autoComplete={autoComplete} required minLength={type === "password" ? 8 : undefined} /></label>;
}
