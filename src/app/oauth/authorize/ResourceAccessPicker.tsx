"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Boxes, FolderOpen, Image, Images, LockKeyhole, Network, Play, Sparkles, Workflow } from "lucide-react";
import styles from "./oauth-authorize.module.css";

import { availableMcpConsentScopes, mcpConsentGroups, mcpConsentPermissionCopy, type McpConsentWorkspace } from "@/lib/mcp/consent-policy";
import {editionMcpConfig} from "@/editions/current/mcp-config";
import type { McpScope } from "@/lib/mcp/oauth";
const icons = { "mcp:read": Boxes, "canvas:write": Network, "assistant:run": Bot, "generation:run": Sparkles, "library:write": Image, "import:write": Image, "identity:write": Image, "automation:write": Workflow, "automation:credentials": LockKeyhole, "automation:run": Play };
type Canvas = { id: string; name: string; workspaceId: string };

function GroupToggle({checked,mixed,label,onChange}:{checked:boolean;mixed:boolean;label:string;onChange:()=>void}) {
  const ref=useRef<HTMLInputElement>(null);
  useEffect(()=>{if(ref.current)ref.current.indeterminate=mixed;},[mixed]);
  return <input ref={ref} type="checkbox" aria-label={label} checked={checked} onChange={onChange}/>;
}

export function ResourceAccessPicker({ workspaces, canvases, requestedScopes }: { workspaces: McpConsentWorkspace[]; canvases: Canvas[]; requestedScopes: McpScope[] }) {
  const [workspaceId, setWorkspaceId] = useState(workspaces.length === 1 ? workspaces[0].id : "");
  const [specific, setSpecific] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const visibleCanvases = useMemo(() => canvases.filter((canvas) => !workspaceId || canvas.workspaceId === workspaceId), [canvases, workspaceId]);
  const workspaceNames = useMemo(() => new Map(workspaces.map((workspace) => [workspace.id, workspace.name])), [workspaces]);

  const [libraryAccess, setLibraryAccess] = useState(true);
  const [excludedScopes, setExcludedScopes] = useState<Set<McpScope>>(() => new Set(editionMcpConfig.permissions.map(p=>p.id)));
  const selectedWorkspaceIds = new Set(visibleCanvases.filter((canvas) => selected.has(canvas.id)).map((canvas) => canvas.workspaceId));
  const scopeWorkspaces = workspaces.filter((workspace) => (!workspaceId || workspace.id === workspaceId) && (!specific || selectedWorkspaceIds.has(workspace.id)));
  const requiresWorkspace = (scope:string)=>editionMcpConfig.permissions.some(p=>p.id===scope&&p.requiresWorkspace);
  const editionIds=new Set(editionMcpConfig.permissions.map(p=>p.id));
  const scopes = [...availableMcpConsentScopes(requestedScopes.filter(s=>!editionIds.has(s)), scopeWorkspaces),...availableMcpConsentScopes(requestedScopes.filter(s=>editionIds.has(s)),workspaces.filter(w=>w.id===workspaceId))].filter((scope) => libraryAccess || !["library:write", "identity:write"].includes(scope));
  const restricted = scopeWorkspaces.length > 0 && scopeWorkspaces.every((workspace) => workspace.role === "member");
  const toggleScope = (scope: McpScope) => setExcludedScopes((current) => { const next = new Set(current); if (next.has(scope)) next.delete(scope); else next.add(scope); return next; });

  const groups=mcpConsentGroups(scopes,editionMcpConfig.permissionGroups||[]);
  const grouped=new Set(groups.flatMap(group=>group.scopes));
  const renderPermission=(scope:McpScope)=>{
    const permission=mcpConsentPermissionCopy(scope,scopeWorkspaces),Icon=icons[scope as keyof typeof icons]||Sparkles;
    return <label className={styles.permission} key={scope}>
      <span className={styles.permissionIcon}><Icon size={17}/></span>
      <span><strong>{scope==="mcp:read"?"View resources":permission.title}</strong>{scope!=="mcp:read"&&<small>{permission.detail}</small>}</span>
      {scope==="mcp:read"?<span className={styles.required}>Required</span>:<input type="checkbox" name="scope" value={scope} disabled={!workspaceId&&requiresWorkspace(scope)} checked={!excludedScopes.has(scope)&&(!requiresWorkspace(scope)||!!workspaceId)} onChange={()=>toggleScope(scope)}/>}
    </label>;
  };

  const toggleCanvas = (canvasId: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(canvasId)) next.delete(canvasId); else next.add(canvasId);
    return next;
  });

  return <div className={styles.resourcePicker}>
    <label className={styles.workspaceField}>
      <span>Workspace</span>
      <select name="workspace_id" value={workspaceId} onChange={(event) => {
        setWorkspaceId(event.target.value);
        setSelected(new Set());
      }}>
        <option value="">All workspaces I can access</option>
        {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
      </select>
    </label>

    <details className={styles.customize}>
      <summary><span>Customize access</span><small>{specific ? `${selected.size} canvas${selected.size===1?'':'es'}` : 'All canvases'} · Library {libraryAccess ? 'on' : 'off'}</small></summary>
    <input type="hidden" name="canvas_access" value={specific ? "specific" : "all"} />
    <div className={styles.canvasAccessHead}>
      <span><FolderOpen size={14} />Canvas access</span>
      <div className={styles.accessMode}>
        <button type="button" className={!specific ? styles.activeMode : ""} onClick={() => setSpecific(false)}>All accessible canvases</button>
        <button type="button" className={specific ? styles.activeMode : ""} onClick={() => setSpecific(true)}>Choose canvases</button>
      </div>
    </div>

    <p className={styles.accessSummary}>{specific ? `${selected.size} canvas${selected.size === 1 ? "" : "es"} selected` : `${visibleCanvases.length} accessible canvas${visibleCanvases.length === 1 ? "" : "es"}`}</p>

    {specific && <div className={styles.canvasChoices}>
      {visibleCanvases.length ? visibleCanvases.map((canvas) => <label key={canvas.id}>
        <input type="checkbox" name="project_id" value={canvas.id} checked={selected.has(canvas.id)} onChange={() => toggleCanvas(canvas.id)} />
        <span><strong>{canvas.name}</strong>{!workspaceId && <small>{workspaceNames.get(canvas.workspaceId) || "Workspace"}</small>}</span>
      </label>) : <p>No canvases are available in this workspace.</p>}
      {visibleCanvases.length > 0 && selected.size === 0 && <small className={styles.selectionNote}>Choose a canvas, or leave empty for edition-only access.</small>}
    </div>}

    <label className={styles.libraryAccess}>
      <span className={styles.libraryIcon}><Images size={15} /></span>
      <span><strong>Library access</strong></span>
      <input type="checkbox" name="library_access" value="true" checked={libraryAccess} onChange={(event) => setLibraryAccess(event.target.checked)} />
    </label>

    </details>
    <div className={styles.permissionHeading}><span className={styles.sectionLabel}>Permissions</span></div>
    <div className={styles.permissions}>
      {scopes.filter(scope=>!grouped.has(scope)).map(scope=>scope==='mcp:read'?<section key={scope} className={styles.basicPermission}>{renderPermission(scope)}<details><summary>Details</summary><p className={styles.groupSummary}>{mcpConsentPermissionCopy(scope,scopeWorkspaces).detail}</p></details></section>:renderPermission(scope))}
      {groups.map(group=>{
        const enabled=group.scopes.filter(scope=>!excludedScopes.has(scope));
        return <section key={group.id} className={styles.permissionGroup}>
          <label className={styles.groupHeading}><strong>{group.title}</strong><GroupToggle label={group.title} checked={enabled.length===group.scopes.length} mixed={enabled.length>0&&enabled.length<group.scopes.length} onChange={()=>setExcludedScopes(current=>{const next=new Set(current);for(const scope of group.scopes){if(enabled.length===group.scopes.length)next.add(scope);else next.delete(scope);}return next;})}/></label>
          <details><summary>Details <span>{enabled.length}/{group.scopes.length}</span></summary><p className={styles.groupSummary}>{group.detail&&group.scopes.length===editionMcpConfig.permissionGroups?.find(item=>item.id===group.id)?.scopes.length?group.detail:group.scopes.map(scope=>mcpConsentPermissionCopy(scope,scopeWorkspaces).detail).join(' ')}</p>
          <div>{group.scopes.map(renderPermission)}</div></details>
        </section>;
      })}
    </div>
    {!workspaceId&&requestedScopes.some(requiresWorkspace)&&<p className={styles.accessSummary}>Choose a workspace to enable more actions.</p>}
    {restricted && <div className={styles.roleBoundary}><LockKeyhole size={16} /><div><strong>Owner permissions stay with the owner</strong><p>Creating canvases, publishing workflows, and managing triggers or credentials are not granted by this connection.</p></div></div>}
    {!scopeWorkspaces.length && <p className={styles.accessSummary}>{specific ? "Choose a canvas to see its available actions." : "No workspace access is available yet. Your agent will only be able to check which resources become accessible."}</p>}
  </div>;
}
