import { SignJWT } from "jose";
import { requireApiUser } from "@/lib/auth";
import { db, userCanAccessProject, workspaceRoleForUser } from "@/lib/postgres-db";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const body = await request.json().catch(() => null) as { projectId?: string } | null;
  const projectId = String(body?.projectId || "");
  if (!projectId || !await userCanAccessProject(auth.user.id, projectId)) {
    return Response.json({ error: "Canvas not found" }, { status: 404 });
  }
  const project = await db.prepare("SELECT workspace_id FROM projects WHERE id = ?").get(projectId) as { workspace_id: string } | undefined;
  if (!project) return Response.json({ error: "Canvas not found" }, { status: 404 });
  const secret = process.env.COLLABORATION_JWT_SECRET;
  if (!secret) return Response.json({ error: "Collaboration is not configured" }, { status: 503 });
  const role = await workspaceRoleForUser(auth.user.id, project.workspace_id);
  const permission = role === "owner" || role === "member" ? "write" : "read";
  const collaborationDocument = await db.prepare("SELECT epoch, compacting FROM collaboration_documents WHERE document_name = ?")
    .get(projectId) as { epoch: number; compacting: number } | undefined;
  if (collaborationDocument?.compacting) return Response.json({ error: "Canvas checkpoint is in progress" }, { status: 503 });
  const documentEpoch = Math.max(1, Number(collaborationDocument?.epoch || 1));
  const token = await new SignJWT({
    projectId,
    documentEpoch,
    workspaceId: project.workspace_id,
    permission,
    role: role || "member",
    name: auth.user.name,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(auth.user.id)
    .setIssuer("frameflow-web")
    .setAudience("frameflow-collaboration")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(secret));
  return Response.json({ token, documentEpoch, expiresIn: 300 }, { headers: { "cache-control": "no-store" } });
}
