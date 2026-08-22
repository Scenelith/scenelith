import { z } from "zod";
import { normalizeProjectGraph } from "./canvas-graph";
import type { FrameEdge, FrameNode, FrameNodeData, ProjectGraph, VideoMasterClip } from "./types";

export const SCENELITH_DOCUMENT_FORMAT = "scenelith.canvas" as const;
export const CURRENT_SCENELITH_DOCUMENT_VERSION = 1 as const;
export const MINIMUM_SCENELITH_VERSION = "0.1.0" as const;

const shortText = z.string().trim().min(1).max(240);
const longText = z.string().max(30_000);
const finiteNumber = z.number().finite();
const nodeKind = z.enum(["source", "scene", "persona", "hook", "prompt", "assistant", "generation", "videoMaster", "note"]);
const mediaType = z.enum(["image", "video"]);
const aspectRatio = z.enum(["auto", "adaptive", "1:1", "1:4", "1:8", "2:1", "1:2", "2:3", "3:1", "1:3", "3:2", "4:1", "4:3", "3:4", "5:4", "4:5", "8:1", "16:9", "9:16", "21:9", "9:21"]);
const resolution = z.enum(["1K", "2K", "3K", "4K", "480P", "720P", "1080P"]);

const portableClipSchema = z.object({
  id: z.string().min(1).max(120),
  sequenceIndex: z.number().int().nonnegative().optional(),
  title: shortText,
  role: z.enum(["hook", "scene", "cta"]),
  origin: z.enum(["source", "upload", "generated"]),
  duration: finiteNumber.nonnegative().max(3_600),
  generationDuration: finiteNumber.nonnegative().max(3_600).optional(),
  prompt: longText,
  modelId: z.string().min(1).max(160).optional(),
  aspectRatio: z.string().min(1).max(20).optional(),
  aspectRatioMode: z.enum(["original", "custom"]).optional(),
  sourceAspectRatio: finiteNumber.positive().max(100).optional(),
  resolution: z.string().min(1).max(20).optional(),
  generateAudio: z.boolean().optional(),
}).strict();

const portableNodeDataSchema = z.object({
  kind: nodeKind,
  title: shortText,
  subtitle: z.string().max(500).optional(),
  hookText: longText.optional(),
  noteText: longText.optional(),
  noteColor: z.enum(["yellow", "blue", "rose", "gray"]).optional(),
  role: z.string().max(80).optional(),
  prompt: longText.optional(),
  assistantInput: longText.optional(),
  assistantOutput: longText.optional(),
  systemPrompt: longText.optional(),
  textModelId: z.string().min(1).max(160).optional(),
  mediaType: mediaType.optional(),
  modelId: z.string().min(1).max(160).optional(),
  duration: z.string().min(1).max(20).optional(),
  generateAudio: z.boolean().optional(),
  aspectRatio: aspectRatio.optional(),
  ratioMode: z.enum(["custom", "original"]).optional(),
  resolution: resolution.optional(),
  generationCount: z.number().int().min(1).max(20).optional(),
  nodeWidth: finiteNumber.min(120).max(2_000).optional(),
  nodeHeight: finiteNumber.min(80).max(2_000).optional(),
  videoMasterClips: z.array(portableClipSchema).max(200).optional(),
  videoMasterSelectedClipId: z.string().min(1).max(120).optional(),
}).strict();

const portableNodeSchema = z.object({
  id: z.string().min(1).max(120),
  type: z.string().min(1).max(80).optional(),
  position: z.object({ x: finiteNumber, y: finiteNumber }).strict(),
  data: portableNodeDataSchema,
}).strict();

const portableEdgeDataSchema = z.object({
  portType: z.enum(["text", "image", "video", "audio"]).optional(),
  inputRole: z.enum(["reference-image", "start-frame", "end-frame", "motion-video", "reference-video", "reference-audio"]).optional(),
  masterClipId: z.string().min(1).max(120).optional(),
  automationKind: z.literal("tiktok-slideshow").optional(),
  automationSlideIndex: z.number().int().positive().max(1_000).optional(),
  sourceSegmentStart: finiteNumber.nonnegative().max(86_400).optional(),
  sourceSegmentEnd: finiteNumber.nonnegative().max(86_400).optional(),
  sourceSegmentLabel: z.string().max(160).optional(),
  generationClipDuration: finiteNumber.positive().max(3_600).optional(),
}).strict();

const portableEdgeSchema = z.object({
  id: z.string().min(1).max(120),
  source: z.string().min(1).max(120),
  target: z.string().min(1).max(120),
  sourceHandle: z.string().max(120).nullable().optional(),
  targetHandle: z.string().max(120).nullable().optional(),
  type: z.string().min(1).max(80).optional(),
  data: portableEdgeDataSchema.optional(),
}).strict();

export const scenelithDocumentV1Schema = z.object({
  format: z.literal(SCENELITH_DOCUMENT_FORMAT),
  version: z.literal(CURRENT_SCENELITH_DOCUMENT_VERSION),
  minimumScenelithVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  metadata: z.object({
    title: shortText,
    description: z.string().max(2_000).optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  }).strict(),
  requirements: z.object({
    providers: z.array(z.string().min(1).max(80)).max(20),
    capabilities: z.array(z.string().min(1).max(80)).max(40),
    models: z.array(z.object({ provider: z.string().min(1).max(80), id: z.string().min(1).max(160) }).strict()).max(100),
  }).strict(),
  inputs: z.array(z.object({
    nodeId: z.string().min(1).max(120),
    kind: z.enum(["image", "video", "identity"]),
    label: shortText,
    required: z.boolean(),
  }).strict()).max(500),
  graph: z.object({
    nodes: z.array(portableNodeSchema).max(500),
    edges: z.array(portableEdgeSchema).max(1_000),
    viewport: z.object({ x: finiteNumber, y: finiteNumber, zoom: finiteNumber.positive().max(20) }).strict().optional(),
  }).strict(),
}).strict();

export type ScenelithDocumentV1 = z.infer<typeof scenelithDocumentV1Schema>;

const possibleSecret = /(?:\b(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret|password)\b\s*[:=]\s*\S+|\bsk-(?:or-v1-)?[A-Za-z0-9_-]{16,}|\bBearer\s+[A-Za-z0-9._~+/-]{16,})/i;

function assertNoEmbeddedSecret(value: unknown) {
  const serialized = JSON.stringify(value);
  if (possibleSecret.test(serialized)) throw new Error("Scenelith documents cannot contain credentials or API keys");
}

function copyString(data: FrameNodeData, key: keyof FrameNodeData, maximum: number) {
  const value = data[key];
  return typeof value === "string" && value.length <= maximum ? value : undefined;
}

function sanitizeClip(clip: VideoMasterClip, id: string) {
  return {
    id,
    ...(Number.isInteger(clip.sequenceIndex) && Number(clip.sequenceIndex) >= 0 ? { sequenceIndex: clip.sequenceIndex } : {}),
    title: String(clip.title || "Scene").slice(0, 240),
    role: clip.role,
    origin: clip.origin,
    duration: Math.max(0, Math.min(3_600, Number(clip.duration) || 0)),
    ...(clip.generationDuration !== undefined ? { generationDuration: Math.max(0, Math.min(3_600, Number(clip.generationDuration) || 0)) } : {}),
    prompt: String(clip.prompt || "").slice(0, 30_000),
    ...(clip.modelId ? { modelId: clip.modelId.slice(0, 160) } : {}),
    ...(clip.aspectRatio ? { aspectRatio: clip.aspectRatio.slice(0, 20) } : {}),
    ...(clip.aspectRatioMode ? { aspectRatioMode: clip.aspectRatioMode } : {}),
    ...(clip.sourceAspectRatio ? { sourceAspectRatio: clip.sourceAspectRatio } : {}),
    ...(clip.resolution ? { resolution: clip.resolution.slice(0, 20) } : {}),
    ...(clip.generateAudio !== undefined ? { generateAudio: clip.generateAudio } : {}),
  };
}

function sanitizeNodeData(data: FrameNodeData, portableNodeId: string) {
  const result: Record<string, unknown> = {
    kind: data.kind,
    title: String(data.title || "Untitled").slice(0, 240),
  };
  for (const [key, maximum] of [
    ["subtitle", 500], ["hookText", 30_000], ["noteText", 30_000], ["role", 80], ["prompt", 30_000],
    ["assistantInput", 30_000], ["assistantOutput", 30_000], ["systemPrompt", 30_000], ["textModelId", 160],
    ["modelId", 160], ["duration", 20],
  ] as const) {
    const value = copyString(data, key, maximum);
    if (value !== undefined) result[key] = value;
  }
  for (const key of ["noteColor", "mediaType", "aspectRatio", "ratioMode", "resolution"] as const) {
    if (data[key] !== undefined) result[key] = data[key];
  }
  for (const key of ["generateAudio", "generationCount", "nodeWidth", "nodeHeight"] as const) {
    if (data[key] !== undefined) result[key] = data[key];
  }
  const clipIds = new Map<string, string>();
  if (data.videoMasterClips?.length) {
    result.videoMasterClips = data.videoMasterClips.slice(0, 200).map((clip, index) => {
      const id = `${portableNodeId}-clip-${index + 1}`;
      clipIds.set(clip.id, id);
      return sanitizeClip(clip, id);
    });
    const selected = data.videoMasterSelectedClipId ? clipIds.get(data.videoMasterSelectedClipId) : undefined;
    if (selected) result.videoMasterSelectedClipId = selected;
  }
  return result;
}

function sanitizeEdgeData(data: FrameEdge["data"], clipIds: Map<string, string>) {
  if (!data) return undefined;
  const result: Record<string, unknown> = {};
  for (const key of ["portType", "inputRole", "automationKind"] as const) if (data[key] !== undefined) result[key] = data[key];
  for (const key of ["automationSlideIndex", "sourceSegmentStart", "sourceSegmentEnd", "sourceSegmentLabel", "generationClipDuration"] as const) {
    if (data[key] !== undefined) result[key] = data[key];
  }
  if (data.masterClipId && clipIds.has(data.masterClipId)) result.masterClipId = clipIds.get(data.masterClipId);
  return Object.keys(result).length ? result : undefined;
}

function requirementsForGraph(nodes: ScenelithDocumentV1["graph"]["nodes"]) {
  const providers = new Set<string>();
  const capabilities = new Set<string>();
  const models = new Set<string>();
  for (const node of nodes) {
    if (node.data.kind === "assistant" || node.data.textModelId) {
      providers.add("openrouter");
      capabilities.add("assistant");
      if (node.data.textModelId) models.add(`openrouter\u0000${node.data.textModelId}`);
    }
    if (node.data.modelId || node.data.kind === "prompt" || node.data.kind === "generation" || node.data.kind === "videoMaster") {
      providers.add("kie");
      capabilities.add(node.data.mediaType === "video" || node.data.kind === "videoMaster" ? "video-generation" : "image-generation");
      if (node.data.modelId) models.add(`kie\u0000${node.data.modelId}`);
    }
    for (const clip of node.data.videoMasterClips || []) if (clip.modelId) models.add(`kie\u0000${clip.modelId}`);
  }
  return {
    providers: [...providers].sort(),
    capabilities: [...capabilities].sort(),
    models: [...models].sort().map((value) => {
      const [provider, id] = value.split("\u0000");
      return { provider, id };
    }),
  };
}

export function createScenelithDocument(input: {
  title: string;
  description?: string;
  tags?: string[];
  graph: ProjectGraph;
}): ScenelithDocumentV1 {
  const nodeIds = new Map(input.graph.nodes.slice(0, 500).map((node, index) => [node.id, `node-${index + 1}`]));
  const allClipIds = new Map<string, string>();
  const nodes = input.graph.nodes.slice(0, 500).map((node) => {
    const id = nodeIds.get(node.id)!;
    const data = sanitizeNodeData(node.data, id);
    for (const clip of data.videoMasterClips as Array<{ id: string }> || []) {
      const original = node.data.videoMasterClips?.find((candidate, index) => clip.id === `${id}-clip-${index + 1}`);
      if (original) allClipIds.set(original.id, clip.id);
    }
    return {
      id,
      ...(node.type ? { type: String(node.type).slice(0, 80) } : {}),
      position: { x: Number(node.position.x) || 0, y: Number(node.position.y) || 0 },
      data,
    };
  });
  const edges = input.graph.edges
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .slice(0, 1_000)
    .map((edge, index) => ({
      id: `edge-${index + 1}`,
      source: nodeIds.get(edge.source)!,
      target: nodeIds.get(edge.target)!,
      ...(edge.sourceHandle !== undefined ? { sourceHandle: edge.sourceHandle } : {}),
      ...(edge.targetHandle !== undefined ? { targetHandle: edge.targetHandle } : {}),
      ...(edge.type ? { type: String(edge.type).slice(0, 80) } : {}),
      ...(sanitizeEdgeData(edge.data, allClipIds) ? { data: sanitizeEdgeData(edge.data, allClipIds) } : {}),
    }));
  const typedNodes = nodes as ScenelithDocumentV1["graph"]["nodes"];
  const inputs = typedNodes.flatMap((node) => {
    if (!["source", "scene", "persona"].includes(node.data.kind)) return [];
    const kind = node.data.kind === "persona" ? "identity" as const : node.data.mediaType === "video" ? "video" as const : "image" as const;
    return [{ nodeId: node.id, kind, label: node.data.title, required: true }];
  });
  const candidate = {
    format: SCENELITH_DOCUMENT_FORMAT,
    version: CURRENT_SCENELITH_DOCUMENT_VERSION,
    minimumScenelithVersion: MINIMUM_SCENELITH_VERSION,
    metadata: {
      title: input.title.trim().slice(0, 240) || "Untitled canvas",
      ...(input.description?.trim() ? { description: input.description.trim().slice(0, 2_000) } : {}),
      tags: [...new Set((input.tags || []).map((tag) => tag.trim()).filter(Boolean))].slice(0, 20),
    },
    requirements: requirementsForGraph(typedNodes),
    inputs,
    graph: {
      nodes: typedNodes,
      edges,
      ...(input.graph.viewport ? { viewport: input.graph.viewport } : {}),
    },
  };
  assertNoEmbeddedSecret(candidate);
  return scenelithDocumentV1Schema.parse(candidate);
}

export function parseScenelithDocument(value: unknown): ScenelithDocumentV1 {
  if (!value || typeof value !== "object") throw new Error("Invalid Scenelith document");
  const header = value as { format?: unknown; version?: unknown };
  if (header.format !== SCENELITH_DOCUMENT_FORMAT) throw new Error("Unsupported Scenelith document format");
  if (header.version !== CURRENT_SCENELITH_DOCUMENT_VERSION) {
    throw new Error(`Unsupported Scenelith document version: ${String(header.version)}`);
  }
  assertNoEmbeddedSecret(value);
  return scenelithDocumentV1Schema.parse(value);
}

export function projectGraphFromScenelithDocument(document: ScenelithDocumentV1): ProjectGraph {
  const nodeIds = new Map(document.graph.nodes.map((node) => [node.id, crypto.randomUUID()]));
  const clipIds = new Map<string, string>();
  const inputByNodeId = new Map(document.inputs.map((input) => [input.nodeId, input]));
  const nodes = document.graph.nodes.map((node) => {
    const data = structuredClone(node.data) as FrameNodeData;
    if (data.videoMasterClips) {
      data.videoMasterClips = data.videoMasterClips.map((clip) => {
        const id = crypto.randomUUID();
        clipIds.set(clip.id, id);
        return { ...clip, id };
      });
      if (data.videoMasterSelectedClipId) data.videoMasterSelectedClipId = clipIds.get(data.videoMasterSelectedClipId);
    }
    const missingInput = inputByNodeId.get(node.id);
    if (missingInput) data.subtitle = `Input required · ${missingInput.kind}`;
    return { ...node, id: nodeIds.get(node.id)!, data } as FrameNode;
  });
  const edges = document.graph.edges.map((edge) => ({
    ...edge,
    id: crypto.randomUUID(),
    source: nodeIds.get(edge.source)!,
    target: nodeIds.get(edge.target)!,
    ...(edge.data?.masterClipId ? { data: { ...edge.data, masterClipId: clipIds.get(edge.data.masterClipId) } } : {}),
  } as FrameEdge));
  return normalizeProjectGraph({ nodes, edges, ...(document.graph.viewport ? { viewport: document.graph.viewport } : {}) });
}
