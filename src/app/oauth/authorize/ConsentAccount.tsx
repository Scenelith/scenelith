"use client";

import { useState } from "react";
import { ArrowRightLeft, UserRound } from "lucide-react";
import styles from "./oauth-authorize.module.css";

export function ConsentAccount({ requestId, name, email, teammate }: { requestId: string; name: string; email: string; teammate: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const switchAccount = async () => {
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/mcp/oauth/switch-account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId }) });
      const body = await response.json();
      if (!response.ok || !body.redirectTo) throw new Error(body.error || "Could not switch accounts");
      window.location.assign(body.redirectTo);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not switch accounts");
      setPending(false);
    }
  };
  return <div className={styles.accountSection}>
    <div className={styles.accountRow}>
      <span className={styles.accountAvatar}><UserRound size={19} /></span>
      <div className={styles.accountIdentity}><span>Connecting as {teammate && <b>Team member</b>}</span><strong>{name || email}</strong>{name && <small>{email}</small>}</div>
      <button className={styles.switchAccount} type="button" disabled={pending} onClick={() => void switchAccount()}><ArrowRightLeft size={13} />{pending ? "Switching…" : "Use another account"}</button>
    </div>
    <p className={styles.accountNote}>{teammate ? "Connect independently — no admin approval needed. Your agent follows the access your team has already given you." : "Your agent follows your existing workspace access. Choose what this connection can do below."}</p>
    {error && <p className={styles.formError} role="alert">{error}</p>}
  </div>;
}
