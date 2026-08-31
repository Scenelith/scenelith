"use client";

import { type FormEvent, type ReactNode, useState } from "react";
import styles from "./oauth-authorize.module.css";

export function OAuthConsentForm({ children }: { children: ReactNode }) {
  const [pendingDecision, setPendingDecision] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState("");

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const decision = submitter?.value === "deny" ? "deny" : "allow";
    setPendingDecision(decision);
    setError("");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    try {
      const body = new FormData(event.currentTarget);
      body.set("decision", decision);
      const response = await fetch("/api/mcp/oauth/authorize", {
        method: "POST",
        body,
        headers: { accept: "application/json" },
        credentials: "same-origin",
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({})) as { redirectTo?: string; error?: string };
      if (!response.ok || !payload.redirectTo) throw new Error(payload.error || "Scenelith could not complete this connection.");
      window.location.assign(payload.redirectTo);
    } catch (cause) {
      setError(cause instanceof DOMException && cause.name === "AbortError"
        ? "The connection timed out. Return to your agent and start a new connection."
        : cause instanceof Error ? cause.message : "Scenelith could not complete this connection.");
      setPendingDecision(null);
    } finally {
      window.clearTimeout(timeout);
    }
  };

  return <form action="/api/mcp/oauth/authorize" method="post" aria-busy={pendingDecision !== null} onSubmit={handleSubmit}>
    {children}
    {error && <p className={styles.formError} role="alert">{error}</p>}
    <div className={styles.actions}>
      <button type="submit" name="decision" value="deny" className={styles.cancel} disabled={pendingDecision !== null}>
        {pendingDecision === "deny" ? "Cancelling…" : "Cancel"}
      </button>
      <button type="submit" name="decision" value="allow" className={styles.allow} disabled={pendingDecision !== null}>
        {pendingDecision === "allow" ? "Connecting…" : "Allow access"}
      </button>
    </div>
  </form>;
}
