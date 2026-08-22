import { z } from "zod";
import { requireApiUser } from "@/lib/auth";
import { usageWorkspaceForUserWorkspace, userCanAccessWorkspace } from "@/lib/postgres-db";
import { usageSummary } from "@/modules/usage";

const querySchema = z.string().uuid();

export async function GET(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const workspaceId = querySchema.safeParse(new URL(request.url).searchParams.get("workspaceId"));
  if (!workspaceId.success || !await userCanAccessWorkspace(auth.user.id, workspaceId.data)) {
    return Response.json({ error: "Workspace not found" }, { status: 404 });
  }
  const usageWorkspaceId = await usageWorkspaceForUserWorkspace(auth.user.id, workspaceId.data);
  if (!usageWorkspaceId) return Response.json({ error: "Workspace not found" }, { status: 404 });
  return Response.json(
    { usage: await usageSummary(usageWorkspaceId) },
    { headers: { "Cache-Control": "private, no-store, max-age=0" } },
  );
}
