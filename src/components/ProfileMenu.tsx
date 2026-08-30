"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, Check, CircleAlert, CircleCheck, Copy, ExternalLink, PlugZap, UserRound } from "lucide-react";
import { editionClient, type EditionView, type ProductPanelKind } from "@/editions/current/client";
import type { UsageSummary } from "@/modules/usage/contracts";
import type { UserRecord, WorkspaceRole } from "@/lib/types";

type ProviderConnection = {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  environmentVariable: string | null;
  requiresKey: boolean;
  configured: boolean;
};

type McpSetup = {
  endpoint: string;
  mode: "local" | "https" | "insecure_remote";
};

type McpClient = "codex" | "claude" | "claude-code" | "chatgpt" | "other";

const MCP_CLIENTS: Array<{ id: McpClient; label: string }> = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude" },
  { id: "claude-code", label: "Claude Code" },
  { id: "chatgpt", label: "ChatGPT" },
  { id: "other", label: "Other" },
];

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const field = document.createElement("textarea");
  field.value = value;
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  document.execCommand("copy");
  field.remove();
}

function McpConnectionSection({ onBack }: { onBack: () => void }) {
  const [setup, setSetup] = useState<McpSetup | null>(null);
  const [error, setError] = useState("");
  const [client, setClient] = useState<McpClient>("codex");
  const [copied, setCopied] = useState<"endpoint" | "snippet" | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/mcp/setup", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as McpSetup & { error?: string };
        if (!response.ok || !body.endpoint) throw new Error(body.error || "MCP setup is unavailable");
        if (active) setSetup(body);
      })
      .catch(() => { if (active) setError("Could not read this instance's MCP address"); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(null), 1600);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const copyValue = async (value: string, target: "endpoint" | "snippet") => {
    await copyText(value);
    setCopied(target);
  };

  const endpoint = setup?.endpoint || "Reading this instance…";
  const snippets: Record<McpClient, string> = {
    codex: endpoint,
    claude: endpoint,
    "claude-code": `claude mcp add --transport http scenelith ${endpoint}`,
    chatgpt: endpoint,
    other: JSON.stringify({ mcpServers: { scenelith: { type: "http", url: endpoint } } }, null, 2),
  };
  const instructions: Record<McpClient, { title: string; body: string }> = {
    codex: {
      title: "Add a Streamable HTTP server",
      body: "Open MCP settings in Codex, add a server, paste this URL and authenticate in the browser.",
    },
    claude: {
      title: "Add a custom connector",
      body: "In Claude connector settings, add a remote MCP server with this URL, then approve Scenelith access.",
    },
    "claude-code": {
      title: "Run one command",
      body: "Add Scenelith as an HTTP MCP server. Claude Code opens OAuth the first time it connects.",
    },
    chatgpt: {
      title: "Create an MCP app",
      body: "Enable Developer mode, open Settings → Apps → Create, choose OAuth and use this MCP URL.",
    },
    other: {
      title: "Use any MCP client",
      body: "Choose Streamable HTTP, paste the URL or add this block to the client's MCP configuration.",
    },
  };
  const activeInstruction = instructions[client];

  return <div className="profile-section profile-mcp-section">
    <button type="button" className="profile-section-back" onClick={onBack}><i aria-hidden="true" />Profile</button>
    <span className="profile-mcp-eyebrow"><Bot size={12} />Scenelith MCP</span>
    <h3>Connect an AI agent</h3>
    <p>Use this instance&apos;s OAuth connection. No API key or manual token is needed.</p>

    <div className={`profile-mcp-endpoint ${error ? "has-error" : ""}`}>
      <span><small>Server URL</small><code>{error || endpoint}</code></span>
      <button type="button" aria-label="Copy MCP server URL" disabled={!setup} onClick={() => setup && void copyValue(setup.endpoint, "endpoint")}>
        {copied === "endpoint" ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>

    <div className="profile-mcp-tabs" role="tablist" aria-label="MCP client">
      {MCP_CLIENTS.map((item) => <button key={item.id} type="button" role="tab" aria-selected={client === item.id} className={client === item.id ? "is-active" : ""} onClick={() => setClient(item.id)}>{item.label}</button>)}
    </div>

    <section className="profile-mcp-client" role="tabpanel">
      <strong>{activeInstruction.title}</strong>
      <p>{activeInstruction.body}</p>
      <div className="profile-mcp-snippet">
        <pre>{snippets[client]}</pre>
        <button type="button" aria-label="Copy MCP setup value" disabled={!setup} onClick={() => setup && void copyValue(snippets[client], "snippet")}>
          {copied === "snippet" ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      {client === "chatgpt" && setup?.mode === "local" && <span className="profile-mcp-client-warning">ChatGPT cannot reach localhost directly. Use a secure tunnel or a public HTTPS Scenelith URL.</span>}
    </section>

    {setup && <span className={`profile-mcp-instance is-${setup.mode}`}>
      {setup.mode === "local" && "Local instance · desktop agents on this machine can connect. Remote web agents need a secure tunnel or public HTTPS."}
      {setup.mode === "https" && "Public HTTPS endpoint · ready for desktop and remote agents."}
      {setup.mode === "insecure_remote" && "Remote HTTP address · set PUBLIC_URL to the public HTTPS origin before using OAuth outside this network."}
    </span>}

    <div className="profile-mcp-links">
      <a href="/settings/mcp">Manage connected agents</a>
      <a href="/mcp">Full setup guide <ExternalLink size={11} /></a>
    </div>
  </div>;
}

export function ProfileMenu({ user, workspaceId, workspaceName, workspaceRole, usage, onRequestAccountView, onOpenProductPanel }: {
  user: UserRecord;
  workspaceId: string;
  workspaceName: string;
  workspaceRole: WorkspaceRole;
  usage: UsageSummary;
  onRequestAccountView: (view: EditionView) => void;
  onOpenProductPanel: (kind: ProductPanelKind) => void;
}) {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<"main" | "providers" | "mcp">("main");
  const [providers, setProviders] = useState<ProviderConnection[] | null>(null);
  const [providersError, setProvidersError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const account = editionClient.accountMenuPresentation(usage);
  const ProductAccountMenuExtension = editionClient.ProductAccountMenuExtension;
  const AccountMenuExtension = editionClient.AccountMenuExtension;

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (!open || usage.usageMode !== "unmetered" || providers || providersError) return;
    let active = true;
    void fetch("/api/runtime/settings", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { providers?: { connections?: ProviderConnection[] } };
        if (!response.ok || !body.providers?.connections) throw new Error("Provider status is unavailable");
        if (active) setProviders(body.providers.connections);
      })
      .catch(() => { if (active) setProvidersError("Could not load provider status"); });
    return () => { active = false; };
  }, [open, providers, providersError, usage.usageMode]);

  const dismiss = () => {
    setOpen(false);
    setSection("main");
  };

  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  };

  return <div className={`profile-menu ${open ? "is-open" : ""}`} ref={rootRef}>
    <button type="button" className="profile-trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => { if (value) setSection("main"); return !value; })}>
      <span className={`profile-avatar-ring ${account.meterEmpty ? "has-no-credits" : ""}`}>
        {account.meterPercent !== undefined && <svg viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="19" /><circle className="profile-avatar-ring-value" cx="22" cy="22" r="19" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - account.meterPercent} /></svg>}
        <span className="profile-avatar"><UserRound aria-hidden="true" /></span>
      </span>
      <span className="profile-trigger-copy"><strong>{user.name || user.email.split("@")[0]}</strong><small>{account.subtitle}</small></span>
      <span className="profile-chevron" aria-hidden="true" />
    </button>

    {open && <div className={`profile-popover ${section === "mcp" ? "has-mcp-section" : ""}`} role={section === "main" ? "menu" : "dialog"} aria-label={section === "mcp" ? "Connect an AI agent" : "Profile settings"}>
      {section === "main" ? <>
        <div className="profile-identity"><span className="profile-avatar is-large"><UserRound aria-hidden="true" /></span><span><strong>{user.name || "Scenelith creator"}</strong><small>{user.email}</small></span></div>
        <div className="profile-plan"><span><small>{account.summaryLabel}</small><strong>{account.summaryValue}</strong></span></div>
        <div className="profile-settings-list">
          {ProductAccountMenuExtension && <ProductAccountMenuExtension user={user} workspaceName={workspaceName} workspaceRole={workspaceRole} onOpen={(kind) => { dismiss(); onOpenProductPanel(kind); }} />}
          {usage.usageMode === "unmetered" && <button type="button" role="menuitem" onClick={() => setSection("providers")}><span><strong><PlugZap size={13} />Providers</strong><small>Kie · OpenRouter · Tikwm</small></span><i aria-hidden="true" /></button>}
          {AccountMenuExtension && <AccountMenuExtension usage={usage} workspaceId={workspaceId} workspaceOwner={workspaceRole === "owner"} onDismiss={dismiss} onRequestView={onRequestAccountView} />}
          <button type="button" role="menuitem" onClick={() => setSection("mcp")}><span><strong><Bot size={13} />MCP</strong><small>Connect an AI agent · no API key</small></span><i aria-hidden="true" /></button>
          <a role="menuitem" href="https://docs.scenelith.com" target="_blank" rel="noreferrer"><span><strong>Docs</strong><small>Workflows, nodes and generation</small></span><i aria-hidden="true" /></a>
        </div>
        <button type="button" className="profile-sign-out" role="menuitem" onClick={() => void signOut()}>Sign out</button>
      </> : section === "providers" ? <div className="profile-section">
        <button type="button" className="profile-section-back" onClick={() => setSection("main")}><i aria-hidden="true" />Profile</button>
        <h3>Provider connections</h3>
        <p>Your instance calls these providers directly. Scenelith does not proxy or meter their usage.</p>
        <div className="profile-provider-list">
          {providers?.map((provider) => <article key={provider.id} className={provider.configured ? "is-connected" : "is-missing"}><span className="profile-provider-mark" aria-hidden="true">{provider.name.slice(0, 1)}</span><span className="profile-provider-copy"><strong>{provider.name}</strong><small>{provider.description}</small><em>{provider.capabilities.join(" · ")}</em></span><span className="profile-provider-status">{provider.configured ? <CircleCheck size={13} /> : <CircleAlert size={13} />}{provider.requiresKey ? provider.configured ? "Connected" : "Key required" : "Available"}</span></article>)}
          {!providers && !providersError && <span className="profile-provider-loading">Reading instance configuration…</span>}
          {providersError && <span className="profile-provider-loading is-error">{providersError}</span>}
        </div>
        <span className="profile-section-note">Keys are configured on the server in <b>deploy/selfhost/.env</b>. Set <b>KIE_API_KEY</b> and <b>OPENROUTER_API_KEY</b>, then restart the instance.</span>
      </div> : <McpConnectionSection onBack={() => setSection("main")} />}
    </div>}
  </div>;
}
