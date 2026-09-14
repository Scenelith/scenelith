import { requireApiUser } from "@/lib/auth";
import { generationCapacity } from "@/lib/generation-capacity";
import { userCanAccessProject } from "@/lib/postgres-db";
import { persistedProjectIdSchema } from "@/lib/project-id";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const projectId = persistedProjectIdSchema.safeParse(new URL(request.url).searchParams.get("projectId"));
  if (!projectId.success || !await userCanAccessProject(auth.user.id, projectId.data)) {
    return Response.json({ error: "Canvas not found" }, { status: 404 });
  }
  const capacity = await generationCapacity(auth.user.id, projectId.data);
  if (!capacity) return Response.json({ error: "Canvas not found" }, { status: 404 });
  return Response.json(capacity, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
}
