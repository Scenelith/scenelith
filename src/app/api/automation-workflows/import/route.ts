import { z } from "zod";
import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { AutomationPackageError } from "@/lib/automation-workflows/portable";
import { importAutomationWorkflowPackage, publishAutomationWorkflow } from "@/lib/automation-workflows/repository";
import { enforceDistributedRateLimit } from "@/lib/distributed-rate-limit";
import { automationApiErrorResponse } from "@/lib/automation-workflows/api-errors";
import { automationCapabilitiesForWorkspace } from "@/lib/automation-workflows/permissions";

export const runtime = "nodejs";

const importSchema = z.object({
  projectId: z.string().min(1),
  package: z.unknown(),
}).strict();

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const limited = await enforceDistributedRateLimit({ scope: "automation-workflow-import", identity: auth.user.id, limit: 20, windowSeconds: 600 });
  if (limited) return limited;
  const parsed = importSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Canvas and automation package are required" }, { status: 400 });
  try {
    const imported = await importAutomationWorkflowPackage({ userId: auth.user.id, ...parsed.data });
    if (!imported) return Response.json({ error: "Canvas not found" }, { status: 404 });
    if (imported.validation.valid && imported.detail) {
      const capabilities = await automationCapabilitiesForWorkspace(auth.user.id, imported.detail.workflow.workspaceId);
      if (capabilities.publish) imported.detail = (await publishAutomationWorkflow(auth.user.id, imported.detail.workflow.id))?.detail || imported.detail;
    }
    return Response.json(imported, { status: 201 });
  } catch (error) {
    if (error instanceof AutomationPackageError) return Response.json({ error: error.message, code: error.code }, { status: 422 });
    return automationApiErrorResponse(error, "Automation package could not be imported");
  }
}
