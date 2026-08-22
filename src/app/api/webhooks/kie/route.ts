import { db } from "@/lib/postgres-db";
import { generationProvider } from "@/platform/providers/registry";
import { isGenerationTimeoutError } from "@/lib/generation-lifecycle";
import { finalizeGenerationFromWebhook } from "@/lib/generation-state";
import { advanceGenerationProviderWorkflow } from "@/lib/generation-dispatch";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const raw = await request.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const provider = generationProvider("kie");
  const task = provider.normalizeWebhook(body);
  if (!task.task_id || !provider.verifyWebhook(task.task_id, request.headers)) {
    console.warn("[kie:webhook-rejected]", JSON.stringify({
      hasTaskId: Boolean(task.task_id),
      hasTimestamp: Boolean(request.headers.get("x-webhook-timestamp")),
      hasSignature: Boolean(request.headers.get("x-webhook-signature")),
    }));
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }
  const providerError = task.error
    ? typeof task.error === "string" ? task.error : JSON.stringify(task.error)
    : null;
  const existing = await db.prepare("SELECT id, status, error FROM generations WHERE provider_task_id = ?").get(task.task_id) as
    | { id: string; status: string; error: string | null }
    | undefined;
  if (existing?.status === "failed" && isGenerationTimeoutError(existing.error)) {
    console.warn("[kie:webhook-late-timeout]", JSON.stringify({ taskId: task.task_id, status: task.status, generationId: existing.id }));
    return Response.json({ ok: true, ignored: "generation_timed_out" });
  }
  const status = String(task.status || "").toLowerCase();
  if (existing && await advanceGenerationProviderWorkflow({
    generationId: existing.id,
    providerTaskId: task.task_id,
    providerStatus: status,
  })) {
    console.info("[kie:webhook-workflow]", JSON.stringify({ taskId: task.task_id, status, generationId: existing.id }));
    return Response.json({ ok: true, workflowAdvanced: true });
  }
  const result = await db.prepare("UPDATE generations SET status = ?, output_url = COALESCE(?, output_url), error = COALESCE(?, error), updated_at = ? WHERE provider_task_id = ?").run(
    String(task.status || "updated").toLowerCase(),
    task.generated?.[0] || null,
    providerError,
    new Date().toISOString(),
    task.task_id,
  );
  const generation = await db.prepare("SELECT id FROM generations WHERE provider_task_id = ?").get(task.task_id) as { id: string } | undefined;
  if (generation) {
    try {
      await finalizeGenerationFromWebhook({
        generationId: generation.id,
        status,
        outputUrl: task.generated?.[0] || null,
        error: providerError,
      });
    } catch (error) {
      console.error("[kie:webhook-finalize-failed]", { generationId: generation.id, taskId: task.task_id, error });
    }
  }
  console.info("[kie:webhook]", JSON.stringify({
    taskId: task.task_id,
    status: task.status,
    outputCount: task.generated?.length || 0,
    matchedGenerations: result.changes,
    hasError: Boolean(providerError),
  }));
  return Response.json({ ok: true });
}
