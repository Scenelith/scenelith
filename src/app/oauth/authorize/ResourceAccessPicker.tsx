"use client";

import { useMemo, useState } from "react";
import { Bot, Boxes, FolderOpen, Image, Images, LockKeyhole, Network, Play, Sparkles, Workflow } from "lucide-react";
import styles from "./oauth-authorize.module.css";

import { availableMcpConsentScopes, mcpConsentPermissionCopy, type McpConsentWorkspace } from "@/lib/mcp/consent-policy";
import type { McpScope } from "@/lib/mcp/oauth";
const icons = { "mcp:read": Boxes, "canvas:write": Network, "assistant:run": Bot, "generation:run": Sparkles, "library:write": Image, "import:write": Image, "identity:write": Image, "automation:write": Workflow, "automation:credentials": LockKeyhole, "automation:run": Play };
type Canvas = { id: string; name: string; workspaceId: string };

export function ResourceAccessPicker({ workspaces, canvases, requestedScopes }: { workspaces: McpConsentWorkspace[]; canvases: Canvas[]; requestedScopes: McpScope[] }) {
  const [workspaceId, setWorkspaceId] = useState("");
  const [specific, setSpecific] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const visibleCanvases = useMemo(() => canvases.filter((canvas) => !workspaceId || canvas.workspaceId === workspaceId), [canvases, workspaceId]);
  const workspaceNames = useMemo(() => new Map(workspaces.map((workspace) => [workspace.id, workspace.name])), [workspaces]);

  const [libraryAccess, setLibraryAccess] = useState(true);
  const [excludedScopes, setExcludedScopes] = useState<Set<McpScope>>(() => new Set());
  const selectedWorkspaceIds = new Set(visibleCanvases.filter((canvas) => selected.has(canvas.id)).map((canvas) => canvas.workspaceId));
  const scopeWorkspaces = workspaces.filter((workspace) => (!workspaceId || workspace.id === workspaceId) && (!specific || selectedWorkspaceIds.has(workspace.id)));
  const scopes = availableMcpConsentScopes(requestedScopes, scopeWorkspaces).filter((scope) => libraryAccess || !["library:write", "identity:write"].includes(scope));
  const restricted = scopeWorkspaces.length > 0 && scopeWorkspaces.every((workspace) => workspace.role === "member");
  const toggleScope = (scope: McpScope) => setExcludedScopes((current) => { const next = new Set(current); if (next.has(scope)) next.delete(scope); else next.add(scope); return next; });

  const toggleCanvas = (canvasId: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(canvasId)) next.delete(canvasId); else next.add(canvasId);
    return next;
  });

  return <div className={styles.resourcePicker}>
    <label className={styles.workspaceField}>
      <span>Workspace access</span>
      <select name="workspace_id" value={workspaceId} onChange={(event) => {
        setWorkspaceId(event.target.value);
        setSelected(new Set());
      }}>
        <option value="">All workspaces I can access</option>
        {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
      </select>
    </label>

    <input type="hidden" name="canvas_access" value={specific ? "specific" : "all"} />
    <div className={styles.canvasAccessHead}>
      <span><FolderOpen size={14} />Canvas access</span>
      <div className={styles.accessMode}>
        <button type="button" className={!specific ? styles.activeMode : ""} onClick={() => setSpecific(false)}>All accessible canvases</button>
        <button type="button" className={specific ? styles.activeMode : ""} onClick={() => setSpecific(true)}>Choose canvases</button>
      </div>
    </div>

    <p className={styles.accessSummary}>{specific ? `${selected.size} canvas${selected.size === 1 ? "" : "es"} selected` : `${visibleCanvases.length} accessible canvas${visibleCanvases.length === 1 ? "" : "es"}`}. Your agent can only access resources available to your account.</p>

    {specific && <div className={styles.canvasChoices}>
      {visibleCanvases.length ? visibleCanvases.map((canvas) => <label key={canvas.id}>
        <input type="checkbox" name="project_id" value={canvas.id} checked={selected.has(canvas.id)} onChange={() => toggleCanvas(canvas.id)} />
        <span><strong>{canvas.name}</strong>{!workspaceId && <small>{workspaceNames.get(canvas.workspaceId) || "Workspace"}</small>}</span>
      </label>) : <p>No canvases are available in this workspace.</p>}
      {visibleCanvases.length > 0 && selected.size === 0 && <small className={styles.selectionNote}>Choose at least one canvas.</small>}
    </div>}

    <label className={styles.libraryAccess}>
      <span className={styles.libraryIcon}><Images size={15} /></span>
      <span><strong>Allow Library access</strong><small>Only media belonging to the projects and canvases allowed above will be visible.</small></span>
      <input type="checkbox" name="library_access" value="true" checked={libraryAccess} onChange={(event) => setLibraryAccess(event.target.checked)} />
    </label>

    <div className={styles.permissionHeading}><span className={styles.sectionLabel}>What your agent can do</span><small>Based on your access</small></div>
    <div className={styles.permissions}>
      {scopes.map((scope) => {
        const permission = mcpConsentPermissionCopy(scope, scopeWorkspaces);
        const Icon = icons[scope];
        return <label className={styles.permission} key={scope}>
          <span className={styles.permissionIcon}><Icon size={17} /></span>
          <span><strong>{permission.title}</strong><small>{permission.detail}</small></span>
          {scope === "mcp:read" ? <span className={styles.required}>Required</span> : <input type="checkbox" name="scope" value={scope} checked={!excludedScopes.has(scope)} onChange={() => toggleScope(scope)} />}
        </label>;
      })}
    </div>
    {restricted && <div className={styles.roleBoundary}><LockKeyhole size={16} /><div><strong>Owner permissions stay with the owner</strong><p>Creating canvases, publishing workflows, and managing triggers or credentials are not granted by this connection.</p></div></div>}
    {!scopeWorkspaces.length && <p className={styles.accessSummary}>{specific ? "Choose a canvas to see its available actions." : "No workspace access is available yet. Your agent will only be able to check which resources become accessible."}</p>}
  </div>;
}
