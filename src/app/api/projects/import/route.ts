import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { db, ensureDefaultWorkspace, readProjectGraphSnapshot, rowToProject, workspaceRoleForUser } from "@/lib/postgres-db";
import { parseScenelithDocument, projectGraphFromScenelithDocument } from "@/lib/scenelith-document";

export const runtime = "nodejs";

const maximumDocumentBytes = 5 * 1024 * 1024;

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > maximumDocumentBytes) return Response.json({ error: "Scenelith document is larger than 5 MB" }, { status: 413 });
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > maximumDocumentBytes) return Response.json({ error: "Scenelith document is larger than 5 MB" }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Invalid JSON document" }, { status: 400 });
  }
  const wrapper = body && typeof body === "object" ? body as { workspaceId?: unknown; document?: unknown } : {};
  const workspaceId = typeof wrapper.workspaceId === "string" && wrapper.workspaceId
    ? wrapper.workspaceId
    : (await ensureDefaultWorkspace(auth.user.id))?.id;
  if (!workspaceId) return Response.json({ error: "This account cannot create canvases" }, { status: 403 });
  if (await workspaceRoleForUser(auth.user.id, workspaceId) !== "owner") return Response.json({ error: "App not found" }, { status: 404 });
  try {
    const document = parseScenelithDocument(wrapper.document ?? body);
    const graph = projectGraphFromScenelithDocument(document);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.prepare(
      "INSERT INTO projects (id, workspace_id, name, status, graph_json, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?, ?)",
    ).run(id, workspaceId, document.metadata.title, JSON.stringify(graph), now, now);
    const row = await db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Record<string, unknown>;
    const snapshot = await readProjectGraphSnapshot(id);
    return Response.json({ project: await rowToProject(row, snapshot), inputs: document.inputs }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Scenelith document import failed" }, { status: 422 });
  }
}
