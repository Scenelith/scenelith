import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Bot, Boxes, CircleAlert, Image, LockKeyhole, Network, Play, Sparkles, Workflow } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { createMcpOAuthConsentRequest, type McpScope } from "@/lib/mcp/oauth";
import { ResourceAccessPicker } from "./ResourceAccessPicker";
import styles from "./oauth-authorize.module.css";

const permissionCopy: Record<McpScope, { title: string; detail: string; icon: typeof Boxes }> = {
  "mcp:read": { title: "View approved creative resources", detail: "The projects and canvases you approve, identities, workflows and run history.", icon: Boxes },
  "canvas:write": { title: "Edit canvases", detail: "Create canvases and add, update or remove nodes and connections.", icon: Network },
  "assistant:run": { title: "Run creative assistants", detail: "Build prompts and run Assistant nodes. These actions may use credits or configured providers.", icon: Bot },
  "generation:run": { title: "Generate media", detail: "Run image and video models. Generations may use credits or configured providers.", icon: Sparkles },
  "library:write": { title: "Add media to Library", detail: "Upload approved images and videos into the selected project Libraries.", icon: Image },
  "import:write": { title: "Import external media", detail: "Download approved TikTok posts into a canvas and its Library.", icon: Image },
  "identity:write": { title: "Manage identities", detail: "Create and maintain reusable Character or Before / After identities from approved Library images.", icon: Image },
  "automation:write": { title: "Edit automations", detail: "Create, change and publish automation workflows.", icon: Workflow },
  "automation:credentials": { title: "Connect saved automation credentials", detail: "Choose existing workspace credentials for workflow slots. Secret values are never shared with the agent.", icon: LockKeyhole },
  "automation:run": { title: "Run automations", detail: "Start or stop runs. Runs may use credits or configured providers.", icon: Play },
};

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
      <span className={styles.brand}><Sparkles size={15} />Scenelith</span>
      <CircleAlert className={styles.errorIcon} aria-hidden="true" />
      <h1>Connection request could not be verified</h1>
      <p>{error instanceof Error ? error.message : "Return to your agent and try connecting again."}</p>
      <a href="/canvas">Back to Scenelith</a>
    </section></main>;
  }

  return <main className={styles.shell}>
    <section className={styles.card}>
      <header className={styles.header}>
        <span className={styles.brand}><Sparkles size={15} />Scenelith</span>
        <span className={styles.security}><LockKeyhole size={13} />Secure OAuth connection</span>
      </header>

      <div className={styles.intro}>
        <span className={styles.agentIcon}><Bot size={23} /></span>
        <div><p>Connect an AI agent</p><h1>{consent.client.name} wants to access Scenelith</h1></div>
      </div>

      <form action="/api/mcp/oauth/authorize" method="post">
        <input type="hidden" name="request_id" value={consent.id} />
        <input type="hidden" name="scope" value="mcp:read" />

        <ResourceAccessPicker workspaces={consent.workspaces} canvases={consent.canvases} />

        <span className={styles.sectionLabel}>Permissions requested</span>
        <div className={styles.permissions}>
          {consent.requestedScopes.map((scope) => {
            const permission = permissionCopy[scope];
            const Icon = permission.icon;
            const required = scope === "mcp:read";
            return <label className={styles.permission} key={scope}>
              <span className={styles.permissionIcon}><Icon size={16} /></span>
              <span><strong>{permission.title}</strong><small>{permission.detail}</small></span>
              {required ? <span className={styles.required}>Required</span> : <input type="checkbox" name="scope" value={scope} defaultChecked />}
            </label>;
          })}
        </div>

        <div className={styles.callback}>
          <span>After approval, you will return to</span>
          <strong>{consent.client.redirectHost}</strong>
        </div>

        <div className={styles.actions}>
          <button type="submit" name="decision" value="deny" className={styles.cancel}>Cancel</button>
          <button type="submit" name="decision" value="allow" className={styles.allow}>Allow access</button>
        </div>
      </form>

      <footer>Signed in as <strong>{user.email}</strong>. You can revoke this connection at any time.</footer>
    </section>
  </main>;
}
