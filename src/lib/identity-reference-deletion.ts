import { db, readProjectGraphSnapshot, writeProjectGraphSnapshot } from "./postgres-db";
import { readCollaborativeGraph, writeCollaborativeGraph } from "./collaboration-store";
import { detachAssetReferences } from "./detach-asset-references";

/** Finish detaching before deleting the asset. On conflict/outage the image stays
 * in the Library, so retrying deletion is safe and no dangling input is created.
 * Read live rooms too: their newest edits may not be in the SQL snapshot yet. */
export async function detachWorkspaceAssetReferences(workspaceId: string, assetIds: string[]) {
  const projects = await db.prepare("SELECT id FROM projects WHERE workspace_id = ? ORDER BY id")
    .all(workspaceId) as Array<{ id: string }>;
  const ids = new Set(assetIds);
  for (const project of projects) {
    let completed = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (process.env.COLLABORATION_INTERNAL_SECRET) {
        const current = await readCollaborativeGraph(project.id);
        const next = detachAssetReferences(current.graph, ids);
        if (next === current.graph) { completed = true; break; }
        const result = await writeCollaborativeGraph(project.id, next, current.revision, current.stateVector);
        if (!("conflict" in result)) { completed = true; break; }
      } else {
        const current = await readProjectGraphSnapshot(project.id);
        const next = detachAssetReferences(current.graph, ids);
        if (next === current.graph) { completed = true; break; }
        const result = await writeProjectGraphSnapshot(project.id, next, { expectedRevision: current.revision });
        if (result.ok) { completed = true; break; }
      }
    }
    if (!completed) throw Object.assign(new Error("Canvas changed while removing the reference. Please try again."), { status: 409 });
  }
}
