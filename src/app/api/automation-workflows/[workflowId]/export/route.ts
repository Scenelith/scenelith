import { requireApiUser } from "@/lib/auth";
import { exportAutomationWorkflowPackage } from "@/lib/automation-workflows/repository";

export const runtime = "nodejs";

export async function GET(request: Request, context: RouteContext<"/api/automation-workflows/[workflowId]/export">) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { workflowId } = await context.params;
  const requested = new URL(request.url).searchParams.get("version");
  const version = requested === "draft" ? "draft" : "published";
  const result = await exportAutomationWorkflowPackage({ userId: auth.user.id, workflowId, version });
  if (!result) return Response.json({ error: "Workflow not found" }, { status: 404 });
  if ("error" in result) return Response.json(result, { status: 409 });
  return new Response(`${JSON.stringify(result.package, null, 2)}\n`, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${result.filename}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
