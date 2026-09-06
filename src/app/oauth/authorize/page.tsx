import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { CircleAlert, LockKeyhole } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { createMcpOAuthConsentRequest } from "@/lib/mcp/oauth";
import BrandMark from "@/components/BrandMark";
import { OAuthConsentForm } from "./OAuthConsentForm";
import { ConsentAccount } from "./ConsentAccount";
import { ResourceAccessPicker } from "./ResourceAccessPicker";
import styles from "./oauth-authorize.module.css";

function stringParam(value: string | string[] | undefined) {
  return typeof value === "string" ? value : "";
}

function currentPath(params: Record<string, string | string[] | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") query.set(key, value);
    else if (Array.isArray(value)) for (const item of value) query.append(key, item);
  }
  return `/oauth/authorize${query.size ? `?${query}` : ""}`;
}

export default async function OAuthAuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const returnTo = currentPath(params);
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(returnTo)}`);

  const incomingHeaders = await headers();
  const host = incomingHeaders.get("x-forwarded-host") || incomingHeaders.get("host") || "localhost:3000";
  const protocol = incomingHeaders.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const pageRequest = new Request(new URL(returnTo, `${protocol}://${host}`));
  let consent;
  try {
    consent = await createMcpOAuthConsentRequest({
      userId: user.id,
      clientId: stringParam(params.client_id),
      redirectUri: stringParam(params.redirect_uri),
      responseType: stringParam(params.response_type),
      codeChallenge: stringParam(params.code_challenge),
      codeChallengeMethod: stringParam(params.code_challenge_method),
      scope: stringParam(params.scope),
      state: stringParam(params.state),
      resource: stringParam(params.resource),
    }, pageRequest);
  } catch (error) {
    return <main className={styles.shell}><section className={`${styles.card} ${styles.errorCard}`}>
      <span className={styles.brand}><BrandMark />Scenelith</span>
      <CircleAlert className={styles.errorIcon} aria-hidden="true" />
      <h1>Connection request could not be verified</h1>
      <p>{error instanceof Error ? error.message : "Return to your agent and try connecting again."}</p>
      <a href="/canvas">Back to Scenelith</a>
    </section></main>;
  }

  return <main className={styles.shell}>
    <section className={styles.card}>
      <header className={styles.header}>
        <span className={styles.brand}><BrandMark />Scenelith</span>
        <span className={styles.security}><LockKeyhole size={13} />Secure connection</span>
      </header>

      <div className={styles.intro}>
        <div><p>Connect an AI agent</p><h1>{consent.client.name} wants to access Scenelith</h1></div>
      </div>

      <ConsentAccount requestId={consent.id} name={user.name || ""} email={user.email} teammate={consent.workspaces.length > 0 && consent.workspaces.every((workspace) => workspace.role === "member")} />

      <OAuthConsentForm>
        <input type="hidden" name="request_id" value={consent.id} />
        <input type="hidden" name="scope" value="mcp:read" />

        <ResourceAccessPicker workspaces={consent.workspaces} canvases={consent.canvases} requestedScopes={consent.requestedScopes} />

        <div className={styles.callback}>
          <span>After approval, you will return to</span>
          <strong>{consent.client.redirectHost}</strong>
        </div>

      </OAuthConsentForm>

      <footer>You can revoke this connection at any time. Changes to your workspace access also apply to your agent.</footer>
    </section>
  </main>;
}
