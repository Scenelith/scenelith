"use client";

import { type FormEvent, type ReactNode, useState } from "react";
import styles from "./oauth-authorize.module.css";

export function OAuthConsentForm({ children }: { children: ReactNode }) {
  const [pendingDecision, setPendingDecision] = useState<"allow" | "deny" | null>(null);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    setPendingDecision(submitter?.value === "deny" ? "deny" : "allow");
  };

  return <form action="/api/mcp/oauth/authorize" method="post" aria-busy={pendingDecision !== null} onSubmit={handleSubmit}>
    {children}
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
