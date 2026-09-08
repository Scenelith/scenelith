import type { BackgroundTaskRecord, FrameNode } from "./types";

/** PostgreSQL timestamps also arrive as `YYYY-MM-DD HH:mm:ss+00`. */
export function generationAttemptTime(value: string | undefined) {
  return Date.parse(String(value || "").replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
}

/** Restore only the latest attempt. Poll/update time does not order attempts. */
export function restoreGeneratorTask(node: FrameNode, task: BackgroundTaskRecord,
  recoveredOutputs: NonNullable<FrameNode["data"]["generatedOutputs"]> = []): FrameNode {
  const started = generationAttemptTime(task.createdAt);
  const applied = generationAttemptTime(node.data.generationAttemptCreatedAt);
  const generated = generationAttemptTime(node.data.generatedAt);
  if (started < applied) return node;
  // Older clients stored completion time in generatedAt. Recognize that exact
  // successful task so a persisted stale failure can heal without changing selection.
  const sameLegacyCompletion = task.status === "completed" && generated === generationAttemptTime(task.updatedAt);
  if (started < generated && !sameLegacyCompletion) return node;
  if (task.status !== "completed" && started <= generated) return node;
  if (task.status !== "completed") {
    const status = task.status === "running" ? "working" : task.status;
    const queueReason = status === "queued" ? "provider" : undefined;
    const generationError = status === "failed" ? task.error || "Generation failed" : undefined;
    if (node.data.status === status && node.data.queueReason === queueReason && node.data.generationError === generationError
      && applied === started) return node;
    return { ...node, data: { ...node.data, status, queueReason, generationError, generationAttemptCreatedAt: task.createdAt } };
  }
  if (!task.outputUrl) return node;
  const recorded = node.data.outputUrl === task.outputUrl || node.data.generatedOutputs?.some((output) => output.url === task.outputUrl);
  if (recorded) {
    if (node.data.status === "ready" && !node.data.queueReason && !node.data.generationError) return node;
    return { ...node, data: { ...node.data, status: "ready", queueReason: undefined, generationError: undefined, generationAttemptCreatedAt: task.createdAt } };
  }
  const output = { url: task.outputUrl, assetId: task.assetId || undefined, mediaType: task.mediaType || "image" as const, modelId: task.modelId };
  const previous = task.operation === "edit" && node.data.outputUrl
    ? [{ url: node.data.outputUrl, assetId: node.data.assetId, mediaType: node.data.mediaType || "image" as const, modelId: node.data.modelId }] : [];
  const history = [...(node.data.generatedOutputs || []), ...previous, ...recoveredOutputs, output]
    .filter((item, index, items) => items.findIndex((candidate) => candidate.url === item.url) === index).slice(-20);
  return { ...node, data: { ...node.data,
    ...(task.operation === "edit" ? { subtitle: "Image edited in place" } : {}),
    outputUrl: output.url, assetId: output.assetId, mediaType: output.mediaType, modelId: output.modelId,
    generatedAt: task.createdAt, generationAttemptCreatedAt: task.createdAt,
    generatedOutputs: history, activeGeneratedOutputIndex: history.length - 1,
    status: "ready", queueReason: undefined, generationError: undefined,
  } };
}
