import { z } from "zod";
import { requireApiUser } from "@/lib/auth";
import { userCanAccessWorkspace } from "@/lib/postgres-db";
import { TeamError, teamSnapshot } from "@/lib/team";

export const runtime = "nodejs";

const workspaceSchema = z.string().uuid();

export async function GET(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const workspaceId = workspaceSchema.safeParse(new URL(request.url).searchParams.get("workspaceId"));
  if (!workspaceId.success || !await userCanAccessWorkspace(auth.user.id, workspaceId.data)) {
    return Response.json({ error: "Workspace not found" }, { status: 404 });
  }
  try {
    return Response.json({ team: await teamSnapshot(workspaceId.data, auth.user.id) }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) {
    if (error instanceof TeamError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
