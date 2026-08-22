import type { ProjectGraph } from "./types";

type CollaborativeSnapshot = {
  graph: ProjectGraph;
  revision: number;
  stateVector: string;
  updatedAt: string;
};

function collaborationUrl(projectId: string) {
  const base = process.env.COLLABORATION_INTERNAL_URL || "http://collaboration:1234";
  return new URL(`/internal/documents/${encodeURIComponent(projectId)}`, base);
}

function internalHeaders() {
  const secret = process.env.COLLABORATION_INTERNAL_SECRET;
  if (!secret) throw new Error("COLLABORATION_INTERNAL_SECRET is not configured");
  return { authorization: `Bearer ${secret}`, "content-type": "application/json" };
}

export async function readCollaborativeGraph(projectId: string): Promise<CollaborativeSnapshot> {
  const response = await fetch(collaborationUrl(projectId), {
    cache: "no-store",
    headers: internalHeaders(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Collaboration read failed (${response.status})`);
  return response.json() as Promise<CollaborativeSnapshot>;
}

export async function writeCollaborativeGraph(
  projectId: string,
  graph: ProjectGraph,
  expectedRevision: number,
  expectedStateVector?: string,
): Promise<CollaborativeSnapshot | { conflict: true; snapshot: CollaborativeSnapshot }> {
  const current = expectedStateVector ? null : await readCollaborativeGraph(projectId);
  if (current && current.revision !== expectedRevision) return { conflict: true, snapshot: current };
  const response = await fetch(collaborationUrl(projectId), {
    method: "PUT",
    headers: internalHeaders(),
    body: JSON.stringify({ graph, expectedRevision, expectedStateVector: expectedStateVector || current?.stateVector }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({})) as CollaborativeSnapshot & { error?: string };
  if (response.status === 409) return { conflict: true, snapshot: body };
  if (!response.ok) throw new Error(body.error || `Collaboration write failed (${response.status})`);
  return body;
}

export async function mutateCollaborativeGraph(
  projectId: string,
  mutator: (graph: ProjectGraph) => ProjectGraph,
  attempts = 5,
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = await readCollaborativeGraph(projectId);
    const result = await writeCollaborativeGraph(projectId, mutator(structuredClone(current.graph)), current.revision, current.stateVector);
    if (!("conflict" in result)) return result;
  }
  throw new Error("Canvas kept changing while applying a server update");
}

export async function revokeCollaborativeAccess(userId: string, documentNames?: string[]) {
  const base = process.env.COLLABORATION_INTERNAL_URL || "http://collaboration:1234";
  const response = await fetch(new URL("/internal/access/revoke", base), {
    method: "POST",
    cache: "no-store",
    headers: internalHeaders(),
    body: JSON.stringify({ userId, documentNames }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Collaboration access revocation failed (${response.status})`);
}

export async function deleteCollaborativeGraph(projectId: string) {
  const response = await fetch(collaborationUrl(projectId), {
    method: "DELETE",
    cache: "no-store",
    headers: internalHeaders(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Collaboration deletion failed (${response.status})`);
}
