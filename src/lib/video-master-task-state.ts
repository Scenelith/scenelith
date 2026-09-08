import { generationAttemptTime } from "./generator-task-state";
import type { BackgroundTaskRecord, FrameNode } from "./types";

/** The worker writes scene outputs; task polling only restores the active scene status. */
export function restoreVideoMasterTask(node: FrameNode, task: BackgroundTaskRecord): FrameNode {
  if (task.status === "completed") return node;
  // A task response fetched before completion can arrive after the worker's graph update.
  if (generationAttemptTime(node.data.generatedAt) >= generationAttemptTime(task.createdAt)
    || generationAttemptTime(node.data.generationAttemptCreatedAt) > generationAttemptTime(task.createdAt)) return node;
  const clipId = task.targetClipId || node.data.videoMasterGeneratingClipId;
  if (!clipId || !node.data.videoMasterClips?.some((clip) => clip.id === clipId)) return node;
  const status = task.status === "running" ? "working" : task.status;
  const queueReason = status === "queued" ? "provider" : undefined;
  const generationError = status === "failed" ? task.error || "Generation failed" : undefined;
  if (node.data.status === status && node.data.videoMasterGeneratingClipId === clipId
    && node.data.queueReason === queueReason && node.data.generationError === generationError
    && node.data.generationAttemptCreatedAt === task.createdAt) return node;
  return { ...node, data: { ...node.data, status, queueReason, generationError, generationAttemptCreatedAt: task.createdAt, videoMasterGeneratingClipId: clipId } };
}
