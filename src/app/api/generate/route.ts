import { z } from "zod";
import { requireApiUser } from "@/lib/auth";
import { db, readProjectGraphSnapshot, userCanAccessAsset, userCanAccessProject } from "@/lib/postgres-db";
import { generationProvider } from "@/platform/providers/registry";
import { admitGeneration } from "@/lib/generation-admission";
import { persistedProjectIdSchema } from "@/lib/project-id";
import type { ProjectGraph } from "@/lib/types";
import { resolveVideoMasterSourceTarget } from "@/lib/video-master";
import { validateVideoMasterGenerationReferences } from "@/lib/video-master-validation";

export const runtime = "nodejs";
export const maxDuration = 300;

const schema = z.object({
  projectId: persistedProjectIdSchema,
  nodeId: z.string().min(1),
  prompt: z.string().min(2).max(30000),
  modelId: z.string().min(1).default("nano-banana-2"),
  referenceAssetIds: z.array(z.string().uuid()).max(50).default([]),
  referenceLabels: z.array(z.string().min(1).max(80)).max(50).default([]),
  referenceRoles: z.array(z.enum(["reference-image", "start-frame", "end-frame", "motion-video", "reference-video", "reference-audio"])).max(50).default([]),
  aspectRatio: z.enum(["auto", "adaptive", "1:1", "1:4", "1:8", "2:1", "1:2", "2:3", "3:1", "1:3", "3:2", "4:1", "4:3", "3:4", "5:4", "4:5", "8:1", "16:9", "9:16", "21:9", "9:21"]).default("4:5"),
  resolution: z.enum(["1K", "2K", "3K", "4K", "480P", "720P", "1080P"]).default("1K"),
  // Reference-driven video models can use an exact source duration such as
  // 7.1 seconds. Provider-select models are still normalized against their
  // integer duration catalogue below.
  duration: z.string().regex(/^\d+(?:\.\d+)?$/).refine((value) => Number(value) >= 1 && Number(value) <= 30).default("5"),
  generateAudio: z.boolean().default(true),
  operation: z.enum(["generation", "edit"]).default("generation"),
  targetClipId: z.string().min(1).max(200).optional(),
  targetSourceAssetId: z.string().uuid().optional(),
});

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] || "request");
    const message = field === "duration"
      ? "Generation duration must be between 1 and 30 seconds"
      : field === "prompt"
        ? "The generation prompt is empty or too long"
        : field === "referenceAssetIds" || field === "referenceRoles" || field === "referenceLabels"
          ? "One of the generation references is invalid"
          : field === "aspectRatio"
            ? "The selected aspect ratio is invalid"
            : field === "resolution"
              ? "The selected resolution is invalid"
              : `Invalid generation request: ${field}`;
    console.warn("[generation:invalid-request]", JSON.stringify({ field, issue: parsed.error.issues[0]?.code }));
    return Response.json({ error: message }, { status: 400 });
  }
  if (!await userCanAccessProject(auth.user.id, parsed.data.projectId)) {
    return Response.json({ error: "Canvas not found" }, { status: 404 });
  }
  if (parsed.data.targetClipId) {
    const graph = (await readProjectGraphSnapshot(parsed.data.projectId)).graph as ProjectGraph;
    const target = graph ? resolveVideoMasterSourceTarget(graph.nodes, parsed.data.nodeId, parsed.data.targetClipId) : undefined;
    if (!target) return Response.json({ error: "The selected Video Master scene is no longer available" }, { status: 409 });
    if (target.sourceAssetId || target.sourceSegmentId) {
      const candidateId = parsed.data.targetSourceAssetId;
      const candidate = candidateId
        ? await db.prepare("SELECT metadata_json FROM assets WHERE id = ?").get(candidateId) as { metadata_json: string | null } | undefined
        : undefined;
      if (!candidateId || !candidate || !await userCanAccessAsset(auth.user.id, candidateId)) return Response.json({ error: "The generation source does not match the selected Video Master scene" }, { status: 409 });
      const sourceError = validateVideoMasterGenerationReferences({
        graph,
        nodeId: parsed.data.nodeId,
        clipId: parsed.data.targetClipId,
        targetSourceAssetId: candidateId,
        targetSourceMetadataJson: candidate.metadata_json,
        referenceAssetIds: parsed.data.referenceAssetIds,
        referenceRoles: parsed.data.referenceRoles,
      });
      if (sourceError) return Response.json({ error: sourceError }, { status: 409 });
    }
  }
  const provider = generationProvider();
  const model = provider.getModel(parsed.data.modelId);
  if (parsed.data.prompt.length > (model.maxPromptLength || 5000)) {
    return Response.json({ error: `${model.label} accepts prompts up to ${(model.maxPromptLength || 5000).toLocaleString("en-US")} characters` }, { status: 400 });
  }
  const selectedDuration = model.durations?.includes(parsed.data.duration) ? parsed.data.duration : model.defaultDuration || model.durations?.[0] || parsed.data.duration;
  const references = await Promise.all(parsed.data.referenceAssetIds.map(async (id, index) => {
    if (!await userCanAccessAsset(auth.user.id, id)) throw new Error(`Reference ${id} was not found`);
    const asset = await db.prepare("SELECT storage_path, mime_type, kind, role, metadata_json FROM assets WHERE id = ?").get(id) as
      | { storage_path: string; mime_type: string; kind: string; role: string | null; metadata_json: string | null }
      | undefined;
    if (!asset) throw new Error(`Reference ${id} was not found`);
    const requestedRole = parsed.data.referenceRoles[index] || "reference-image";
    const role = model.id === "kling-3-motion"
      ? requestedRole === "reference-image" ? "start-frame" : requestedRole === "motion-video" ? "reference-video" : requestedRole
      : requestedRole;
    const expectedMime = role === "motion-video" || role === "reference-video" ? "video/" : role === "reference-audio" ? "audio/" : "image/";
    if (!asset.mime_type.startsWith(expectedMime)) throw new Error(`${role} requires a ${expectedMime.slice(0, -1)} asset`);
    let durationSeconds = 0;
    try {
      const metadata = JSON.parse(asset.metadata_json || "{}") as { duration?: number | string; durationSeconds?: number | string };
      durationSeconds = Number(metadata.durationSeconds || metadata.duration || 0) || 0;
    } catch {}
    return {
      path: asset.storage_path,
      mimeType: asset.mime_type,
      role,
      durationSeconds,
      label: parsed.data.referenceLabels[index] || (asset.kind === "persona_ref" ? `Identity ${asset.role === "after" ? "After" : asset.role === "before" ? "Before" : "Character"} reference ${index + 1}` : `Composition reference ${index + 1}`),
    };
  }));
  if (references.length > model.maxReferences) return Response.json({ error: `${model.label} accepts at most ${model.maxReferences} reference inputs` }, { status: 400 });
  const allowedRoles = new Set((model.inputPorts || []).map((port) => port.id));
  const normalizedReferences = references.map((reference, index) => ({
    ...reference,
    role: allowedRoles.has(reference.role) ? reference.role : model.inputPorts?.[Math.min(index, Math.max(0, model.inputPorts.length - 1))]?.id || reference.role,
  }));
  const missingRequired = (model.inputPorts || []).filter((port) => port.required && !normalizedReferences.some((reference) => reference.role === port.id));
  if (missingRequired.length) return Response.json({ error: `Connect ${missingRequired.map((port) => port.label).join(" and ")} before generating` }, { status: 400 });
  for (const port of model.inputPorts || []) {
    if (port.max && normalizedReferences.filter((reference) => reference.role === port.id).length > port.max) {
      return Response.json({ error: `${port.label} accepts at most ${port.max} input${port.max === 1 ? "" : "s"}` }, { status: 400 });
    }
  }
  const hasVideoInput = normalizedReferences.some((reference) => reference.role === "reference-video" || reference.role === "motion-video");
  if (!hasVideoInput && model.videoInputOnlyResolutions?.includes(parsed.data.resolution)) {
    return Response.json({ error: `${model.label} ${parsed.data.resolution} requires a reference video` }, { status: 400 });
  }
  const allowedResolutions = provider.allowedResolutions(model, hasVideoInput);
  const resolution = allowedResolutions.includes(parsed.data.resolution)
    ? parsed.data.resolution
    : allowedResolutions.includes(model.defaultResolution || "")
      ? model.defaultResolution!
      : allowedResolutions[0];
  if (!resolution) return Response.json({ error: `${model.label} has no compatible resolution for these inputs` }, { status: 400 });
  const allowedRatios = provider.allowedRatios(model, resolution, normalizedReferences.length > 0);
  const aspectRatio = allowedRatios.includes(parsed.data.aspectRatio) ? parsed.data.aspectRatio : allowedRatios.includes(model.defaultRatio || "") ? model.defaultRatio! : allowedRatios[0];
  console.info("[generation:references]", JSON.stringify({
    nodeId: parsed.data.nodeId,
    modelId: parsed.data.modelId,
    aspectRatio,
    resolution,
    references: normalizedReferences.map((reference, index) => ({
      index: index + 1,
      assetId: parsed.data.referenceAssetIds[index],
      role: reference.role,
      token: reference.label,
    })),
  }));
  if (model.id.startsWith("seedance-2")) {
    const hasFrames = normalizedReferences.some((reference) => reference.role === "start-frame" || reference.role === "end-frame");
    const hasMultimodalReferences = normalizedReferences.some((reference) => reference.role === "reference-image" || reference.role === "reference-video" || reference.role === "reference-audio");
    if (hasFrames && hasMultimodalReferences) return Response.json({ error: "Seedance uses either start/end frames or multimodal references, not both" }, { status: 400 });
    const mediaDuration = model.referenceMediaDuration || { minSeconds: 2, maxSeconds: 15, maxTotalSeconds: 15 };
    for (const role of ["reference-video", "reference-audio"] as const) {
      const timedReferences = normalizedReferences.filter((reference) => reference.role === role && reference.durationSeconds > 0);
      if (timedReferences.some((reference) => reference.durationSeconds < mediaDuration.minSeconds || reference.durationSeconds > mediaDuration.maxSeconds)) {
        return Response.json({ error: `Each Seedance ${role === "reference-video" ? "reference video" : "audio input"} must be ${mediaDuration.minSeconds}–${mediaDuration.maxSeconds} seconds` }, { status: 400 });
      }
      const totalSeconds = timedReferences.reduce((total, reference) => total + reference.durationSeconds, 0);
      if (totalSeconds > mediaDuration.maxTotalSeconds) {
        return Response.json({ error: `Seedance ${role === "reference-video" ? "reference videos" : "audio inputs"} may total at most ${mediaDuration.maxTotalSeconds} seconds` }, { status: 400 });
      }
    }
  }
  if (model.id === "grok-video-image" && resolution === "1080P" && normalizedReferences.length > 1) {
    return Response.json({ error: `${model.label} accepts only one image at 1080P` }, { status: 400 });
  }
  if (model.id === "wan-2-7") {
    const hasFrames = normalizedReferences.some((reference) => reference.role === "start-frame" || reference.role === "end-frame");
    const hasContinuation = normalizedReferences.some((reference) => reference.role === "reference-video");
    if (hasFrames && hasContinuation) return Response.json({ error: "WAN 2.7 uses either start/end frames or a continuation clip, not both" }, { status: 400 });
  }
  if (model.id === "veo-3-1-fast") {
    const hasFrames = normalizedReferences.some((reference) => reference.role === "start-frame" || reference.role === "end-frame");
    const hasMaterials = normalizedReferences.some((reference) => reference.role === "reference-image");
    if (hasFrames && hasMaterials) return Response.json({ error: "Veo 3.1 Fast uses either first/last frames or material references, not both" }, { status: 400 });
    if (hasMaterials && selectedDuration !== "8") return Response.json({ error: "Veo material-reference mode supports only 8 seconds" }, { status: 400 });
  }
  if (normalizedReferences.some((reference) => reference.role === "end-frame") && !normalizedReferences.some((reference) => reference.role === "start-frame")) {
    return Response.json({ error: "Connect a start frame before an end frame" }, { status: 400 });
  }
  const inputVideoDurationSeconds = normalizedReferences
    .filter((reference) => reference.role === "reference-video" || reference.role === "motion-video")
    .reduce((total, reference) => total + reference.durationSeconds, 0);
  if (model.id === "kling-3-motion" && inputVideoDurationSeconds > 0 && (inputVideoDurationSeconds < 3 || inputVideoDurationSeconds > 30)) {
    return Response.json({ error: "Kling Motion Control reference video must be 3–30 seconds" }, { status: 400 });
  }
  const duration = model.durationSource === "reference-video" && inputVideoDurationSeconds > 0
    ? String(Math.ceil(inputVideoDurationSeconds))
    : selectedDuration;
  const result = await admitGeneration({
    userId: auth.user.id,
    projectId: parsed.data.projectId,
    nodeId: parsed.data.nodeId,
    prompt: parsed.data.prompt,
    model,
    references: normalizedReferences,
    operation: parsed.data.operation,
    aspectRatio,
    resolution,
    duration,
    generateAudio: parsed.data.generateAudio,
    hasVideoInput,
    inputVideoDurationSeconds,
    targetClipId: parsed.data.targetClipId,
    targetSourceAssetId: parsed.data.targetSourceAssetId,
  });
  if (!result.ok) {
    const headers = result.status === 429 ? { "Retry-After": String(Math.ceil((result.retryAfterMs || 3000) / 1000)) } : undefined;
    return Response.json(result, { status: result.status, headers });
  }
  return Response.json({ ...result, model }, { status: 202 });
}
