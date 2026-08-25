"use client";

import { useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck, PlugZap, UserRound } from "lucide-react";
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
  const [section, setSection] = useState<"main" | "providers">("main");
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

    {open && <div className="profile-popover" role="menu" aria-label="Profile settings">
      {section === "main" ? <>
        <div className="profile-identity"><span className="profile-avatar is-large"><UserRound aria-hidden="true" /></span><span><strong>{user.name || "Scenelith creator"}</strong><small>{user.email}</small></span></div>
        <div className="profile-plan"><span><small>{account.summaryLabel}</small><strong>{account.summaryValue}</strong></span></div>
        <div className="profile-settings-list">
          {ProductAccountMenuExtension && <ProductAccountMenuExtension user={user} workspaceName={workspaceName} workspaceRole={workspaceRole} onOpen={(kind) => { dismiss(); onOpenProductPanel(kind); }} />}
          {usage.usageMode === "unmetered" && <button type="button" role="menuitem" onClick={() => setSection("providers")}><span><strong><PlugZap size={13} />Providers</strong><small>Kie · OpenRouter · Tikwm</small></span><i aria-hidden="true" /></button>}
          {AccountMenuExtension && <AccountMenuExtension usage={usage} workspaceId={workspaceId} workspaceOwner={workspaceRole === "owner"} onDismiss={dismiss} onRequestView={onRequestAccountView} />}
          <a role="menuitem" href="https://docs.scenelith.com" target="_blank" rel="noreferrer"><span><strong>Docs</strong><small>Workflows, nodes and generation</small></span><i aria-hidden="true" /></a>
        </div>
        <button type="button" className="profile-sign-out" role="menuitem" onClick={() => void signOut()}>Sign out</button>
      </> : <div className="profile-section">
        <button type="button" className="profile-section-back" onClick={() => setSection("main")}><i aria-hidden="true" />Profile</button>
        <h3>Provider connections</h3>
        <p>Your instance calls these providers directly. Scenelith does not proxy or meter their usage.</p>
        <div className="profile-provider-list">
          {providers?.map((provider) => <article key={provider.id} className={provider.configured ? "is-connected" : "is-missing"}><span className="profile-provider-mark" aria-hidden="true">{provider.name.slice(0, 1)}</span><span className="profile-provider-copy"><strong>{provider.name}</strong><small>{provider.description}</small><em>{provider.capabilities.join(" · ")}</em></span><span className="profile-provider-status">{provider.configured ? <CircleCheck size={13} /> : <CircleAlert size={13} />}{provider.requiresKey ? provider.configured ? "Connected" : "Key required" : "Available"}</span></article>)}
          {!providers && !providersError && <span className="profile-provider-loading">Reading instance configuration…</span>}
          {providersError && <span className="profile-provider-loading is-error">{providersError}</span>}
        </div>
        <span className="profile-section-note">Keys are configured on the server in <b>deploy/selfhost/.env</b>. Set <b>KIE_API_KEY</b> and <b>OPENROUTER_API_KEY</b>, then restart the instance.</span>
      </div>}
    </div>}
  </div>;
}
