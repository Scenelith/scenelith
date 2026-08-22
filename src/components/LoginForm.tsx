"use client";

import { useState } from "react";
import { ArrowRight, LoaderCircle, LockKeyhole } from "lucide-react";

export function LoginForm() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    setLoading(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setError(body.error || "Could not sign in");
      return;
    }
    window.location.href = "/canvas";
  }

  return (
    <form onSubmit={submit} className="login-card">
      <div className="login-lock"><LockKeyhole size={18} /></div>
      <div>
        <p className="eyebrow">PRIVATE WORKSPACE</p>
        <h1>Enter Frameflow</h1>
        <p className="muted">One password. No accounts, no noise.</p>
      </div>
      <label className="field-label" htmlFor="password">Workspace password</label>
      <div className="login-input-row">
        <input
          id="password"
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="••••••••••"
        />
        <button type="submit" disabled={loading || !password} aria-label="Sign in">
          {loading ? <LoaderCircle className="spin" size={18} /> : <ArrowRight size={18} />}
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
    </form>
  );
}
