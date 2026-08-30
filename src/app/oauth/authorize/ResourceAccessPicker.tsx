"use client";

import { useMemo, useState } from "react";
import { FolderOpen, Images } from "lucide-react";
import styles from "./oauth-authorize.module.css";

type Workspace = { id: string; name: string };
type Canvas = { id: string; name: string; workspaceId: string };

export function ResourceAccessPicker({ workspaces, canvases }: { workspaces: Workspace[]; canvases: Canvas[] }) {
  const [workspaceId, setWorkspaceId] = useState("");
  const [specific, setSpecific] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const visibleCanvases = useMemo(() => canvases.filter((canvas) => !workspaceId || canvas.workspaceId === workspaceId), [canvases, workspaceId]);
  const workspaceNames = useMemo(() => new Map(workspaces.map((workspace) => [workspace.id, workspace.name])), [workspaces]);

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
      <span><FolderOpen size={14} />Project / canvas access</span>
      <div className={styles.accessMode}>
        <button type="button" className={!specific ? styles.activeMode : ""} onClick={() => setSpecific(false)}>All projects</button>
        <button type="button" className={specific ? styles.activeMode : ""} onClick={() => setSpecific(true)}>Choose projects</button>
      </div>
    </div>

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
      <input type="checkbox" name="library_access" value="true" defaultChecked />
    </label>
  </div>;
}
