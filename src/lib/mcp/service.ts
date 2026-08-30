import {
  createAssetThumbnailFromStorage,
  createIdentityThumbnail,
  createVideoAssetThumbnailFromStorage,
} from "@/lib/image-thumbnails";
import { appendAuditEvent } from "@/lib/audit-log";
import { duplicateGraphSelection, generatorInputCapacity, generatorSourceAssetIds, normalizeProjectGraph } from "@/lib/canvas-graph";
import { writeCollaborativeGraph } from "@/lib/collaboration-store";
import { deleteStorageObject, readStorageObject, safeExtension, saveBytes } from "@/lib/storage";
import { assertWorkspaceStorageCapacity, enqueueStorageDeletion } from "@/lib/storage-lifecycle";
import {
  db,
  listAccessibleProjectRows,
  listAccessibleWorkspaceRows,
  readProjectGraphSnapshot,
  rowToProject,
  rowToProjectListItem,
  rowToHook,
  rowToWorkspace,
  userCanAccessProject,
  userCanAccessAsset,
  userCanAccessGeneration,
  userCanAccessWorkspace,
  workspaceIdForProject,
  workspaceRoleForUser,
  writeProjectGraphSnapshot,
} from "@/lib/postgres-db";
import type { FrameEdge, FrameNode, FrameNodeData, ProjectGraph, VideoMasterClip } from "@/lib/types";
import {
  archiveAutomationWorkflow,
  createAutomationWorkflow,
  exportAutomationWorkflowPackage,
  getAutomationWorkflow,
  importAutomationWorkflowPackage,
  listAutomationWorkflows,
  listAutomationWorkflowVersions,
  publishAutomationWorkflow,
  restoreAutomationWorkflowVersion,
  saveAutomationWorkflowDraft,
  setSystemAutomationModelOverride,
} from "@/lib/automation-workflows/repository";
import {
  cancelAutomationWorkflowRun,
  enqueueAutomationWorkflowRun,
  getAutomationWorkflowRun,
  getAutomationWorkflowNodeRunDetails,
  listAutomationWorkflowRuns,
  retryAutomationWorkflowRun,
} from "@/lib/automation-workflows/runs";
import { DEFAULT_AUTOMATION_WORKFLOW_SETTINGS, type AutomationBinding, type AutomationWorkflowGraph, type AutomationWorkflowSettings } from "@/lib/automation-workflows/types";
import { automationRunInputFields, validateAutomationConnection } from "@/lib/automation-workflows/validation";
import { automationNodeDefinition } from "@/lib/automation-workflows/registry";
import {
  bindAutomationCredential,
  bindAutomationSubworkflow,
  listAutomationCredentials,
  unbindAutomationWorkflowSlot,
} from "@/lib/automation-workflows/credentials";
import {
  createAutomationWorkflowFixture,
  deleteAutomationWorkflowFixture,
  enqueueAutomationNodePreview,
  listAutomationWorkflowFixtures,
} from "@/lib/automation-workflows/fixtures";
import {
  listAutomationTriggerDeliveries,
  replayAutomationTriggerDelivery,
  type AutomationTriggerDeliveryStatus,
} from "@/lib/automation-workflows/deliveries";
import { automationCapabilitiesForWorkspace } from "@/lib/automation-workflows/permissions";
import type { McpPrincipal } from "@/lib/mcp/oauth";
import { createAutomationNodeTemplate } from "@/lib/mcp/automation";
import { getAssistantModel } from "@/lib/assistant-models";
import { generationProvider, importProvider, intelligenceProvider } from "@/platform/providers/registry";
import {
  canvasCapabilityDocument,
  canvasNodeOutputType,
  defaultCanvasNodeData,
  inputRolePortType,
  type McpCanvasNodeType,
} from "@/lib/mcp/canvas-capabilities";
import type { GeneratorInputRole } from "@/lib/types";
import { composeCanvasGenerationPrompt, runCanvasAssistant, type CanvasPromptReference } from "@/lib/canvas-intelligence";
import { referenceMentionToken } from "@/lib/reference-mentions";
import { admitGeneration } from "@/lib/generation-admission";
import { generationClientState, readGenerationState, reconcileGeneration } from "@/lib/generation-state";
import { fireAutomationCanvasEvent } from "@/lib/automation-workflows/triggers";
import {
  createAutomationWorkflowTrigger,
  deleteAutomationWorkflowTrigger,
  listAutomationWorkflowTriggers,
  setAutomationWorkflowTriggerStatus,
  type AutomationOverlapPolicy,
  type AutomationTriggerType,
} from "@/lib/automation-workflows/triggers";
import { assetIdFromAssetUrl, moveUploadedMasterClipToLane, nearestVideoMasterRatio, shouldIncludeAutomaticMasterVideoReference, useVideoMasterGeneratedOutput as applyVideoMasterGeneratedOutput, videoMasterClipExportMedia, videoMasterGenerationDuration, videoMasterSourceRatio } from "@/lib/video-master";
import { validateVideoMasterGenerationReferences } from "@/lib/video-master-validation";
import { captureVideoFrameAsset, materializeVideoSegmentAsset, type VideoDerivativeSource } from "@/lib/video-derivatives";
import { createScenelithDocument, parseScenelithDocument, projectGraphFromScenelithDocument } from "@/lib/scenelith-document";
import { cancelGeneration } from "@/lib/generation-lifecycle";
import { restoreDetectedVideoSegments } from "@/lib/video-scenes";
import { mediaContentMatchesMime } from "@/lib/media-content";
import { probeVideoMetadata } from "@/lib/media-probe";
import { coalesceContiguousVideoAssets } from "@/lib/video-export";
import { renderVideoMasterExport, type VideoMasterRenderSource } from "@/lib/video-master-render";

export type CanvasPatchOperation =
  | { type: "add_node"; id?: string; nodeType?: string; position: { x: number; y: number }; data: FrameNodeData }
  | { type: "update_node"; nodeId: string; position?: { x: number; y: number }; data?: Partial<FrameNodeData> }
  | { type: "remove_node"; nodeId: string }
  | { type: "add_edge"; id?: string; source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null; data?: FrameEdge["data"] }
  | { type: "remove_edge"; edgeId: string }
  | { type: "set_viewport"; viewport: { x: number; y: number; zoom: number } };

function tokenAllowsWorkspace(principal: McpPrincipal, workspaceId: string) {
  return !principal.workspaceId || principal.workspaceId === workspaceId;
}

function tokenAllowsProject(principal: McpPrincipal, projectId: string) {
  return !principal.projectIds || principal.projectIds.includes(projectId);
}

async function projectGrantAllowsWorkspace(principal: McpPrincipal, workspaceId: string) {
  if (!principal.projectIds) return true;
  const workspaceIds = await Promise.all(principal.projectIds.map((projectId) => workspaceIdForProject(projectId)));
  return workspaceIds.includes(workspaceId);
}

async function assertWorkspace(principal: McpPrincipal, workspaceId: string) {
  if (!tokenAllowsWorkspace(principal, workspaceId) || !await projectGrantAllowsWorkspace(principal, workspaceId)
    || !await userCanAccessWorkspace(principal.userId, workspaceId)) {
    throw Object.assign(new Error("Workspace not found"), { status: 404 });
  }
}

async function assertProject(principal: McpPrincipal, projectId: string) {
  const workspaceId = await workspaceIdForProject(projectId);
  if (!workspaceId || !tokenAllowsWorkspace(principal, workspaceId) || !tokenAllowsProject(principal, projectId)
    || !await userCanAccessProject(principal.userId, projectId)) {
    throw Object.assign(new Error("Canvas not found"), { status: 404 });
  }
  return workspaceId;
}

function absoluteAssetUrl(origin: string, path: string) {
  return new URL(path, origin).toString();
}

export async function listMcpWorkspaces(principal: McpPrincipal) {
  const rows = await listAccessibleWorkspaceRows(principal.userId);
  const projectWorkspaceIds = principal.projectIds
    ? new Set((await Promise.all(principal.projectIds.map((projectId) => workspaceIdForProject(projectId)))).filter(Boolean))
    : null;
  return rows.map(rowToWorkspace).filter((workspace) => tokenAllowsWorkspace(principal, workspace.id) && (!projectWorkspaceIds || projectWorkspaceIds.has(workspace.id)));
}

export async function listMcpCanvases(principal: McpPrincipal, workspaceId?: string) {
  if (workspaceId) await assertWorkspace(principal, workspaceId);
  const rows = await listAccessibleProjectRows(principal.userId);
  return rows
    .map(rowToProjectListItem)
    .filter((project) => tokenAllowsWorkspace(principal, project.workspaceId) && tokenAllowsProject(principal, project.id) && (!workspaceId || project.workspaceId === workspaceId));
}

export async function getMcpCanvas(principal: McpPrincipal, projectId: string) {
  await assertProject(principal, projectId);
  const row = await db.prepare("SELECT id, workspace_id, name, source_url, status, created_at, updated_at FROM projects WHERE id = ?")
    .get(projectId) as Record<string, unknown> | undefined;
  if (!row) throw Object.assign(new Error("Canvas not found"), { status: 404 });
  return await rowToProject(row, await readProjectGraphSnapshot(projectId));
}

export async function createMcpCanvas(principal: McpPrincipal, input: { workspaceId: string; name: string }) {
  await assertWorkspace(principal, input.workspaceId);
  if (principal.projectIds) throw Object.assign(new Error("This connection is limited to existing canvases and cannot create another one"), { status: 403 });
  if (await workspaceRoleForUser(principal.userId, input.workspaceId) !== "owner") {
    throw Object.assign(new Error("This workspace role cannot create canvases"), { status: 403 });
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO projects (id, workspace_id, name, status, graph_json, created_at, updated_at)
    VALUES (?, ?, ?, 'draft', ?, ?, ?)`).run(id, input.workspaceId, input.name.trim().slice(0, 120), JSON.stringify({ nodes: [], edges: [] }), now, now);
  await appendAuditEvent({ workspaceId: input.workspaceId, actorUserId: principal.userId, action: "mcp.canvas.created", targetType: "project", targetId: id, metadata: { connectionId: principal.connectionId, clientId: principal.clientId } });
  return await getMcpCanvas(principal, id);
}

export function applyCanvasPatch(graphInput: ProjectGraph, operations: CanvasPatchOperation[]) {
  const graph = structuredClone(graphInput);
  for (const operation of operations) {
    if (operation.type === "add_node") {
      const id = operation.id || crypto.randomUUID();
      if (graph.nodes.some((node) => node.id === id)) throw new Error(`Canvas node ${id} already exists`);
      graph.nodes.push({ id, type: operation.nodeType || "frameNode", position: operation.position, data: operation.data } as FrameNode);
      continue;
    }
    if (operation.type === "update_node") {
      const index = graph.nodes.findIndex((node) => node.id === operation.nodeId);
      if (index < 0) throw new Error(`Canvas node ${operation.nodeId} was not found`);
      graph.nodes[index] = {
        ...graph.nodes[index],
        ...(operation.position ? { position: operation.position } : {}),
        ...(operation.data ? { data: { ...graph.nodes[index].data, ...operation.data } } : {}),
      };
      continue;
    }
    if (operation.type === "remove_node") {
      if (!graph.nodes.some((node) => node.id === operation.nodeId)) throw new Error(`Canvas node ${operation.nodeId} was not found`);
      graph.nodes = graph.nodes.filter((node) => node.id !== operation.nodeId);
      graph.edges = graph.edges.filter((edge) => edge.source !== operation.nodeId && edge.target !== operation.nodeId);
      continue;
    }
    if (operation.type === "add_edge") {
      if (!graph.nodes.some((node) => node.id === operation.source)) throw new Error(`Source node ${operation.source} was not found`);
      if (!graph.nodes.some((node) => node.id === operation.target)) throw new Error(`Target node ${operation.target} was not found`);
      const id = operation.id || crypto.randomUUID();
      if (graph.edges.some((edge) => edge.id === id)) throw new Error(`Canvas edge ${id} already exists`);
      graph.edges.push({
        id,
        source: operation.source,
        target: operation.target,
        sourceHandle: operation.sourceHandle,
        targetHandle: operation.targetHandle,
        data: operation.data,
      } as FrameEdge);
      continue;
    }
    if (operation.type === "remove_edge") {
      if (!graph.edges.some((edge) => edge.id === operation.edgeId)) throw new Error(`Canvas edge ${operation.edgeId} was not found`);
      graph.edges = graph.edges.filter((edge) => edge.id !== operation.edgeId);
      continue;
    }
    graph.viewport = operation.viewport;
  }
  const normalized = normalizeProjectGraph(graph);
  if (normalized.nodes.length > 500 || normalized.edges.length > 1_000 || JSON.stringify(normalized).length > 2_000_000) {
    throw new Error("The resulting canvas exceeds its safe document limits");
  }
  return normalized;
}

export async function patchMcpCanvas(principal: McpPrincipal, input: {
  projectId: string;
  expectedRevision: number;
  operations: CanvasPatchOperation[];
  name?: string;
}) {
  const workspaceId = await assertProject(principal, input.projectId);
  const current = await readProjectGraphSnapshot(input.projectId);
  if (current.revision !== input.expectedRevision) {
    throw Object.assign(new Error(`Canvas changed. Read it again and use revision ${current.revision}.`), { code: "CANVAS_REVISION_CONFLICT", status: 409, currentRevision: current.revision });
  }
  const nextGraph = applyCanvasPatch(current.graph, input.operations);
  const collaborative = Boolean(process.env.COLLABORATION_INTERNAL_SECRET);
  let conflictRevision: number | undefined;
  if (collaborative) {
    const written = await writeCollaborativeGraph(input.projectId, nextGraph, input.expectedRevision);
    if ("conflict" in written) conflictRevision = written.snapshot.revision;
  } else {
    const written = await writeProjectGraphSnapshot(input.projectId, nextGraph, { expectedRevision: input.expectedRevision });
    if (!written.ok) conflictRevision = written.snapshot.revision;
  }
  if (conflictRevision !== undefined) {
    throw Object.assign(new Error(`Canvas changed. Read it again and use revision ${conflictRevision}.`), { code: "CANVAS_REVISION_CONFLICT", status: 409, currentRevision: conflictRevision });
  }
  if (input.name?.trim()) {
    await db.prepare("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?")
      .run(input.name.trim().slice(0, 120), new Date().toISOString(), input.projectId);
  }
  await appendAuditEvent({ workspaceId, actorUserId: principal.userId, action: "mcp.canvas.patched", targetType: "project", targetId: input.projectId, metadata: { connectionId: principal.connectionId, clientId: principal.clientId, baseRevision: input.expectedRevision, operationCount: input.operations.length } });
  return await getMcpCanvas(principal, input.projectId);
}

export async function getMcpCanvasCapabilities(principal: McpPrincipal, projectId: string) {
  const canvas = await getMcpCanvas(principal, projectId);
  return { canvasId: canvas.id, revision: canvas.revision, ...canvasCapabilityDocument() };
}

export async function exportMcpCanvasDocument(principal: McpPrincipal, projectId: string) {
  const canvas = await getMcpCanvas(principal, projectId);
  return { canvasId: canvas.id, revision: canvas.revision, document: createScenelithDocument({ title: canvas.name, graph: canvas.graph }) };
}

export async function importMcpCanvasDocument(principal: McpPrincipal, input: { workspaceId: string; document: unknown }) {
  await assertWorkspace(principal, input.workspaceId);
  if (principal.projectIds) throw Object.assign(new Error("This connection is limited to existing canvases and cannot import another one"), { status: 403 });
  if (await workspaceRoleForUser(principal.userId, input.workspaceId) !== "owner") throw Object.assign(new Error("This workspace role cannot import canvases"), { status: 403 });
  if (Buffer.byteLength(JSON.stringify(input.document), "utf8") > 5 * 1024 * 1024) throw Object.assign(new Error("Scenelith document is larger than 5 MB"), { status: 413 });
  const document = parseScenelithDocument(input.document);
  const graph = projectGraphFromScenelithDocument(document);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO projects (id, workspace_id, name, status, graph_json, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?, ?)")
    .run(id, input.workspaceId, document.metadata.title, JSON.stringify(graph), now, now);
  await appendAuditEvent({ workspaceId: input.workspaceId, actorUserId: principal.userId, action: "mcp.canvas.document_imported", targetType: "project", targetId: id, metadata: { connectionId: principal.connectionId, format: document.format, version: document.version } });
  return { canvas: await getMcpCanvas(principal, id), inputs: document.inputs };
}

export async function createMcpCanvasNode(principal: McpPrincipal, input: {
  projectId: string;
  expectedRevision: number;
  type: McpCanvasNodeType;
  position: { x: number; y: number };
  title?: string;
  modelId?: string;
  textModelId?: string;
  prompt?: string;
  instruction?: string;
  systemPrompt?: string;
  noteText?: string;
  noteColor?: "yellow" | "blue" | "rose" | "gray";
}) {
  const nodeId = crypto.randomUUID();
  const canvas = await patchMcpCanvas(principal, {
    projectId: input.projectId,
    expectedRevision: input.expectedRevision,
    operations: [{
      type: "add_node",
      id: nodeId,
      position: input.position,
      data: defaultCanvasNodeData(input.type, input),
    }],
  });
  return { canvas, node: canvas.graph.nodes.find((node) => node.id === nodeId)! };
}

type McpCanvasNodeConfiguration = {
  title?: string;
  position?: { x: number; y: number };
  prompt?: string;
  modelId?: string;
  aspectRatio?: string;
  resolution?: string;
  duration?: string;
  generateAudio?: boolean;
  generationCount?: number;
  instruction?: string;
  systemPrompt?: string;
  textModelId?: string;
  noteText?: string;
  noteColor?: "yellow" | "blue" | "rose" | "gray";
  nodeWidth?: number;
  nodeHeight?: number;
};

function configuredCanvasNode(graph: ProjectGraph, nodeId: string, configuration: McpCanvasNodeConfiguration) {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw Object.assign(new Error("Canvas node not found"), { status: 404 });
  const data: Partial<FrameNodeData> = {};
  if (configuration.title !== undefined) data.title = configuration.title.trim().slice(0, 240) || node.data.title;
  if (configuration.nodeWidth !== undefined) data.nodeWidth = Math.round(Math.min(1_180, Math.max(180, configuration.nodeWidth)));
  if (configuration.nodeHeight !== undefined) data.nodeHeight = Math.round(Math.min(1_200, Math.max(120, configuration.nodeHeight)));
  if (node.data.kind === "prompt") {
    const provider = generationProvider();
    const requestedModelId = configuration.modelId || node.data.modelId || (node.data.mediaType === "video" ? "seedance-2-fast" : "nano-banana-2");
    const model = provider.getModel(requestedModelId);
    if (model.mediaType !== node.data.mediaType) throw new Error(`Choose a ${node.data.mediaType || "matching"} model for this generator`);
    const references = graph.edges.filter((edge) => edge.target === node.id && edge.data?.portType !== "text");
    const attachedReferences = node.data.attachedReferences || [];
    const hasVideoInput = [...references.map((edge) => edge.data?.inputRole), ...attachedReferences.map((reference) => reference.role)]
      .some((role) => role === "reference-video" || role === "motion-video");
    const referenceCount = references.length + attachedReferences.length;
    const resolutions = provider.allowedResolutions(model, hasVideoInput);
    const requestedResolution = String(configuration.resolution || node.data.resolution || model.defaultResolution || resolutions[0]);
    const resolution = resolutions.includes(requestedResolution) ? requestedResolution : model.defaultResolution || resolutions[0];
    if (!resolution) throw new Error(`${model.label} has no compatible resolution for the current inputs`);
    const ratios = provider.allowedRatios(model, resolution, referenceCount > 0);
    const requestedRatio = String(configuration.aspectRatio || node.data.aspectRatio || model.defaultRatio || ratios[0]);
    const aspectRatio = ratios.includes(requestedRatio) ? requestedRatio : model.defaultRatio || ratios[0];
    if (!aspectRatio) throw new Error(`${model.label} has no compatible aspect ratio for the current inputs`);
    const requestedDuration = String(configuration.duration || node.data.duration || model.defaultDuration || model.durations?.[0] || "5");
    const duration = model.durationSource === "reference-video"
      ? requestedDuration
      : model.durations?.includes(requestedDuration) ? requestedDuration : model.defaultDuration || model.durations?.[0] || requestedDuration;
    data.prompt = configuration.prompt === undefined ? node.data.prompt : configuration.prompt.slice(0, model.maxPromptLength || 5_000);
    data.modelId = model.id;
    data.mediaType = model.mediaType;
    data.aspectRatio = aspectRatio as FrameNodeData["aspectRatio"];
    data.resolution = resolution as FrameNodeData["resolution"];
    data.duration = duration;
    data.generateAudio = model.supportsAudio ? configuration.generateAudio ?? node.data.generateAudio ?? model.defaultGenerateAudio ?? false : false;
    data.generationCount = Math.min(8, Math.max(1, Math.floor(configuration.generationCount ?? node.data.generationCount ?? 1)));
  } else if (node.data.kind === "assistant") {
    const model = getAssistantModel(configuration.textModelId || node.data.textModelId);
    data.assistantInput = configuration.instruction === undefined ? node.data.assistantInput : configuration.instruction.slice(0, 10_000);
    data.systemPrompt = configuration.systemPrompt === undefined ? node.data.systemPrompt : configuration.systemPrompt.slice(0, 10_000);
    data.textModelId = model.id;
  } else if (node.data.kind === "note") {
    data.noteText = configuration.noteText === undefined ? node.data.noteText : configuration.noteText.slice(0, 20_000);
    if (configuration.noteColor !== undefined) data.noteColor = configuration.noteColor;
  } else {
    if (configuration.prompt !== undefined || configuration.modelId !== undefined || configuration.instruction !== undefined || configuration.noteText !== undefined) {
      throw new Error(`The ${node.data.kind} node does not support these settings`);
    }
  }
  return { node, data };
}

export async function configureMcpCanvasNode(principal: McpPrincipal, input: {
  projectId: string;
  expectedRevision: number;
  nodeId: string;
  configuration: McpCanvasNodeConfiguration;
}) {
  const current = await getMcpCanvas(principal, input.projectId);
  if (current.revision !== input.expectedRevision) throw Object.assign(new Error(`Canvas changed. Read it again and use revision ${current.revision}.`), { code: "CANVAS_REVISION_CONFLICT", status: 409, currentRevision: current.revision });
  const { data } = configuredCanvasNode(current.graph, input.nodeId, input.configuration);
  return await patchMcpCanvas(principal, {
    projectId: input.projectId,
    expectedRevision: input.expectedRevision,
    operations: [{ type: "update_node", nodeId: input.nodeId, position: input.configuration.position, data }],
  });
}

export async function connectMcpCanvasNodes(principal: McpPrincipal, input: {
  projectId: string;
  expectedRevision: number;
  sourceNodeId: string;
  targetNodeId: string;
  targetClipId?: string;
  inputRole?: GeneratorInputRole;
  sourceSegmentId?: string;
}) {
  const current = await getMcpCanvas(principal, input.projectId);
  if (current.revision !== input.expectedRevision) throw Object.assign(new Error(`Canvas changed. Read it again and use revision ${current.revision}.`), { code: "CANVAS_REVISION_CONFLICT", status: 409, currentRevision: current.revision });
  const source = current.graph.nodes.find((node) => node.id === input.sourceNodeId);
  const target = current.graph.nodes.find((node) => node.id === input.targetNodeId);
  if (!source || !target) throw Object.assign(new Error("Source or target canvas node not found"), { status: 404 });
  if (source.id === target.id) throw new Error("A canvas node cannot connect to itself");
  const segment = input.sourceSegmentId ? source.data.videoSegments?.find((candidate) => candidate.id === input.sourceSegmentId) : undefined;
  if (input.sourceSegmentId && !segment) throw new Error("The selected video segment was not found on the source node");
  const sourceHandle = segment ? `segment-output:${segment.id}` : source.data.kind === "assistant" ? "text-output" : source.data.mediaType === "video" ? "video-output" : "output";
  const portType = canvasNodeOutputType(source.data, sourceHandle);
  const operations: CanvasPatchOperation[] = [];
  const targetClip = input.targetClipId && target.data.kind === "videoMaster"
    ? target.data.videoMasterClips?.find((clip) => clip.id === input.targetClipId)
    : undefined;
  if (input.targetClipId && !targetClip) throw Object.assign(new Error("Video Master target scene not found"), { status: 404 });
  let targetHandle = "input";
  let role = input.inputRole;
  let capacity = 1;
  if (portType === "text") {
    if (targetClip) throw new Error("Video Master scenes accept media references; configure the scene prompt directly");
    if (target.data.kind !== "prompt" && target.data.kind !== "assistant") throw new Error("Text output can connect only to a generator or Assistant text input");
    targetHandle = "text-input";
  } else {
    if (target.data.kind !== "prompt" && target.data.kind !== "assistant" && !targetClip) throw new Error("Media references can connect only to a generator, Assistant, or Video Master scene");
    role = role || (portType === "video" ? "reference-video" : portType === "audio" ? "reference-audio" : "reference-image");
    if (inputRolePortType(role) !== portType) throw new Error(`${portType} output cannot connect to ${role}`);
    targetHandle = targetClip ? `master:${targetClip.id}:${role}-input` : `${role}-input`;
    if (targetClip) {
      const model = generationProvider().getModel(String(targetClip.modelId || target.data.modelId || ""));
      const availablePort = model.inputPorts?.find((port) => port.id === role);
      if (!availablePort) throw new Error(`${model.label} does not expose a ${role} input`);
      capacity = generatorInputCapacity(model, role);
    } else if (target.data.kind === "assistant") {
      if (!getAssistantModel(target.data.textModelId).supportsVision) throw new Error("The selected Assistant model does not accept visual references");
      if (portType !== "image") throw new Error("Assistant nodes currently accept image references and text input");
      capacity = 14;
    } else {
      const model = generationProvider().getModel(String(target.data.modelId || ""));
      const availablePort = model.inputPorts?.find((port) => port.id === role);
      if (model.mediaType === "image" && role === "reference-image") capacity = model.maxReferences;
      else if (!availablePort) throw new Error(`${model.label} does not expose a ${role} input`);
      else capacity = generatorInputCapacity(model, role);
    }
  }
  const existing = current.graph.edges.filter((edge) => edge.target === target.id && edge.targetHandle === targetHandle && (!targetClip || edge.data?.masterClipId === targetClip.id));
  const attachedCount = targetClip ? (targetClip.attachedReferences || []).filter((reference) => canonicalReferenceRole(reference.role, reference.role) === role).length : 0;
  if (!existing.some((edge) => edge.source === source.id && edge.sourceHandle === sourceHandle) && existing.length + attachedCount >= capacity) {
    if (capacity <= 1) operations.push(...existing.map((edge) => ({ type: "remove_edge" as const, edgeId: edge.id })));
    else throw new Error(`The ${role || "text"} input accepts at most ${capacity} connections`);
  }
  const duplicate = current.graph.edges.find((edge) => edge.source === source.id && edge.sourceHandle === sourceHandle && edge.target === target.id && edge.targetHandle === targetHandle);
  if (!duplicate) operations.push({
    type: "add_edge",
    source: source.id,
    sourceHandle,
    target: target.id,
    targetHandle,
    data: {
      portType,
      ...(role ? { inputRole: role } : {}),
      ...(targetClip ? { masterClipId: targetClip.id } : {}),
      ...(segment ? {
        sourceSegmentId: segment.id,
        sourceSegmentStart: segment.start,
        sourceSegmentEnd: segment.end,
        sourceSegmentLabel: segment.label,
        sourceSegmentThumbnailUrl: segment.thumbnailUrl,
        clipAssetId: segment.clipAssetId,
        clipUrl: segment.clipUrl,
      } : {}),
    },
  });
  if (!operations.length) return current;
  return await patchMcpCanvas(principal, { projectId: input.projectId, expectedRevision: input.expectedRevision, operations });
}

export async function placeMcpCanvasAsset(principal: McpPrincipal, input: {
  projectId: string;
  expectedRevision: number;
  assetId: string;
  position: { x: number; y: number };
  title?: string;
}) {
  if (!principal.libraryAccess) throw Object.assign(new Error("Library access was not approved for this connection"), { status: 403 });
  const workspaceId = await assertProject(principal, input.projectId);
  const asset = await db.prepare(`SELECT id, workspace_id, project_id, filename, mime_type, metadata_json, created_at FROM assets WHERE id = ?`).get(input.assetId) as
    { id: string; workspace_id: string; project_id: string | null; filename: string; mime_type: string; metadata_json: unknown; created_at: string } | undefined;
  if (!asset || asset.workspace_id !== workspaceId || !asset.project_id || !tokenAllowsProject(principal, asset.project_id) || !await userCanAccessAsset(principal.userId, asset.id)
    || (!asset.mime_type.startsWith("image/") && !asset.mime_type.startsWith("video/"))) {
    throw Object.assign(new Error("Library asset not found"), { status: 404 });
  }
  let metadata: Record<string, unknown> = {};
  try { metadata = typeof asset.metadata_json === "string" ? JSON.parse(asset.metadata_json) : asset.metadata_json as Record<string, unknown>; } catch {}
  const mediaType = asset.mime_type.startsWith("video/") ? "video" as const : "image" as const;
  const nodeId = crypto.randomUUID();
  const canvas = await patchMcpCanvas(principal, {
    projectId: input.projectId,
    expectedRevision: input.expectedRevision,
    operations: [{ type: "add_node", id: nodeId, position: input.position, data: {
      kind: "scene",
      title: input.title?.trim() || (mediaType === "video" ? "Library video" : "Library image"),
      subtitle: "Added from Library",
      role: mediaType === "video" ? "video" : "scene",
      assetId: asset.id,
      imageUrl: `/api/assets/${asset.id}`,
      mediaType,
      modelId: typeof metadata.modelId === "string" ? metadata.modelId : undefined,
      duration: metadata.durationSeconds ? String(metadata.durationSeconds) : undefined,
      videoDurationSeconds: Number(metadata.durationSeconds || metadata.duration || 0) || undefined,
      videoAspectRatio: Number(metadata.aspectRatio || 0) || undefined,
      generatedAt: asset.created_at,
      status: "ready",
      createdAt: new Date().toISOString(),
    } }],
  });
  return { canvas, node: canvas.graph.nodes.find((node) => node.id === nodeId)! };
}

export async function placeMcpCanvasIdentity(principal: McpPrincipal, input: {
  projectId: string;
  expectedRevision: number;
  identityId: string;
  variant: "reference" | "before" | "after";
  assetIds?: string[];
  position: { x: number; y: number };
}) {
  const workspaceId = await assertProject(principal, input.projectId);
  const persona = await db.prepare("SELECT id, name FROM personas WHERE id = ? AND workspace_id = ?").get(input.identityId, workspaceId) as { id: string; name: string } | undefined;
  if (!persona) throw Object.assign(new Error("Identity not found"), { status: 404 });
  const assets = await db.prepare(`SELECT id FROM assets WHERE persona_id = ? AND role = ? ORDER BY sort_order, created_at, id`).all(persona.id, input.variant) as Array<{ id: string }>;
  const requested = input.assetIds?.length ? [...new Set(input.assetIds)] : assets.map((asset) => asset.id);
  if (!requested.length || requested.some((assetId) => !assets.some((asset) => asset.id === assetId))) throw new Error("Choose at least one accessible identity reference from the selected variant");
  const variantLabel = input.variant === "reference" ? "Character" : input.variant === "before" ? "Before" : "After";
  const nodeId = crypto.randomUUID();
  const canvas = await patchMcpCanvas(principal, {
    projectId: input.projectId,
    expectedRevision: input.expectedRevision,
    operations: [{ type: "add_node", id: nodeId, position: input.position, data: {
      kind: "persona",
      title: `${persona.name} · ${variantLabel}`,
      subtitle: `${requested.length} selected reference${requested.length === 1 ? "" : "s"}`,
      personaId: persona.id,
      personaVariant: input.variant,
      referenceAssetIds: requested,
      imageUrl: `/api/assets/${requested[0]}`,
      status: "ready",
      createdAt: new Date().toISOString(),
    } }],
  });
  return { canvas, node: canvas.graph.nodes.find((node) => node.id === nodeId)! };
}

export async function duplicateMcpCanvasNodes(principal: McpPrincipal, input: {
  projectId: string;
  expectedRevision: number;
  nodeIds: string[];
  offset?: { x: number; y: number };
}) {
  const current = await getMcpCanvas(principal, input.projectId);
  if (current.revision !== input.expectedRevision) throw Object.assign(new Error(`Canvas changed. Read it again and use revision ${current.revision}.`), { code: "CANVAS_REVISION_CONFLICT", status: 409, currentRevision: current.revision });
  const duplicated = duplicateGraphSelection(current.graph.nodes, current.graph.edges, input.nodeIds, () => crypto.randomUUID(), input.offset || { x: 48, y: 48 });
  if (!duplicated.nodes.length) throw new Error("Choose at least one existing canvas node to duplicate");
  const operations: CanvasPatchOperation[] = [
    ...duplicated.nodes.map((node) => ({ type: "add_node" as const, id: node.id, nodeType: node.type, position: node.position, data: node.data })),
    ...duplicated.edges.map((edge) => ({ type: "add_edge" as const, id: edge.id, source: edge.source, sourceHandle: edge.sourceHandle, target: edge.target, targetHandle: edge.targetHandle, data: edge.data })),
  ];
  const canvas = await patchMcpCanvas(principal, { projectId: input.projectId, expectedRevision: input.expectedRevision, operations });
  return { canvas, duplicatedNodeIds: duplicated.nodes.map((node) => node.id), duplicatedEdgeIds: duplicated.edges.map((edge) => edge.id) };
}

type McpCanvasInputReference = CanvasPromptReference & {
  sourceNodeId?: string;
  sourceSegmentId?: string;
};

function canonicalReferenceRole(value: unknown, mediaType: unknown): GeneratorInputRole {
  const raw = String(value || "");
  const normalized = raw === "image" || raw === "input" ? "reference-image" : raw;
  if (["reference-image", "start-frame", "end-frame", "motion-video", "reference-video", "reference-audio"].includes(normalized)) {
    return normalized as GeneratorInputRole;
  }
  return mediaType === "video" ? "reference-video" : mediaType === "audio" ? "reference-audio" : "reference-image";
}

function canvasNodeInputFingerprint(graph: ProjectGraph, nodeId: string) {
  const target = graph.nodes.find((node) => node.id === nodeId);
  const incoming = graph.edges.filter((edge) => edge.target === nodeId);
  const sourceIds = new Set(incoming.map((edge) => edge.source));
  return JSON.stringify({
    target,
    incoming,
    sources: graph.nodes.filter((node) => sourceIds.has(node.id)),
  });
}

function inspectCanvasNodeInputsFromGraph(graph: ProjectGraph, nodeId: string) {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw Object.assign(new Error("Canvas node not found"), { status: 404 });
  const textEdge = graph.edges.find((edge) => edge.target === nodeId && (edge.targetHandle === "text-input" || edge.data?.portType === "text"));
  const textSource = textEdge ? graph.nodes.find((candidate) => candidate.id === textEdge.source) : undefined;
  const connectedText = String(textSource?.data.assistantOutput || "").trim();
  const connected: Omit<McpCanvasInputReference, "token">[] = graph.edges
    .filter((edge) => edge.target === nodeId && edge.data?.portType !== "text" && edge.targetHandle !== "text-input" && edge.targetHandle !== "video-master-input")
    .flatMap((edge) => {
      const source = graph.nodes.find((candidate) => candidate.id === edge.source);
      if (!source) return [];
      const segment = edge.data?.sourceSegmentId
        ? source.data.videoSegments?.find((candidate) => candidate.id === edge.data?.sourceSegmentId)
        : undefined;
      const segmentAssetId = segment?.clipAssetId || edge.data?.clipAssetId;
      const assetIds = segmentAssetId ? [segmentAssetId] : generatorSourceAssetIds(source);
      const role = canonicalReferenceRole(edge.data?.inputRole || edge.targetHandle?.replace(/-input$/, ""), edge.data?.portType || source.data.mediaType);
      return assetIds.map((assetId) => ({
        assetId,
        title: segment?.label || edge.data?.sourceSegmentLabel || source.data.title || "Canvas reference",
        role,
        purpose: source.data.kind === "persona" ? "identity" as const : "canvas" as const,
        durationSeconds: segment
          ? Math.max(.1, segment.end - segment.start)
          : source.data.mediaType === "video" ? Number(source.data.videoDurationSeconds || source.data.duration || 0) || undefined : undefined,
        sourceNodeId: source.id,
        ...(segment || edge.data?.sourceSegmentId ? { sourceSegmentId: segment?.id || edge.data?.sourceSegmentId } : {}),
      }));
    });
  const attached: Omit<McpCanvasInputReference, "token">[] = (node.data.attachedReferences || []).map((reference) => ({
    assetId: reference.assetId,
    title: reference.title || "Attached reference",
    role: canonicalReferenceRole(reference.role, reference.role?.includes("video") ? "video" : reference.role?.includes("audio") ? "audio" : "image"),
    purpose: reference.personaId ? "identity" : "upload",
    durationSeconds: reference.durationSeconds,
  }));
  const unique = [...connected, ...attached].filter((reference, index, references) => references.findIndex((candidate) => candidate.assetId === reference.assetId && candidate.role === reference.role) === index);
  const references: McpCanvasInputReference[] = unique.map((reference, index) => ({ ...reference, token: referenceMentionToken(reference.title, index) }));
  const unresolvedReferences = graph.edges
    .filter((edge) => edge.target === nodeId && edge.data?.portType !== "text" && edge.data?.sourceSegmentId && !references.some((reference) => reference.sourceSegmentId === edge.data?.sourceSegmentId))
    .map((edge) => ({ edgeId: edge.id, sourceNodeId: edge.source, sourceSegmentId: edge.data?.sourceSegmentId, reason: "The video segment must be materialized before an agent can use it" }));
  return {
    node,
    connectedText: connectedText ? { sourceNodeId: textSource?.id, title: textSource?.data.title || "Assistant", text: connectedText } : null,
    references,
    unresolvedReferences,
  };
}

function inspectVideoMasterClipInputsFromGraph(graph: ProjectGraph, nodeId: string, clipId: string) {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId && candidate.data.kind === "videoMaster");
  const clip = node?.data.videoMasterClips?.find((candidate) => candidate.id === clipId);
  if (!node || !clip) throw Object.assign(new Error("Video Master scene not found"), { status: 404 });
  const edges = graph.edges.filter((edge) => edge.target === node.id && (edge.data?.masterClipId === clip.id || String(edge.targetHandle || "").startsWith(`master:${clip.id}:`)) && edge.data?.portType !== "text");
  const connected: Omit<McpCanvasInputReference, "token">[] = edges.flatMap((edge) => {
    const source = graph.nodes.find((candidate) => candidate.id === edge.source);
    if (!source) return [];
    const segment = edge.data?.sourceSegmentId ? source.data.videoSegments?.find((candidate) => candidate.id === edge.data?.sourceSegmentId) : undefined;
    const assetIds = segment?.clipAssetId || edge.data?.clipAssetId ? [String(segment?.clipAssetId || edge.data?.clipAssetId)] : generatorSourceAssetIds(source);
    return assetIds.map((assetId) => ({
      assetId, title: segment?.label || edge.data?.sourceSegmentLabel || source.data.title, role: canonicalReferenceRole(edge.data?.inputRole, edge.data?.portType || source.data.mediaType), purpose: "canvas" as const,
      durationSeconds: segment ? Math.max(.1, segment.end - segment.start) : Number(source.data.videoDurationSeconds || source.data.duration || 0) || undefined,
      sourceNodeId: source.id, sourceSegmentId: segment?.id || edge.data?.sourceSegmentId,
    }));
  });
  const attached: Omit<McpCanvasInputReference, "token">[] = (clip.attachedReferences || []).map((reference) => ({
    assetId: reference.assetId, title: reference.title, role: canonicalReferenceRole(reference.role, reference.role), purpose: reference.personaId ? "identity" : "upload", durationSeconds: reference.durationSeconds,
  }));
  const explicitRoles = [...connected, ...attached].map((reference) => reference.role);
  const sourceAssetId = clip.sourceClipAssetId || (!clip.sourceSegmentId ? clip.sourceAssetId || assetIdFromAssetUrl(clip.sourceUrl) : undefined);
  const implicit = sourceAssetId && shouldIncludeAutomaticMasterVideoReference(clip.modelId, explicitRoles)
    ? [{ assetId: sourceAssetId, title: clip.title, role: "reference-video" as const, purpose: "canvas" as const, durationSeconds: Math.max(.1, clip.duration), sourceNodeId: clip.sourceNodeId, sourceSegmentId: clip.sourceSegmentId }]
    : [];
  const unique = [...implicit, ...connected, ...attached].filter((reference, index, references) => references.findIndex((candidate) => candidate.assetId === reference.assetId && candidate.role === reference.role) === index);
  const references: McpCanvasInputReference[] = unique.map((reference, index) => ({ ...reference, token: referenceMentionToken(reference.title, index) }));
  const unresolvedReferences = clip.sourceSegmentId && !sourceAssetId ? [{ sourceNodeId: clip.sourceNodeId, sourceSegmentId: clip.sourceSegmentId, reason: "The Video Master source scene must be materialized before generation" }] : [];
  return { node, clip, connectedText: null, references, unresolvedReferences, targetSourceAssetId: sourceAssetId };
}

export async function inspectMcpCanvasNodeInputs(principal: McpPrincipal, input: { projectId: string; nodeId: string }) {
  const canvas = await getMcpCanvas(principal, input.projectId);
  return { canvasId: canvas.id, revision: canvas.revision, ...inspectCanvasNodeInputsFromGraph(canvas.graph, input.nodeId) };
}

async function persistCanvasIntelligenceResult(principal: McpPrincipal, input: {
  projectId: string;
  nodeId: string;
  fingerprint: string;
  data: Partial<FrameNodeData>;
}) {
  const current = await getMcpCanvas(principal, input.projectId);
  if (canvasNodeInputFingerprint(current.graph, input.nodeId) !== input.fingerprint) {
    return { persisted: false as const, currentRevision: current.revision, reason: "Canvas inputs changed while the model was running" };
  }
  try {
    const canvas = await patchMcpCanvas(principal, {
      projectId: input.projectId,
      expectedRevision: current.revision,
      operations: [{ type: "update_node", nodeId: input.nodeId, data: input.data }],
    });
    return { persisted: true as const, currentRevision: canvas.revision, canvas };
  } catch (error) {
    if ((error as { code?: unknown }).code === "CANVAS_REVISION_CONFLICT") {
      return { persisted: false as const, currentRevision: (error as { currentRevision?: number }).currentRevision, reason: "Canvas changed while the result was being saved" };
    }
    throw error;
  }
}

export async function runMcpCanvasAssistant(principal: McpPrincipal, input: {
  projectId: string;
  expectedRevision: number;
  nodeId: string;
}) {
  const canvas = await getMcpCanvas(principal, input.projectId);
  if (canvas.revision !== input.expectedRevision) throw Object.assign(new Error(`Canvas changed. Read it again and use revision ${canvas.revision}.`), { code: "CANVAS_REVISION_CONFLICT", status: 409, currentRevision: canvas.revision });
  const inspected = inspectCanvasNodeInputsFromGraph(canvas.graph, input.nodeId);
  if (inspected.node.data.kind !== "assistant") throw new Error("run_canvas_assistant requires an Assistant node");
  if (inspected.unresolvedReferences.length) throw Object.assign(new Error(inspected.unresolvedReferences[0].reason), { status: 409 });
  const instruction = String(inspected.node.data.assistantInput || "").trim();
  if (!instruction) throw new Error("Add an instruction to the Assistant node before running it");
  const fingerprint = canvasNodeInputFingerprint(canvas.graph, input.nodeId);
  const result = await runCanvasAssistant({
    userId: principal.userId,
    projectId: input.projectId,
    instruction,
    connectedText: inspected.connectedText?.text || "",
    systemPrompt: String(inspected.node.data.systemPrompt || ""),
    imageAssetIds: inspected.references.map((reference) => reference.assetId),
    assistantModelId: String(inspected.node.data.textModelId || ""),
  });
  const persistence = await persistCanvasIntelligenceResult(principal, {
    projectId: input.projectId,
    nodeId: input.nodeId,
    fingerprint,
    data: { assistantOutput: result.output, status: "ready", generationError: undefined },
  });
  return { ...result, ...persistence };
}

export async function composeMcpCanvasPrompt(principal: McpPrincipal, input: {
  projectId: string;
  expectedRevision: number;
  nodeId: string;
  brief: string;
}) {
  const canvas = await getMcpCanvas(principal, input.projectId);
  if (canvas.revision !== input.expectedRevision) throw Object.assign(new Error(`Canvas changed. Read it again and use revision ${canvas.revision}.`), { code: "CANVAS_REVISION_CONFLICT", status: 409, currentRevision: canvas.revision });
  const inspected = inspectCanvasNodeInputsFromGraph(canvas.graph, input.nodeId);
  if (inspected.node.data.kind !== "prompt") throw new Error("compose_canvas_prompt requires an Image or Video Generator node");
  if (inspected.unresolvedReferences.length) throw Object.assign(new Error(inspected.unresolvedReferences[0].reason), { status: 409 });
  const model = generationProvider().getModel(String(inspected.node.data.modelId || ""));
  const fingerprint = canvasNodeInputFingerprint(canvas.graph, input.nodeId);
  const result = await composeCanvasGenerationPrompt({
    userId: principal.userId,
    projectId: input.projectId,
    brief: input.brief,
    assistantModelId: String(inspected.node.data.textModelId || ""),
    references: inspected.references,
    mediaType: model.mediaType,
    modelId: model.id,
    modelLabel: model.label,
    duration: model.durationSource === "reference-video" ? undefined : inspected.node.data.duration,
    generateAudio: inspected.node.data.generateAudio ?? model.defaultGenerateAudio ?? false,
    aspectRatio: inspected.node.data.aspectRatio,
    resolution: inspected.node.data.resolution,
  });
  const persistence = await persistCanvasIntelligenceResult(principal, {
    projectId: input.projectId,
    nodeId: input.nodeId,
    fingerprint,
    data: { prompt: result.prompt, status: "ready", generationError: undefined },
  });
  return { ...result, ...persistence };
}

export async function runMcpCanvasGeneration(principal: McpPrincipal, input: {
  projectId: string;
  expectedRevision: number;
  nodeId: string;
  generationCount?: number;
  clipId?: string;
}) {
  const canvas = await getMcpCanvas(principal, input.projectId);
  if (canvas.revision !== input.expectedRevision) throw Object.assign(new Error(`Canvas changed. Read it again and use revision ${canvas.revision}.`), { code: "CANVAS_REVISION_CONFLICT", status: 409, currentRevision: canvas.revision });
  const inspected = input.clipId
    ? inspectVideoMasterClipInputsFromGraph(canvas.graph, input.nodeId, input.clipId)
    : inspectCanvasNodeInputsFromGraph(canvas.graph, input.nodeId);
  const masterClip = "clip" in inspected ? inspected.clip : undefined;
  if (inspected.node.data.kind !== "prompt" && !masterClip) throw new Error("run_canvas_generation requires an Image/Video Generator node or a Video Master clip_id");
  const generationCount = Math.min(8, Math.max(1, Math.floor(input.generationCount ?? Number(inspected.node.data.generationCount || 1))));
  if (masterClip && generationCount > 1) throw new Error("Video Master scenes run one generation at a time");
  if (generationCount > 1) {
    const source = inspected.node;
    const measuredWidth = Number(source.data.nodeWidth || 430);
    const [ratioWidth, ratioHeight] = String(source.data.aspectRatio || "4:5").split(":").map(Number);
    const ratio = Number.isFinite(ratioWidth / ratioHeight) ? ratioWidth / ratioHeight : 16 / 9;
    const measuredHeight = measuredWidth / Math.max(.2, ratio) + 36;
    const nodeIds = [source.id, ...Array.from({ length: generationCount - 1 }, () => crypto.randomUUID())];
    const incoming = canvas.graph.edges.filter((edge) => edge.target === source.id);
    const operations: CanvasPatchOperation[] = [{ type: "update_node", nodeId: source.id, data: { generationCount: 1, status: "queued", queueReason: "plan", generationError: undefined } }];
    nodeIds.slice(1).forEach((nodeId, index) => {
      operations.push({
        type: "add_node", id: nodeId, nodeType: source.type, position: {
          x: source.position.x + (measuredWidth + 64) * ((index + 1) % 4),
          y: source.position.y + (measuredHeight + 80) * Math.floor((index + 1) / 4),
        },
        data: { ...structuredClone(source.data), generationCount: 1, outputUrl: undefined, assetId: undefined, generatedOutputs: [], activeGeneratedOutputIndex: undefined, status: "queued", queueReason: "plan", generationError: undefined },
      });
      for (const edge of incoming) operations.push({ type: "add_edge", id: crypto.randomUUID(), source: edge.source, sourceHandle: edge.sourceHandle, target: nodeId, targetHandle: edge.targetHandle, data: edge.data });
    });
    const prepared = await patchMcpCanvas(principal, { projectId: input.projectId, expectedRevision: input.expectedRevision, operations });
    let revision = prepared.revision;
    const started: Array<{ nodeId: string; generationId: string }> = [];
    let deferredNodeIds: string[] = [];
    for (const [index, nodeId] of nodeIds.entries()) {
      try {
        const result = await runMcpCanvasGeneration(principal, { projectId: input.projectId, expectedRevision: revision, nodeId, generationCount: 1 });
        if (!("generationId" in result)) throw new Error("Generation batch could not start its prepared node");
        started.push({ nodeId, generationId: result.generationId });
        revision = result.currentRevision || revision;
      } catch (error) {
        if ((error as { code?: unknown }).code === "GENERATION_CONCURRENCY_LIMIT") {
          deferredNodeIds = nodeIds.slice(index);
          break;
        }
        throw error;
      }
    }
    return { batch: true as const, requested: generationCount, started, deferredNodeIds, currentRevision: revision, canvas: await getMcpCanvas(principal, input.projectId) };
  }
  if (inspected.unresolvedReferences.length) throw Object.assign(new Error(inspected.unresolvedReferences[0].reason), { status: 409 });
  const provider = generationProvider();
  const model = provider.getModel(String(masterClip?.modelId || inspected.node.data.modelId || ""));
  const connectedPrompt = inspected.connectedText?.text.trim() || "";
  const localPrompt = String(masterClip?.prompt || inspected.node.data.prompt || "").trim();
  const prompt = connectedPrompt && localPrompt && connectedPrompt !== localPrompt
    ? `${connectedPrompt}\n\nAdditional user instructions:\n${localPrompt}`
    : connectedPrompt || localPrompt;
  if (prompt.length < 2) throw new Error("Add a prompt or connect an Assistant output before generating");
  if (prompt.length > (model.maxPromptLength || 5_000)) throw new Error(`${model.label} accepts prompts up to ${(model.maxPromptLength || 5_000).toLocaleString("en-US")} characters`);
  const references = await Promise.all(inspected.references.map(async (reference, index) => {
    if (!await userCanAccessAsset(principal.userId, reference.assetId)) throw Object.assign(new Error(`${reference.token} is no longer available`), { status: 404 });
    const asset = await db.prepare("SELECT storage_path, mime_type, kind, role, metadata_json FROM assets WHERE id = ?").get(reference.assetId) as
      { storage_path: string; mime_type: string; kind: string; role: string | null; metadata_json: string | null } | undefined;
    if (!asset) throw Object.assign(new Error(`${reference.token} is no longer available`), { status: 404 });
    const requestedRole = canonicalReferenceRole(reference.role, asset.mime_type.split("/")[0]);
    const role = model.id === "kling-3-motion"
      ? requestedRole === "reference-image" ? "start-frame" : requestedRole === "motion-video" ? "reference-video" : requestedRole
      : requestedRole;
    const expectedMime = role === "motion-video" || role === "reference-video" ? "video/" : role === "reference-audio" ? "audio/" : "image/";
    if (!asset.mime_type.startsWith(expectedMime)) throw new Error(`${role} requires a ${expectedMime.slice(0, -1)} asset`);
    let durationSeconds = Number(reference.durationSeconds || 0) || 0;
    try {
      const metadata = JSON.parse(asset.metadata_json || "{}") as { duration?: number | string; durationSeconds?: number | string };
      durationSeconds ||= Number(metadata.durationSeconds || metadata.duration || 0) || 0;
    } catch {}
    return { path: asset.storage_path, mimeType: asset.mime_type, role, durationSeconds, label: reference.token || reference.title || `Reference ${index + 1}` };
  }));
  if (references.length > model.maxReferences) throw new Error(`${model.label} accepts at most ${model.maxReferences} reference inputs`);
  const allowedRoles = new Set((model.inputPorts || []).map((port) => port.id));
  const normalizedReferences = references.map((reference, index) => ({
    ...reference,
    role: allowedRoles.has(reference.role) ? reference.role : model.inputPorts?.[Math.min(index, Math.max(0, model.inputPorts.length - 1))]?.id || reference.role,
  }));
  const missingRequired = (model.inputPorts || []).filter((port) => port.required && !normalizedReferences.some((reference) => reference.role === port.id));
  if (missingRequired.length) throw new Error(`Connect ${missingRequired.map((port) => port.label).join(" and ")} before generating`);
  for (const port of model.inputPorts || []) {
    const count = normalizedReferences.filter((reference) => reference.role === port.id).length;
    if (port.max && count > port.max) throw new Error(`${port.label} accepts at most ${port.max} input${port.max === 1 ? "" : "s"}`);
  }
  const hasVideoInput = normalizedReferences.some((reference) => reference.role === "reference-video" || reference.role === "motion-video");
  const requestedResolution = String(masterClip?.resolution || inspected.node.data.resolution || model.defaultResolution || "1K");
  if (!hasVideoInput && model.videoInputOnlyResolutions?.includes(requestedResolution)) throw new Error(`${model.label} ${requestedResolution} requires a reference video`);
  const allowedResolutions = provider.allowedResolutions(model, hasVideoInput);
  const resolution = allowedResolutions.includes(requestedResolution) ? requestedResolution : allowedResolutions.includes(model.defaultResolution || "") ? model.defaultResolution! : allowedResolutions[0];
  if (!resolution) throw new Error(`${model.label} has no compatible resolution for these inputs`);
  const allowedRatios = provider.allowedRatios(model, resolution, normalizedReferences.length > 0);
  const requestedRatio = String(masterClip?.aspectRatio || inspected.node.data.aspectRatio || model.defaultRatio || "4:5");
  const aspectRatio = allowedRatios.includes(requestedRatio) ? requestedRatio : allowedRatios.includes(model.defaultRatio || "") ? model.defaultRatio! : allowedRatios[0];
  if (!aspectRatio) throw new Error(`${model.label} has no compatible aspect ratio for these inputs`);
  const requestedDuration = String(masterClip?.generationDuration || inspected.node.data.duration || "");
  const selectedDuration = model.durations?.includes(requestedDuration)
    ? requestedDuration
    : model.defaultDuration || model.durations?.[0] || requestedDuration || "5";
  if (model.id.startsWith("seedance-2")) {
    const hasFrames = normalizedReferences.some((reference) => reference.role === "start-frame" || reference.role === "end-frame");
    const hasMultimodal = normalizedReferences.some((reference) => ["reference-image", "reference-video", "reference-audio"].includes(reference.role));
    if (hasFrames && hasMultimodal) throw new Error("Seedance uses either start/end frames or multimodal references, not both");
    const limits = model.referenceMediaDuration || { minSeconds: 2, maxSeconds: 15, maxTotalSeconds: 15 };
    for (const role of ["reference-video", "reference-audio"] as const) {
      const timed = normalizedReferences.filter((reference) => reference.role === role && reference.durationSeconds > 0);
      if (timed.some((reference) => reference.durationSeconds < limits.minSeconds || reference.durationSeconds > limits.maxSeconds)) throw new Error(`Each Seedance ${role === "reference-video" ? "reference video" : "audio input"} must be ${limits.minSeconds}–${limits.maxSeconds} seconds`);
      if (timed.reduce((total, reference) => total + reference.durationSeconds, 0) > limits.maxTotalSeconds) throw new Error(`Seedance ${role === "reference-video" ? "reference videos" : "audio inputs"} may total at most ${limits.maxTotalSeconds} seconds`);
    }
  }
  if (model.id === "grok-video-image" && resolution === "1080P" && normalizedReferences.length > 1) throw new Error(`${model.label} accepts only one image at 1080P`);
  if (model.id === "wan-2-7") {
    const hasFrames = normalizedReferences.some((reference) => reference.role === "start-frame" || reference.role === "end-frame");
    const hasContinuation = normalizedReferences.some((reference) => reference.role === "reference-video");
    if (hasFrames && hasContinuation) throw new Error("WAN 2.7 uses either start/end frames or a continuation clip, not both");
  }
  if (model.id === "veo-3-1-fast") {
    const hasFrames = normalizedReferences.some((reference) => reference.role === "start-frame" || reference.role === "end-frame");
    const hasMaterials = normalizedReferences.some((reference) => reference.role === "reference-image");
    if (hasFrames && hasMaterials) throw new Error("Veo 3.1 Fast uses either first/last frames or material references, not both");
    if (hasMaterials && selectedDuration !== "8") throw new Error("Veo material-reference mode supports only 8 seconds");
  }
  if (normalizedReferences.some((reference) => reference.role === "end-frame") && !normalizedReferences.some((reference) => reference.role === "start-frame")) throw new Error("Connect a start frame before an end frame");
  const inputVideoDurationSeconds = normalizedReferences.filter((reference) => reference.role === "reference-video" || reference.role === "motion-video").reduce((total, reference) => total + reference.durationSeconds, 0);
  if (model.id === "kling-3-motion" && inputVideoDurationSeconds > 0 && (inputVideoDurationSeconds < 3 || inputVideoDurationSeconds > 30)) throw new Error("Kling Motion Control reference video must be 3–30 seconds");
  const duration = model.durationSource === "reference-video" && inputVideoDurationSeconds > 0 ? String(Math.ceil(inputVideoDurationSeconds)) : selectedDuration;
  const targetSourceAssetId = "targetSourceAssetId" in inspected ? inspected.targetSourceAssetId : undefined;
  if (masterClip && (masterClip.sourceAssetId || masterClip.sourceSegmentId)) {
    if (!targetSourceAssetId) throw Object.assign(new Error("The Video Master source scene must be materialized before generation"), { status: 409 });
    const targetSource = await db.prepare("SELECT metadata_json FROM assets WHERE id = ?").get(targetSourceAssetId) as { metadata_json: string | null } | undefined;
    const sourceError = targetSource ? validateVideoMasterGenerationReferences({
      graph: canvas.graph, nodeId: inspected.node.id, clipId: masterClip.id, targetSourceAssetId, targetSourceMetadataJson: targetSource.metadata_json,
      referenceAssetIds: inspected.references.map((reference) => reference.assetId), referenceRoles: normalizedReferences.map((reference) => reference.role as GeneratorInputRole),
    }) : "The generation source does not match the selected Video Master scene";
    if (sourceError) throw Object.assign(new Error(sourceError), { status: 409 });
  }
  const admission = await admitGeneration({
    userId: principal.userId,
    projectId: input.projectId,
    nodeId: input.nodeId,
    prompt,
    model,
    references: normalizedReferences,
    operation: "generation",
    aspectRatio,
    resolution,
    duration,
    generateAudio: masterClip?.generateAudio ?? inspected.node.data.generateAudio ?? model.defaultGenerateAudio ?? false,
    hasVideoInput,
    inputVideoDurationSeconds,
    targetClipId: masterClip?.id,
    targetSourceAssetId,
  });
  if (!admission.ok) throw Object.assign(new Error(admission.error), { status: admission.status, code: admission.code, retryAfterMs: admission.retryAfterMs, requiredCredits: admission.requiredCredits });
  const persistence = await persistCanvasIntelligenceResult(principal, {
    projectId: input.projectId,
    nodeId: input.nodeId,
    fingerprint: canvasNodeInputFingerprint(canvas.graph, input.nodeId),
    data: { status: "queued", queueReason: "provider", generationError: undefined, ...(masterClip ? { videoMasterGeneratingClipId: masterClip.id, videoMasterSelectedClipId: masterClip.id } : {}) },
  });
  return { ...admission, modelId: model.id, mediaType: model.mediaType, prompt, referenceCount: normalizedReferences.length, ...persistence };
}

export async function getMcpCanvasGeneration(principal: McpPrincipal, generationId: string) {
  const current = await readGenerationState(generationId);
  if (!current || !await userCanAccessGeneration(principal.userId, generationId)) throw Object.assign(new Error("Generation not found"), { status: 404 });
  await assertProject(principal, current.project_id);
  const reconciled = await reconcileGeneration(generationId);
  const generation = await generationClientState(reconciled);
  return { generation, canvas: await getMcpCanvas(principal, current.project_id) };
}

export async function cancelMcpCanvasGeneration(principal: McpPrincipal, generationId: string) {
  const current = await readGenerationState(generationId);
  if (!current || !await userCanAccessGeneration(principal.userId, generationId)) throw Object.assign(new Error("Generation not found"), { status: 404 });
  await assertProject(principal, current.project_id);
  const cancelled = await cancelGeneration(generationId, "Cancelled by an approved MCP agent");
  const canvas = await getMcpCanvas(principal, current.project_id);
  const node = canvas.graph.nodes.find((candidate) => candidate.id === current.node_id);
  let updated = canvas;
  if (cancelled && node) {
    updated = await patchMcpCanvas(principal, { projectId: current.project_id, expectedRevision: canvas.revision, operations: [{ type: "update_node", nodeId: node.id, data: { status: "failed", queueReason: undefined, generationError: "Generation cancelled", videoMasterGeneratingClipId: undefined } }] });
  }
  return { cancelled, generation: await generationClientState((await readGenerationState(generationId))!), canvas: updated };
}

export async function refreshMcpTikTokSource(principal: McpPrincipal, input: { projectId: string; expectedRevision: number; sourceNodeId: string }) {
  const canvas = await getMcpCanvas(principal, input.projectId);
  if (canvas.revision !== input.expectedRevision) throw Object.assign(new Error(`Canvas changed. Read it again and use revision ${canvas.revision}.`), { code: "CANVAS_REVISION_CONFLICT", status: 409, currentRevision: canvas.revision });
  const source = canvas.graph.nodes.find((node) => node.id === input.sourceNodeId && node.data.kind === "source");
  const url = String(source?.data.sourceUrl || "");
  if (!source || !/tiktok\.com/i.test(url)) throw Object.assign(new Error("TikTok source node not found"), { status: 404 });
  const post = await importProvider("tikwm").fetchTikTokStats(url);
  await db.prepare("UPDATE hooks SET views_count = ? WHERE project_id = ? AND kind = 'original'").run(post.stats.views, input.projectId);
  const updated = await patchMcpCanvas(principal, { projectId: input.projectId, expectedRevision: input.expectedRevision, operations: [{ type: "update_node", nodeId: source.id, data: { postId: post.id || undefined, author: post.author, publishedAt: post.publishedAt || undefined, postStats: post.stats } }] });
  return { post, canvas: updated };
}

export async function editMcpCanvasImage(principal: McpPrincipal, input: {
  projectId: string; expectedRevision: number; nodeId: string; prompt: string; modelId?: string; resolution?: string; aspectRatio?: string;
  sizeMode?: "original" | "custom";
  references?: Array<{ assetId: string; title?: string; detail?: string; origin?: "canvas" | "identity" | "upload" }>;
}) {
  const canvas = await getMcpCanvas(principal, input.projectId);
  if (canvas.revision !== input.expectedRevision) throw Object.assign(new Error(`Canvas changed. Read it again and use revision ${canvas.revision}.`), { code: "CANVAS_REVISION_CONFLICT", status: 409, currentRevision: canvas.revision });
  const node = canvas.graph.nodes.find((candidate) => candidate.id === input.nodeId);
  const sourceAssetId = node?.data.assetId;
  const sourceUrl = String(node?.data.outputUrl || node?.data.imageUrl || "");
  if (!node || node.data.mediaType !== "image" || !sourceAssetId || !sourceUrl || !await userCanAccessAsset(principal.userId, sourceAssetId)) throw new Error("This image is not available as an editable asset yet");
  const provider = generationProvider();
  const requestedModel = input.modelId ? provider.getModel(input.modelId) : undefined;
  const currentModel = node.data.modelId ? provider.getModel(String(node.data.modelId)) : undefined;
  const model = requestedModel?.mediaType === "image" && requestedModel.maxReferences > 0
    ? requestedModel : currentModel?.mediaType === "image" && currentModel.maxReferences > 0 ? currentModel : provider.getModel("nano-banana-2");
  const extra = input.references || [];
  if (extra.length && !principal.libraryAccess) throw Object.assign(new Error("Library access is required for additional edit references"), { status: 403 });
  if (extra.length > Math.max(0, model.maxReferences - 1)) throw new Error(`${model.label} accepts at most ${Math.max(0, model.maxReferences - 1)} additional edit references`);
  const referenceRows = await Promise.all([{ assetId: sourceAssetId, title: "Edit source", detail: "Base image", origin: "canvas" as const }, ...extra].map(async (reference, index) => {
    if (!await userCanAccessAsset(principal.userId, reference.assetId)) throw Object.assign(new Error(`Edit reference ${index + 1} is not available`), { status: 404 });
    const asset = await db.prepare("SELECT storage_path, mime_type FROM assets WHERE id = ?").get(reference.assetId) as { storage_path: string; mime_type: string } | undefined;
    if (!asset || !asset.mime_type.startsWith("image/")) throw new Error(`Edit reference ${index + 1} must be an image`);
    return { path: asset.storage_path, mimeType: asset.mime_type, role: "reference-image", durationSeconds: 0, label: index === 0 ? "@EditSource" : referenceMentionToken(reference.title || `Reference ${index}`, index - 1) };
  }));
  const resolutionOptions = provider.allowedResolutions(model, false);
  const resolution = resolutionOptions.includes(input.resolution || "") ? input.resolution! : model.defaultResolution || resolutionOptions[0];
  if (!resolution) throw new Error(`${model.label} has no compatible edit resolution`);
  const ratios = provider.allowedRatios(model, resolution, true);
  const sourceRatio = String(node.data.aspectRatio || model.defaultRatio || "4:5");
  const aspectRatio = input.sizeMode === "custom" && ratios.includes(input.aspectRatio || "") ? input.aspectRatio! : ratios.includes(sourceRatio) ? sourceRatio : model.defaultRatio || ratios[0];
  if (!aspectRatio) throw new Error(`${model.label} has no compatible edit aspect ratio`);
  const extraTokens = extra.map((reference, index) => `${referenceMentionToken(reference.title || `Reference ${index + 1}`, index)} — ${reference.title || `Reference ${index + 1}`} (${reference.detail || "supporting visual evidence"})`);
  const effectivePrompt = input.prompt.includes("IMAGE EDIT MODE") ? input.prompt : [
    "IMAGE EDIT MODE. Modify the provided @EditSource image in place.",
    "Preserve every element the user did not explicitly ask to change. Do not redesign or recompose the whole image.",
    input.sizeMode === "custom" ? `Reframe the output to ${aspectRatio}; the source used ${sourceRatio}.` : "Keep the source framing and aspect ratio.",
    extraTokens.length ? `ADDITIONAL EDIT REFERENCES: ${extraTokens.join("; ")}. Use only properties named in the edit request.` : "No additional edit references are attached.",
    `USER EDIT REQUEST: ${input.prompt}`,
  ].join("\n");
  if (effectivePrompt.length > (model.maxPromptLength || 5_000)) throw new Error(`${model.label} accepts prompts up to ${model.maxPromptLength || 5_000} characters`);
  const editReferences = extra.map((reference) => ({ assetId: reference.assetId, url: `/api/assets/${reference.assetId}`, title: reference.title || "Edit reference", origin: reference.origin || "canvas", detail: reference.detail || "Supporting edit reference" }));
  const prepared = await patchMcpCanvas(principal, { projectId: input.projectId, expectedRevision: input.expectedRevision, operations: [{ type: "update_node", nodeId: node.id, data: { prompt: effectivePrompt, status: "queued", queueReason: "plan", generationError: undefined, editReferencesByAssetId: { ...(node.data.editReferencesByAssetId || {}), [sourceAssetId]: editReferences } } }] });
  const admission = await admitGeneration({ userId: principal.userId, projectId: input.projectId, nodeId: node.id, prompt: effectivePrompt, model, references: referenceRows, operation: "edit", aspectRatio, resolution, duration: model.defaultDuration || model.durations?.[0] || "5", generateAudio: false, hasVideoInput: false, inputVideoDurationSeconds: 0 });
  if (!admission.ok) {
    const live = await getMcpCanvas(principal, input.projectId);
    const liveNode = live.graph.nodes.find((candidate) => candidate.id === node.id);
    if (liveNode?.data.status === "queued" && liveNode.data.queueReason === "plan" && liveNode.data.prompt === effectivePrompt) {
      await patchMcpCanvas(principal, { projectId: input.projectId, expectedRevision: live.revision, operations: [{ type: "update_node", nodeId: node.id, data: { status: "failed", queueReason: undefined, generationError: admission.error } }] }).catch(() => undefined);
    }
    throw Object.assign(new Error(admission.error), { status: admission.status, code: admission.code, retryAfterMs: admission.retryAfterMs, requiredCredits: admission.requiredCredits });
  }
  const queued = await getMcpCanvas(principal, input.projectId);
  const updated = await patchMcpCanvas(principal, { projectId: input.projectId, expectedRevision: queued.revision, operations: [{ type: "update_node", nodeId: node.id, data: { status: "queued", queueReason: "provider" } }] });
  return { ...admission, modelId: model.id, operation: "edit" as const, canvas: updated, preparedRevision: prepared.revision };
}

function formatImportBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export async function importMcpTikTokToCanvas(principal: McpPrincipal, input: {
  projectId: string;
  expectedRevision: number;
  url: string;
}) {
  if (!/^https?:\/\/[^/]*tiktok\.com\//i.test(input.url)) throw new Error("Paste a direct TikTok post link");
  const initial = await getMcpCanvas(principal, input.projectId);
  if (initial.revision !== input.expectedRevision) throw Object.assign(new Error(`Canvas changed. Read it again and use revision ${initial.revision}.`), { code: "CANVAS_REVISION_CONFLICT", status: 409, currentRevision: initial.revision });
  const workspaceId = await assertProject(principal, input.projectId);
  const result = await importProvider("tikwm").importTikTok(input.url, input.projectId);
  await db.transaction(async () => {
    await db.prepare("UPDATE projects SET name = ?, source_url = ?, status = 'imported', updated_at = ? WHERE id = ?").run(
      result.post.title.slice(0, 120) || "TikTok study",
      input.url,
      new Date().toISOString(),
      input.projectId,
    );
    await fireAutomationCanvasEvent({
      userId: principal.userId,
      projectId: input.projectId,
      event: "tiktok.imported",
      payload: { sourceUrl: input.url, assetIds: result.assets.map((asset) => asset.id), title: String(result.post.title || "") },
    });
  });
  let hook: ReturnType<typeof rowToHook> | null = null;
  let hookError: string | null = null;
  const firstVisual = result.assets.find((asset) => asset.kind === "slide" || asset.kind === "scene");
  if (firstVisual) {
    try {
      const stored = await db.prepare("SELECT storage_path, mime_type FROM assets WHERE id = ?").get(firstVisual.id) as { storage_path: string; mime_type: string } | undefined;
      if (stored) {
        const analysis = await intelligenceProvider().extractHookFromImage(stored.storage_path, stored.mime_type);
        if (analysis.hook) {
          const hookId = crypto.randomUUID();
          await db.prepare("INSERT INTO hooks (id, workspace_id, project_id, source_asset_id, source_url, kind, text, angle, language, views_count, created_at) VALUES (?, ?, ?, ?, ?, 'original', ?, ?, ?, ?, ?)")
            .run(hookId, workspaceId, input.projectId, firstVisual.id, input.url, analysis.hook, analysis.angle, analysis.language, result.post.stats.views, new Date().toISOString());
          hook = rowToHook(await db.prepare("SELECT * FROM hooks WHERE id = ?").get(hookId) as Record<string, unknown>);
        }
      }
    } catch (error) {
      hookError = error instanceof Error ? error.message : "Hook extraction failed";
    }
  }
  const current = await getMcpCanvas(principal, input.projectId);
  const importedMediaType = result.post.mediaType === "video" ? "video" as const : "slideshow" as const;
  const existingBottom = current.graph.nodes.reduce((bottom, node) => Math.max(bottom, node.position.y + (node.data.kind === "scene" ? 500 : 170)), 0);
  const blockTop = current.graph.nodes.length ? existingBottom + 160 : 60;
  const sourceId = crypto.randomUUID();
  const videoAsset = importedMediaType === "video" ? result.assets.find((asset) => asset.kind === "video") : undefined;
  const videoTimelineId = videoAsset ? crypto.randomUUID() : "";
  const timelineSpriteAsset = importedMediaType === "video"
    ? result.assets.find((asset) => asset.kind === "scene" && asset.metadata?.timelineSprite === true)
    : undefined;
  const detectedSceneAssets = importedMediaType === "video"
    ? result.assets.filter((asset) => asset.kind === "scene" && asset.metadata?.timelineSprite !== true)
    : [];
  const videoDuration = Number(videoAsset?.metadata?.duration || detectedSceneAssets.at(-1)?.metadata?.end || 0);
  const videoSegments = detectedSceneAssets.map((asset, index) => ({
    id: `video-scene-${asset.id}`,
    index: index + 1,
    sequenceIndex: index,
    label: `Scene ${String(index + 1).padStart(2, "0")}`,
    role: (asset.role === "hook" || asset.role === "cta" ? asset.role : "scene") as "hook" | "scene" | "cta",
    start: Number(asset.metadata?.start || 0),
    end: Number(asset.metadata?.end || videoDuration),
    confidence: Number(asset.metadata?.confidence || 0),
    thumbnailAssetId: asset.id,
    thumbnailUrl: asset.url,
    thumbnailTime: Number(asset.metadata?.start || 0),
  }));
  const sourceNode: FrameNode = {
    id: sourceId,
    type: "frameNode",
    position: { x: 80, y: blockTop + 200 },
    data: {
      kind: "source",
      title: result.post.title || `@${result.post.author}`,
      subtitle: importedMediaType === "video"
        ? `TikTok video · ${formatImportBytes(result.post.totalBytes)}`
        : `${importedMediaType} · ${result.assets.length} assets · ${formatImportBytes(result.post.totalBytes)}`,
      sourceUrl: result.post.sourceUrl,
      postId: result.post.id || undefined,
      tiktokMediaType: importedMediaType,
      author: result.post.author,
      publishedAt: result.post.publishedAt || undefined,
      postStats: result.post.stats,
      hookId: hook?.id,
      hookText: hook?.text,
      status: "ready",
    },
  };
  const videoTimelineNode: FrameNode | null = videoAsset ? {
    id: videoTimelineId,
    type: "frameNode",
    position: { x: 430, y: blockTop },
    data: {
      kind: "source",
      title: result.post.title || `@${result.post.author}`,
      subtitle: `${videoSegments.length} detected scene${videoSegments.length === 1 ? "" : "s"} · ${formatImportBytes(result.post.totalBytes)}`,
      sourceUrl: result.post.sourceUrl,
      assetId: videoAsset.id,
      imageUrl: videoAsset.url,
      mediaType: "video",
      videoSegments: videoSegments.length ? videoSegments : undefined,
      videoDetectedSegments: videoSegments.length ? videoSegments.map((segment) => ({ ...segment })) : undefined,
      videoDurationSeconds: videoDuration || undefined,
      videoTimelineSprite: timelineSpriteAsset ? {
        assetId: timelineSpriteAsset.id,
        url: timelineSpriteAsset.url,
        frameCount: Number(timelineSpriteAsset.metadata?.frameCount || 12),
        columns: Number(timelineSpriteAsset.metadata?.columns || 0) || undefined,
        rows: Number(timelineSpriteAsset.metadata?.rows || 0) || undefined,
      } : undefined,
      nodeWidth: 580,
      postId: result.post.id || undefined,
      tiktokMediaType: "video",
      author: result.post.author,
      publishedAt: result.post.publishedAt || undefined,
      postStats: result.post.stats,
      hookId: hook?.id,
      hookText: hook?.text,
      status: "ready",
    },
  } : null;
  const visuals = importedMediaType === "video" ? [] : result.assets.filter((asset) => asset.kind !== "video");
  const sceneNodes: FrameNode[] = visuals.map((asset, index) => ({
    id: crypto.randomUUID(),
    type: "frameNode",
    position: { x: 430 + (index % 5) * 310, y: blockTop + Math.floor(index / 5) * 545 },
    data: {
      kind: "scene",
      title: `Screen ${String(index + 1).padStart(2, "0")}`,
      subtitle: asset.kind === "slide" ? "Original slideshow screen" : "Extracted video screen",
      role: asset.role,
      assetId: asset.id,
      imageUrl: asset.url,
      tiktokSourceNodeId: sourceId,
      status: "ready",
    },
  }));
  const importedNodes = videoTimelineNode ? [sourceNode, videoTimelineNode] : [sourceNode, ...sceneNodes];
  const sourceEdges: FrameEdge[] = videoTimelineNode
    ? [{ id: crypto.randomUUID(), source: sourceId, sourceHandle: "output", target: videoTimelineNode.id, targetHandle: "input", animated: true, data: { portType: "video" } }]
    : sceneNodes.map((node) => ({ id: crypto.randomUUID(), source: sourceId, sourceHandle: "output", target: node.id, targetHandle: "input", animated: true }));
  const operations: CanvasPatchOperation[] = [
    ...importedNodes.map((node) => ({ type: "add_node" as const, id: node.id, nodeType: node.type, position: node.position, data: node.data })),
    ...sourceEdges.map((edge) => ({ type: "add_edge" as const, id: edge.id, source: edge.source, sourceHandle: edge.sourceHandle, target: edge.target, targetHandle: edge.targetHandle, data: edge.data })),
  ];
  const canvas = await patchMcpCanvas(principal, { projectId: input.projectId, expectedRevision: current.revision, operations });
  await appendAuditEvent({ workspaceId, actorUserId: principal.userId, action: "mcp.canvas.tiktok_imported", targetType: "project", targetId: input.projectId, metadata: { connectionId: principal.connectionId, sourceUrl: input.url, sourceNodeId: sourceId, assetCount: result.assets.length } });
  return { canvas, post: result.post, assets: result.assets, hook, hookError, importedNodeIds: importedNodes.map((node) => node.id), importedEdgeIds: sourceEdges.map((edge) => edge.id) };
}

export async function attachMcpCanvasReference(principal: McpPrincipal, input: {
  projectId: string;
  expectedRevision: number;
  nodeId: string;
  clipId?: string;
  assetId: string;
  role: GeneratorInputRole;
}) {
  if (!principal.libraryAccess) throw Object.assign(new Error("Library access was not approved for this connection"), { status: 403 });
  const workspaceId = await assertProject(principal, input.projectId);
  const current = await getMcpCanvas(principal, input.projectId);
  if (current.revision !== input.expectedRevision) throw Object.assign(new Error(`Canvas changed. Read it again and use revision ${current.revision}.`), { code: "CANVAS_REVISION_CONFLICT", status: 409, currentRevision: current.revision });
  const node = current.graph.nodes.find((candidate) => candidate.id === input.nodeId);
  const clip = input.clipId && node?.data.kind === "videoMaster" ? node.data.videoMasterClips?.find((candidate) => candidate.id === input.clipId) : undefined;
  if (!node || (node.data.kind !== "prompt" && node.data.kind !== "assistant" && !clip)) throw new Error("References can be attached only to a generator, Assistant, or Video Master scene");
  if (input.clipId && !clip) throw Object.assign(new Error("Video Master scene not found"), { status: 404 });
  const asset = await db.prepare("SELECT id, workspace_id, project_id, filename, mime_type, metadata_json, persona_id, role FROM assets WHERE id = ?").get(input.assetId) as
    { id: string; workspace_id: string; project_id: string | null; filename: string; mime_type: string; metadata_json: string | null; persona_id: string | null; role: string | null } | undefined;
  if (!asset || asset.workspace_id !== workspaceId || (asset.project_id && !tokenAllowsProject(principal, asset.project_id)) || !await userCanAccessAsset(principal.userId, asset.id)) throw Object.assign(new Error("Library asset not found"), { status: 404 });
  const expectedMime = input.role === "reference-video" || input.role === "motion-video" ? "video/" : input.role === "reference-audio" ? "audio/" : "image/";
  if (!asset.mime_type.startsWith(expectedMime)) throw new Error(`${input.role} requires a ${expectedMime.slice(0, -1)} asset`);
  if (clip) {
    const model = generationProvider().getModel(String(clip.modelId || node.data.modelId || ""));
    const port = model.inputPorts?.find((candidate) => candidate.id === input.role);
    if (!port) throw new Error(`${model.label} does not expose a ${input.role} input`);
    const capacity = generatorInputCapacity(model, input.role);
    const count = (clip.attachedReferences || []).filter((reference) => canonicalReferenceRole(reference.role, reference.role) === input.role).length
      + current.graph.edges.filter((edge) => edge.target === node.id && edge.data?.masterClipId === clip.id && canonicalReferenceRole(edge.data?.inputRole || edge.targetHandle?.replace(/-input$/, ""), edge.data?.portType) === input.role).length;
    if (count >= capacity && !(clip.attachedReferences || []).some((reference) => reference.assetId === asset.id && reference.role === input.role)) throw new Error(`${port.label || input.role} accepts at most ${capacity} input${capacity === 1 ? "" : "s"}`);
  } else if (node.data.kind === "assistant") {
    if (!getAssistantModel(node.data.textModelId).supportsVision || !asset.mime_type.startsWith("image/")) throw new Error("The selected Assistant model accepts only image references");
  } else {
    const model = generationProvider().getModel(String(node.data.modelId || ""));
    const port = model.inputPorts?.find((candidate) => candidate.id === input.role);
    if (!port && !(model.mediaType === "image" && input.role === "reference-image")) throw new Error(`${model.label} does not expose a ${input.role} input`);
    const capacity = generatorInputCapacity(model, input.role);
    const count = (node.data.attachedReferences || []).filter((reference) => canonicalReferenceRole(reference.role, reference.role) === input.role).length
      + current.graph.edges.filter((edge) => edge.target === node.id && canonicalReferenceRole(edge.data?.inputRole || edge.targetHandle?.replace(/-input$/, ""), edge.data?.portType) === input.role).length;
    if (count >= capacity && !(node.data.attachedReferences || []).some((reference) => reference.assetId === asset.id && reference.role === input.role)) throw new Error(`${port?.label || input.role} accepts at most ${capacity} input${capacity === 1 ? "" : "s"}`);
  }
  let durationSeconds: number | undefined;
  try {
    const metadata = JSON.parse(asset.metadata_json || "{}") as { duration?: number | string; durationSeconds?: number | string };
    durationSeconds = Number(metadata.durationSeconds || metadata.duration || 0) || undefined;
  } catch {}
  const attached = clip?.attachedReferences || node.data.attachedReferences || [];
  if (attached.some((reference) => reference.assetId === asset.id && reference.role === input.role)) return current;
  const variant: "reference" | "before" | "after" | undefined = asset.role === "reference" || asset.role === "before" || asset.role === "after" ? asset.role : undefined;
  const next = [...attached, {
    assetId: asset.id,
    url: `/api/assets/${asset.id}`,
    title: asset.filename || "Library reference",
    personaId: asset.persona_id || undefined,
    variant,
    role: input.role,
    durationSeconds,
  }];
  return await patchMcpCanvas(principal, { projectId: input.projectId, expectedRevision: input.expectedRevision, operations: [{ type: "update_node", nodeId: node.id, data: clip
    ? { videoMasterClips: node.data.videoMasterClips?.map((candidate) => candidate.id === clip.id ? { ...candidate, attachedReferences: next } : candidate), videoMasterSelectedClipId: clip.id }
    : { attachedReferences: next } }] });
}

export async function detachMcpCanvasReference(principal: McpPrincipal, input: {
  projectId: string; expectedRevision: number; nodeId: string; assetId: string; role?: GeneratorInputRole; clipId?: string;
}) {
  const current = await getMcpCanvas(principal, input.projectId);
  if (current.revision !== input.expectedRevision) throw Object.assign(new Error(`Canvas changed. Read it again and use revision ${current.revision}.`), { code: "CANVAS_REVISION_CONFLICT", status: 409, currentRevision: current.revision });
  const node = current.graph.nodes.find((candidate) => candidate.id === input.nodeId);
  const clip = input.clipId && node?.data.kind === "videoMaster" ? node.data.videoMasterClips?.find((candidate) => candidate.id === input.clipId) : undefined;
  if (!node || (input.clipId && !clip)) throw Object.assign(new Error("Canvas node or Video Master scene not found"), { status: 404 });
  const attached = clip?.attachedReferences || node.data.attachedReferences || [];
  const next = attached.filter((reference) => !(reference.assetId === input.assetId && (!input.role || reference.role === input.role)));
  if (next.length === attached.length) return current;
  return await patchMcpCanvas(principal, { projectId: input.projectId, expectedRevision: input.expectedRevision, operations: [{ type: "update_node", nodeId: node.id, data: clip
    ? { videoMasterClips: node.data.videoMasterClips?.map((candidate) => candidate.id === clip.id ? { ...candidate, attachedReferences: next } : candidate), videoMasterSelectedClipId: clip.id }
    : { attachedReferences: next } }] });
}

export async function selectMcpCanvasOutput(principal: McpPrincipal, input: {
  projectId: string;
  expectedRevision: number;
  nodeId: string;
  outputIndex: number;
  clipId?: string;
}) {
  const current = await getMcpCanvas(principal, input.projectId);
  if (current.revision !== input.expectedRevision) throw Object.assign(new Error(`Canvas changed. Read it again and use revision ${current.revision}.`), { code: "CANVAS_REVISION_CONFLICT", status: 409, currentRevision: current.revision });
  const node = current.graph.nodes.find((candidate) => candidate.id === input.nodeId);
  if (!node) throw Object.assign(new Error("Canvas node not found"), { status: 404 });
  if (input.clipId) {
    if (node.data.kind !== "videoMaster") throw new Error("clip_id can be used only with a Video Master node");
    const clip = node.data.videoMasterClips?.find((candidate) => candidate.id === input.clipId);
    const output = clip?.generatedOutputs?.[input.outputIndex];
    if (!clip || !output) throw new Error("Generated Video Master output not found");
    const clips = node.data.videoMasterClips!.map((candidate) => candidate.id === clip.id ? { ...candidate, outputUrl: output.url, outputAssetId: output.assetId, modelId: output.modelId || candidate.modelId, generatedDuration: output.durationSeconds || candidate.generatedDuration } : candidate);
    return await patchMcpCanvas(principal, { projectId: input.projectId, expectedRevision: input.expectedRevision, operations: [{ type: "update_node", nodeId: node.id, data: { videoMasterClips: clips, videoMasterSelectedClipId: clip.id } }] });
  }
  const output = node.data.generatedOutputs?.[input.outputIndex];
  if (!output) throw new Error("Generated output not found");
  return await patchMcpCanvas(principal, { projectId: input.projectId, expectedRevision: input.expectedRevision, operations: [{ type: "update_node", nodeId: node.id, data: { outputUrl: output.url, assetId: output.assetId, mediaType: output.mediaType, modelId: output.modelId || node.data.modelId, activeGeneratedOutputIndex: input.outputIndex, status: "ready" } }] });
}

export async function createMcpVideoMaster(principal: McpPrincipal, input: {
  projectId: string;
  expectedRevision: number;
  sourceNodeId: string;
  focusSegmentId?: string;
}) {
  const current = await getMcpCanvas(principal, input.projectId);
  if (current.revision !== input.expectedRevision) throw Object.assign(new Error(`Canvas changed. Read it again and use revision ${current.revision}.`), { code: "CANVAS_REVISION_CONFLICT", status: 409, currentRevision: current.revision });
  const source = current.graph.nodes.find((node) => node.id === input.sourceNodeId);
  const sourceUrl = String(source?.data.outputUrl || source?.data.imageUrl || "");
  const sourceSegments = [...(source?.data.videoSegments || [])].sort((left, right) => Number(left.sequenceIndex ?? left.index) - Number(right.sequenceIndex ?? right.index) || left.start - right.start);
  if (!source || source.data.mediaType !== "video" || !sourceUrl || !sourceSegments.length) throw new Error("This video does not have an editable scene map yet");
  const provider = generationProvider();
  const model = provider.getModel("seedance-2-fast");
  const sourceRatio = Math.max(.2, Number(source.data.videoAspectRatio || 9 / 16));
  const resolution = model.defaultResolution || model.resolutions?.[0] || "720P";
  const ratios = provider.allowedRatios(model, resolution, true).filter((ratio) => /^\d+:\d+$/.test(ratio));
  const aspectRatio = nearestVideoMasterRatio(sourceRatio, ratios);
  const clips: VideoMasterClip[] = sourceSegments.map((segment, sequenceIndex) => {
    const duration = Math.max(.1, segment.end - segment.start);
    return {
      id: crypto.randomUUID(), sequenceIndex, title: segment.label, role: segment.role,
      origin: segment.replacementUrl ? "generated" : "source", duration,
      generationDuration: videoMasterGenerationDuration(model, { duration } as VideoMasterClip), prompt: "", modelId: model.id,
      aspectRatio, aspectRatioMode: "original", sourceAspectRatio: sourceRatio, resolution,
      generateAudio: model.defaultGenerateAudio ?? false, sourceNodeId: source.id, sourceSegmentId: segment.id,
      sourceStart: segment.start, sourceEnd: segment.end, sourceUrl, sourceAssetId: source.data.assetId,
      sourceClipUrl: segment.clipUrl, sourceClipAssetId: segment.clipAssetId, thumbnailUrl: segment.thumbnailUrl,
      outputUrl: segment.replacementUrl, outputAssetId: segment.replacementAssetId,
    };
  });
  const focused = clips.find((clip) => clip.sourceSegmentId === input.focusSegmentId) || clips[0];
  const masterId = crypto.randomUUID();
  const master: FrameNode = {
    id: masterId,
    type: "frameNode",
    position: { x: source.position.x + Number(source.data.nodeWidth || 580) + 150, y: source.position.y },
    data: {
      kind: "videoMaster", title: "Video Master", subtitle: `Sequence · ${source.data.title}`, status: "idle", mediaType: "video",
      modelId: focused.modelId, duration: String(focused.generationDuration || Math.max(1, Math.round(focused.duration))), resolution: resolution as FrameNodeData["resolution"],
      aspectRatio: aspectRatio as FrameNodeData["aspectRatio"], ratioMode: "original", generateAudio: model.defaultGenerateAudio ?? false,
      generationCount: 1, prompt: "", nodeWidth: 720, videoAspectRatio: sourceRatio, videoMasterSourceNodeId: source.id,
      videoMasterClips: clips, videoMasterSelectedClipId: focused.id,
    },
  };
  const operations: CanvasPatchOperation[] = [
    { type: "update_node", nodeId: source.id, data: { videoOutputSelection: focused.sourceSegmentId } },
    { type: "add_node", id: master.id, nodeType: master.type, position: master.position, data: master.data },
  ];
  if (model.inputPorts?.some((port) => port.id === "reference-video")) {
    for (const clip of clips) {
      const segment = sourceSegments.find((candidate) => candidate.id === clip.sourceSegmentId)!;
      operations.push({
        type: "add_edge", id: crypto.randomUUID(), source: source.id, sourceHandle: `segment-output:${segment.id}`, target: master.id,
        targetHandle: `master:${clip.id}:reference-video-input`, data: {
          portType: "video", inputRole: "reference-video", masterClipId: clip.id, sourceSegmentId: segment.id,
          sourceSegmentStart: segment.start, sourceSegmentEnd: segment.end, sourceSegmentLabel: segment.label,
          sourceSegmentThumbnailUrl: segment.thumbnailUrl, clipAssetId: segment.clipAssetId, clipUrl: segment.clipUrl,
        },
      });
    }
  }
  const canvas = await patchMcpCanvas(principal, { projectId: input.projectId, expectedRevision: input.expectedRevision, operations });
  return { canvas, node: canvas.graph.nodes.find((node) => node.id === masterId)! };
}

export async function configureMcpVideoMasterClip(principal: McpPrincipal, input: {
  projectId: string; expectedRevision: number; nodeId: string; clipId: string;
  title?: string; role?: "hook" | "scene" | "cta"; prompt?: string; modelId?: string; aspectRatio?: string;
  aspectRatioMode?: "original" | "custom"; resolution?: string; duration?: number; generateAudio?: boolean; sequenceIndex?: number;
}) {
  const current = await getMcpCanvas(principal, input.projectId);
  if (current.revision !== input.expectedRevision) throw Object.assign(new Error(`Canvas changed. Read it again and use revision ${current.revision}.`), { code: "CANVAS_REVISION_CONFLICT", status: 409, currentRevision: current.revision });
  const node = current.graph.nodes.find((candidate) => candidate.id === input.nodeId && candidate.data.kind === "videoMaster");
  const clip = node?.data.videoMasterClips?.find((candidate) => candidate.id === input.clipId);
  if (!node || !clip) throw Object.assign(new Error("Video Master scene not found"), { status: 404 });
  const provider = generationProvider();
  const model = provider.getModel(input.modelId || clip.modelId || "seedance-2-fast");
  if (model.mediaType !== "video") throw new Error("Video Master scenes require a video model");
  const hasVideoInput = Boolean(clip.sourceAssetId || clip.sourceClipAssetId || current.graph.edges.some((edge) => edge.target === node.id && edge.data?.masterClipId === clip.id && (edge.data?.inputRole === "reference-video" || edge.data?.inputRole === "motion-video")));
  const resolutions = provider.allowedResolutions(model, hasVideoInput);
  const resolution = resolutions.includes(input.resolution || clip.resolution || "") ? (input.resolution || clip.resolution)! : model.defaultResolution || resolutions[0];
  if (!resolution) throw new Error(`${model.label} has no compatible resolution`);
  const ratios = provider.allowedRatios(model, resolution, true).filter((ratio) => ratio !== "source");
  const ratioMode = input.aspectRatioMode || clip.aspectRatioMode || "original";
  const requestedRatio = input.aspectRatio || clip.aspectRatio || "";
  const aspectRatio = ratioMode === "custom" && ratios.includes(requestedRatio) ? requestedRatio : nearestVideoMasterRatio(videoMasterSourceRatio(clip, Number(node.data.videoAspectRatio)), ratios);
  const draft = { ...clip, ...(input.duration !== undefined ? { generationDuration: input.duration } : {}) };
  const generationDuration = videoMasterGenerationDuration(model, draft);
  let nextClips = node.data.videoMasterClips!.map((candidate) => candidate.id === clip.id ? {
    ...candidate,
    ...(input.title !== undefined ? { title: input.title.trim().slice(0, 160) || candidate.title } : {}),
    ...(input.role !== undefined ? { role: input.role } : {}),
    ...(input.prompt !== undefined ? { prompt: input.prompt.slice(0, model.maxPromptLength || 30_000) } : {}),
    modelId: model.id, resolution, aspectRatio, aspectRatioMode: ratioMode, generationDuration,
    generateAudio: model.supportsAudio ? input.generateAudio ?? candidate.generateAudio ?? model.defaultGenerateAudio ?? false : false,
    attachedReferences: candidate.attachedReferences?.filter((reference) => model.inputPorts?.some((port) => port.id === reference.role)),
  } : candidate);
  if (input.sequenceIndex !== undefined) {
    const sourceIndex = nextClips.findIndex((candidate) => candidate.id === clip.id);
    const targetIndex = Math.min(nextClips.length - 1, Math.max(0, Math.floor(input.sequenceIndex)));
    const [moved] = nextClips.splice(sourceIndex, 1);
    nextClips.splice(targetIndex, 0, moved);
  }
  nextClips = nextClips.map((candidate, sequenceIndex) => ({ ...candidate, sequenceIndex }));
  return await patchMcpCanvas(principal, { projectId: input.projectId, expectedRevision: input.expectedRevision, operations: [{ type: "update_node", nodeId: node.id, data: { videoMasterClips: nextClips, videoMasterSelectedClipId: clip.id, modelId: model.id, duration: String(generationDuration), resolution: resolution as FrameNodeData["resolution"], aspectRatio: aspectRatio as FrameNodeData["aspectRatio"], prompt: input.prompt ?? clip.prompt } }] });
}

type McpLibraryAssetRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  filename: string;
  storage_path: string;
  mime_type: string;
  metadata_json: string;
};

function readAssetMetadata(value: string) {
  try { return JSON.parse(value || "{}") as Record<string, unknown>; } catch { return {}; }
}

async function mcpLibraryAsset(principal: McpPrincipal, assetId: string, expectedMediaType?: "image" | "video") {
  if (!principal.libraryAccess) throw Object.assign(new Error("Library access was not approved for this connection"), { status: 403 });
  const asset = await db.prepare("SELECT id, workspace_id, project_id, filename, storage_path, mime_type, metadata_json FROM assets WHERE id = ?")
    .get(assetId) as McpLibraryAssetRow | undefined;
  const mediaType = asset?.mime_type.startsWith("video/") ? "video" : asset?.mime_type.startsWith("image/") ? "image" : undefined;
  if (!asset || !mediaType || (expectedMediaType && mediaType !== expectedMediaType)
    || !tokenAllowsWorkspace(principal, asset.workspace_id) || !tokenAllowsProject(principal, asset.project_id)
    || !await userCanAccessAsset(principal.userId, asset.id)) {
    throw Object.assign(new Error("Library asset not found"), { status: 404 });
  }
  return { ...asset, mediaType, metadata: readAssetMetadata(asset.metadata_json), url: `/api/assets/${asset.id}` };
}

export async function uploadMcpLibraryAsset(principal: McpPrincipal, input: {
  projectId: string;
  filename: string;
  mimeType: "image/jpeg" | "image/png" | "video/mp4" | "video/webm" | "video/quicktime";
  contentBase64: string;
}) {
  if (!principal.libraryAccess) throw Object.assign(new Error("Library access was not approved for this connection"), { status: 403 });
  const workspaceId = await assertProject(principal, input.projectId);
  const encoded = input.contentBase64.replace(/\s+/g, "");
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("content_base64 is not valid base64");
  const bytes = Buffer.from(encoded, "base64");
  // MCP transports the file inside JSON as base64. Keep the encoded request
  // comfortably below common reverse-proxy body limits; larger videos belong
  // on the existing multipart Library upload path in the UI.
  const maxBytes = input.mimeType.startsWith("image/") ? 25 * 1024 * 1024 : 32 * 1024 * 1024;
  if (!bytes.length || bytes.length > maxBytes) throw Object.assign(new Error(`Media must be smaller than ${maxBytes / 1024 / 1024} MB`), { status: 413 });
  if (!mediaContentMatchesMime(bytes.subarray(0, 64), input.mimeType)) throw new Error("Media bytes do not match mime_type");
  const mediaType = input.mimeType.startsWith("video/") ? "video" : "image";
  const extension = safeExtension(input.filename, input.mimeType);
  const id = crypto.randomUUID();
  const filename = `library-${mediaType}-${Date.now()}${extension}`;
  const videoMetadata = mediaType === "video" ? await probeVideoMetadata(bytes, extension).catch(() => ({})) : {};
  const stored = await saveBytes(bytes, `workspaces/${workspaceId}/projects/${input.projectId}/library`, filename, input.mimeType);
  try {
    await db.transaction(async () => {
      await assertWorkspaceStorageCapacity(workspaceId, stored.size);
      await db.prepare(`INSERT INTO assets (id, workspace_id, project_id, kind, role, filename, storage_path, storage_provider, storage_bucket, object_key, size_bytes, content_hash, mime_type, metadata_json, created_at)
        VALUES (?, ?, ?, ?, 'library', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, workspaceId, input.projectId, `library_${mediaType}`, filename, stored.reference, stored.provider, stored.bucket, stored.key,
        stored.size, stored.contentHash, input.mimeType, JSON.stringify({ source: "mcp_library_upload", mediaType, originalName: input.filename, ...videoMetadata }), new Date().toISOString(),
      );
    })();
  } catch (error) {
    await deleteStorageObject(stored.reference).catch(() => undefined);
    throw error;
  }
  await appendAuditEvent({ workspaceId, actorUserId: principal.userId, action: "mcp.library.asset_uploaded", targetType: "asset", targetId: id, metadata: { connectionId: principal.connectionId, projectId: input.projectId, mimeType: input.mimeType, sizeBytes: stored.size } });
  return { id, projectId: input.projectId, filename, originalName: input.filename, mediaType, mimeType: input.mimeType, url: `/api/assets/${id}`, thumbnailUrl: `/api/assets/${id}?variant=thumbnail&delivery=direct&v=2`, ...videoMetadata };
}

export async function createMcpCanvasSegmentNode(principal: McpPrincipal, input: {
  projectId: string; expectedRevision: number; sourceNodeId: string; segmentId: string; position: { x: number; y: number };
}) {
  const initial = await getMcpCanvas(principal, input.projectId);
  if (initial.revision !== input.expectedRevision) throw Object.assign(new Error(`Canvas changed. Read it again and use revision ${initial.revision}.`), { code: "CANVAS_REVISION_CONFLICT", status: 409, currentRevision: initial.revision });
  const source = initial.graph.nodes.find((node) => node.id === input.sourceNodeId);
  const segment = source?.data.videoSegments?.find((candidate) => candidate.id === input.segmentId);
  const sourceUrl = String(source?.data.outputUrl || source?.data.imageUrl || "");
  if (!source || !segment || !sourceUrl) throw Object.assign(new Error("Video segment not found"), { status: 404 });
  if (!segment.clipAssetId || !segment.clipUrl) await materializeMcpCanvasVideoSegment(principal, input);
  const current = await getMcpCanvas(principal, input.projectId);
  const liveSource = current.graph.nodes.find((node) => node.id === input.sourceNodeId)!;
  const liveSegment = liveSource.data.videoSegments?.find((candidate) => candidate.id === input.segmentId);
  if (!liveSegment) throw Object.assign(new Error("Video segment changed while it was prepared"), { status: 409 });
  const duration = Math.max(.001, liveSegment.end - liveSegment.start);
  const ratio = Math.max(.2, Number(liveSource.data.videoAspectRatio || 9 / 16));
  const nodeId = crypto.randomUUID();
  const data: FrameNodeData = {
    kind: "scene", mediaType: "video", title: liveSegment.label, subtitle: `${liveSegment.start.toFixed(3)}s — ${liveSegment.end.toFixed(3)}s`,
    imageUrl: liveSegment.clipUrl || sourceUrl, outputUrl: liveSegment.clipUrl || sourceUrl, assetId: liveSegment.clipAssetId,
    role: liveSegment.role, duration: String(duration), nodeWidth: ratio >= 1 ? 320 : 240, videoAspectRatio: ratio,
    videoClipStart: liveSegment.clipAssetId ? 0 : liveSegment.start, videoClipEnd: liveSegment.clipAssetId ? duration : liveSegment.end,
    videoSourceNodeId: liveSource.id, videoSegmentId: liveSegment.id, videoSourceAssetId: liveSource.data.assetId, segmentMaterializing: false,
  };
  const canvas = await patchMcpCanvas(principal, { projectId: input.projectId, expectedRevision: current.revision, operations: [{ type: "add_node", id: nodeId, nodeType: "frameNode", position: input.position, data }] });
  return { canvas, node: canvas.graph.nodes.find((node) => node.id === nodeId)! };
}

export async function replaceMcpCanvasVideoSegment(principal: McpPrincipal, input: {
  projectId: string; expectedRevision: number; sourceNodeId: string; segmentId: string; replacementAssetId: string;
}) {
  const asset = await mcpLibraryAsset(principal, input.replacementAssetId, "video");
  const current = await getMcpCanvas(principal, input.projectId);
  if (current.revision !== input.expectedRevision) throw Object.assign(new Error(`Canvas changed. Read it again and use revision ${current.revision}.`), { code: "CANVAS_REVISION_CONFLICT", status: 409, currentRevision: current.revision });
  const source = current.graph.nodes.find((node) => node.id === input.sourceNodeId);
  const segment = source?.data.videoSegments?.find((candidate) => candidate.id === input.segmentId);
  if (!source || !segment) throw Object.assign(new Error("Video segment not found"), { status: 404 });
  const operations: CanvasPatchOperation[] = [{ type: "update_node", nodeId: source.id, data: { videoSegments: source.data.videoSegments?.map((candidate) => candidate.id === segment.id ? { ...candidate, replacementAssetId: asset.id, replacementUrl: asset.url } : candidate) } }];
  for (const node of current.graph.nodes.filter((candidate) => candidate.data.kind === "videoMaster" && candidate.data.videoMasterClips?.some((clip) => clip.sourceNodeId === source.id && clip.sourceSegmentId === segment.id))) {
    operations.push({ type: "update_node", nodeId: node.id, data: { videoMasterClips: node.data.videoMasterClips?.map((clip) => clip.sourceNodeId === source.id && clip.sourceSegmentId === segment.id ? { ...clip, origin: "generated", outputAssetId: asset.id, outputUrl: asset.url } : clip) } });
  }
  return await patchMcpCanvas(principal, { projectId: input.projectId, expectedRevision: input.expectedRevision, operations });
}

export async function addMcpVideoMasterAsset(principal: McpPrincipal, input: {
  projectId: string; expectedRevision: number; nodeId: string; assetId: string;
}) {
  const asset = await mcpLibraryAsset(principal, input.assetId, "video");
  const current = await getMcpCanvas(principal, input.projectId);
  if (current.revision !== input.expectedRevision) throw Object.assign(new Error(`Canvas changed. Read it again and use revision ${current.revision}.`), { code: "CANVAS_REVISION_CONFLICT", status: 409, currentRevision: current.revision });
  const node = current.graph.nodes.find((candidate) => candidate.id === input.nodeId && candidate.data.kind === "videoMaster");
  if (!node) throw Object.assign(new Error("Video Master not found"), { status: 404 });
  const model = generationProvider().getModel("seedance-2-fast");
  const resolution = model.defaultResolution || model.resolutions?.[0] || "720P";
  const sourceRatio = Math.max(.2, Number(asset.metadata.aspectRatio || (Number(asset.metadata.width) / Number(asset.metadata.height)) || node.data.videoAspectRatio || 9 / 16));
  const ratios = generationProvider().allowedRatios(model, resolution, true).filter((ratio) => /^\d+:\d+$/.test(ratio));
  const duration = Math.max(.1, Number(asset.metadata.durationSeconds || asset.metadata.duration || model.defaultDuration || 5));
  const clip: VideoMasterClip = {
    id: crypto.randomUUID(), sequenceIndex: node.data.videoMasterClips?.length || 0, title: String(asset.metadata.originalName || asset.filename || "Video"), role: "scene", origin: "upload", duration,
    generationDuration: videoMasterGenerationDuration(model, { duration } as VideoMasterClip), prompt: "", modelId: model.id,
    aspectRatio: nearestVideoMasterRatio(sourceRatio, ratios), aspectRatioMode: "original", sourceAspectRatio: sourceRatio,
    resolution, generateAudio: model.defaultGenerateAudio ?? false, sourceUrl: asset.url, sourceAssetId: asset.id, thumbnailUrl: `${asset.url}?variant=thumbnail&delivery=direct&v=2`,
  };
  const clips = [...(node.data.videoMasterClips || []), clip];
  const canvas = await patchMcpCanvas(principal, { projectId: input.projectId, expectedRevision: input.expectedRevision, operations: [{ type: "update_node", nodeId: node.id, data: { videoMasterClips: clips, videoMasterSelectedClipId: clip.id, prompt: "", modelId: clip.modelId, duration: String(clip.generationDuration || clip.duration) } }] });
  return { canvas, clip };
}

export async function copyMcpVideoMasterOutput(principal: McpPrincipal, input: {
  projectId: string; expectedRevision: number; nodeId: string; sourceClipId: string; outputIndex: number; targetClipId: string;
}) {
  const current = await getMcpCanvas(principal, input.projectId);
  if (current.revision !== input.expectedRevision) throw Object.assign(new Error(`Canvas changed. Read it again and use revision ${current.revision}.`), { code: "CANVAS_REVISION_CONFLICT", status: 409, currentRevision: current.revision });
  const node = current.graph.nodes.find((candidate) => candidate.id === input.nodeId && candidate.data.kind === "videoMaster");
  const source = node?.data.videoMasterClips?.find((clip) => clip.id === input.sourceClipId);
  const output = source?.generatedOutputs?.[input.outputIndex];
  if (!node || !source || !output || !node.data.videoMasterClips?.some((clip) => clip.id === input.targetClipId)) throw Object.assign(new Error("Video Master output or target scene not found"), { status: 404 });
  const clips = applyVideoMasterGeneratedOutput(node.data.videoMasterClips, input.targetClipId, output);
  return await patchMcpCanvas(principal, { projectId: input.projectId, expectedRevision: input.expectedRevision, operations: [{ type: "update_node", nodeId: node.id, data: { videoMasterClips: clips, videoMasterSelectedClipId: input.targetClipId } }] });
}

export async function removeMcpVideoMasterScene(principal: McpPrincipal, input: { projectId: string; expectedRevision: number; nodeId: string; clipId: string }) {
  const current = await getMcpCanvas(principal, input.projectId);
  if (current.revision !== input.expectedRevision) throw Object.assign(new Error(`Canvas changed. Read it again and use revision ${current.revision}.`), { code: "CANVAS_REVISION_CONFLICT", status: 409, currentRevision: current.revision });
  const node = current.graph.nodes.find((candidate) => candidate.id === input.nodeId && candidate.data.kind === "videoMaster");
  const clips = node?.data.videoMasterClips || [];
  const removedIndex = clips.findIndex((clip) => clip.id === input.clipId);
  if (!node || removedIndex < 0) throw Object.assign(new Error("Video Master scene not found"), { status: 404 });
  const nextClips = clips.filter((clip) => clip.id !== input.clipId).sort((a, b) => Number(a.sequenceIndex || 0) - Number(b.sequenceIndex || 0)).map((clip, sequenceIndex) => ({ ...clip, sequenceIndex }));
  const fallback = nextClips[Math.min(removedIndex, Math.max(0, nextClips.length - 1))];
  const operations: CanvasPatchOperation[] = [{ type: "update_node", nodeId: node.id, data: { videoMasterClips: nextClips, videoMasterSelectedClipId: fallback?.id, prompt: fallback?.prompt || "", modelId: fallback?.modelId || node.data.modelId, duration: fallback ? String(fallback.generationDuration || Math.max(1, fallback.duration || 5)) : node.data.duration } }];
  for (const edge of current.graph.edges.filter((candidate) => candidate.target === node.id && candidate.data?.masterClipId === input.clipId)) operations.push({ type: "remove_edge", edgeId: edge.id });
  return await patchMcpCanvas(principal, { projectId: input.projectId, expectedRevision: input.expectedRevision, operations });
}

export async function addMcpVideoMasterScene(principal: McpPrincipal, input: { projectId: string; expectedRevision: number; nodeId: string }) {
  const current = await getMcpCanvas(principal, input.projectId);
  if (current.revision !== input.expectedRevision) throw Object.assign(new Error(`Canvas changed. Read it again and use revision ${current.revision}.`), { code: "CANVAS_REVISION_CONFLICT", status: 409, currentRevision: current.revision });
  const node = current.graph.nodes.find((candidate) => candidate.id === input.nodeId && candidate.data.kind === "videoMaster");
  if (!node) throw Object.assign(new Error("Video Master not found"), { status: 404 });
  const clips = node.data.videoMasterClips || [];
  const selected = clips.find((clip) => clip.id === node.data.videoMasterSelectedClipId) || clips.at(-1);
  const clip: VideoMasterClip = {
    id: crypto.randomUUID(), sequenceIndex: clips.length, title: `Scene ${String(clips.length + 1).padStart(2, "0")}`,
    role: clips.length ? "scene" : "hook", origin: "generated", duration: Number(selected?.duration || 5), prompt: "",
    modelId: selected?.modelId || "seedance-2-fast", aspectRatio: selected?.aspectRatio || "9:16", aspectRatioMode: selected?.aspectRatioMode || "custom",
    resolution: selected?.resolution || "720P", generateAudio: selected?.generateAudio ?? false,
  };
  const canvas = await patchMcpCanvas(principal, { projectId: input.projectId, expectedRevision: input.expectedRevision, operations: [{ type: "update_node", nodeId: node.id, data: { videoMasterClips: [...clips, clip], videoMasterSelectedClipId: clip.id, prompt: "", modelId: clip.modelId, duration: String(clip.duration) } }] });
  return { canvas, clip };
}

export async function moveMcpVideoMasterAssetLane(principal: McpPrincipal, input: { projectId: string; expectedRevision: number; nodeId: string; clipId: string; lane: "output" | "original" }) {
  const current = await getMcpCanvas(principal, input.projectId);
  if (current.revision !== input.expectedRevision) throw Object.assign(new Error(`Canvas changed. Read it again and use revision ${current.revision}.`), { code: "CANVAS_REVISION_CONFLICT", status: 409, currentRevision: current.revision });
  const node = current.graph.nodes.find((candidate) => candidate.id === input.nodeId && candidate.data.kind === "videoMaster");
  const clip = node?.data.videoMasterClips?.find((candidate) => candidate.id === input.clipId);
  if (!node || !clip) throw Object.assign(new Error("Video Master scene not found"), { status: 404 });
  if (clip.sourceNodeId || !clip.sourceUrl) throw new Error("Only a standalone uploaded Library clip can move between OUTPUT and ORIGINAL");
  const clips = node.data.videoMasterClips!.map((candidate) => candidate.id === clip.id ? moveUploadedMasterClipToLane(candidate, input.lane) : candidate);
  return await patchMcpCanvas(principal, { projectId: input.projectId, expectedRevision: input.expectedRevision, operations: [{ type: "update_node", nodeId: node.id, data: { videoMasterClips: clips, videoMasterSelectedClipId: clip.id } }] });
}

export async function updateMcpCanvasVideoTimeline(principal: McpPrincipal, input: {
  projectId: string; expectedRevision: number; sourceNodeId: string; restoreDetected?: boolean;
  cuts?: number[]; outputSelection?: "full" | string;
}) {
  const current = await getMcpCanvas(principal, input.projectId);
  if (current.revision !== input.expectedRevision) throw Object.assign(new Error(`Canvas changed. Read it again and use revision ${current.revision}.`), { code: "CANVAS_REVISION_CONFLICT", status: 409, currentRevision: current.revision });
  const source = current.graph.nodes.find((node) => node.id === input.sourceNodeId && node.data.mediaType === "video" && node.data.videoSegments?.length);
  if (!source) throw Object.assign(new Error("Editable video timeline not found"), { status: 404 });
  const duration = Math.max(.001, Number(source.data.videoDurationSeconds || source.data.videoSegments?.at(-1)?.end || 0));
  let segments = source.data.videoSegments!;
  if (input.restoreDetected) {
    segments = restoreDetectedVideoSegments(segments, duration, source.data.videoDetectedSegments);
  } else if (input.cuts) {
    const cuts = [...new Set(input.cuts.map((cut) => Math.round(cut * 1_000_000) / 1_000_000))]
      .filter((cut) => Number.isFinite(cut) && cut > 1 / 120 && cut < duration - 1 / 120).sort((a, b) => a - b);
    if (cuts.length !== input.cuts.length) throw new Error("cuts must be unique, increasing, and inside the source duration");
    const boundaries = [0, ...cuts, duration];
    segments = boundaries.slice(0, -1).map((start, index) => {
      const end = boundaries[index + 1];
      const existing = source.data.videoSegments?.find((segment) => Math.abs(segment.start - start) <= .0005 && Math.abs(segment.end - end) <= .0005);
      return {
        ...(existing || {}), id: existing?.id || crypto.randomUUID(), index: index + 1, sequenceIndex: index,
        label: `Scene ${String(index + 1).padStart(2, "0")}`, role: index === 0 ? "hook" as const : index === boundaries.length - 2 ? "cta" as const : "scene" as const,
        start, end, confidence: existing?.confidence ?? 1, clipAssetId: existing?.clipAssetId, clipUrl: existing?.clipUrl,
      };
    });
  }
  const validSelection = input.outputSelection === "full" || segments.some((segment) => segment.id === input.outputSelection) ? input.outputSelection : undefined;
  if (input.outputSelection && !validSelection) throw new Error("output_selection must be full or one of the resulting segment IDs");
  return await patchMcpCanvas(principal, { projectId: input.projectId, expectedRevision: input.expectedRevision, operations: [{ type: "update_node", nodeId: source.id, data: { videoSegments: segments, videoOutputSelection: validSelection || (segments.some((segment) => segment.id === source.data.videoOutputSelection) ? source.data.videoOutputSelection : "full") } }] });
}

export async function createMcpCanvasRemakeBranch(principal: McpPrincipal, input: { projectId: string; expectedRevision: number; sourceNodeId: string; position?: { x: number; y: number } }) {
  const current = await getMcpCanvas(principal, input.projectId);
  if (current.revision !== input.expectedRevision) throw Object.assign(new Error(`Canvas changed. Read it again and use revision ${current.revision}.`), { code: "CANVAS_REVISION_CONFLICT", status: 409, currentRevision: current.revision });
  const source = current.graph.nodes.find((node) => node.id === input.sourceNodeId);
  if (!source || canvasNodeOutputType(source.data) !== "image") throw new Error("A remake branch requires an image scene");
  const nodeId = crypto.randomUUID();
  const data: FrameNodeData = {
    ...defaultCanvasNodeData("image_generator", {}), title: `Remake · ${source.data.title}`, subtitle: "Source screen connected · add an identity if needed", status: "ready",
    prompt: [`Create an original TikTok-native ${source.data.role || "scene"} image based on the connected source screen's broad visual archetype and composition rhythm.`, "The source screen is a low-weight composition reference only. Do not copy its person, face, hair, body, exact clothes, text, logos, watermark, app UI, exact room, wall colors, props or exact pose.", "Create a genuinely new moment with a different setting, outfit, action and camera angle while preserving the screen's content function.", "Use believable handheld phone-camera behavior, natural autofocus, ordinary lighting, realistic skin texture, slight compression and an imperfect crop.", "No TikTok interface, captions, competitor branding, readable logos, plastic skin, studio polish, DSLR look, duplicated limbs or extra fingers."].join(" "),
  };
  const position = input.position || { x: source.position.x + 340, y: source.position.y + 55 };
  const canvas = await patchMcpCanvas(principal, { projectId: input.projectId, expectedRevision: input.expectedRevision, operations: [
    { type: "add_node", id: nodeId, nodeType: "frameNode", position, data },
    { type: "add_edge", id: crypto.randomUUID(), source: source.id, sourceHandle: "output", target: nodeId, targetHandle: "reference-image-input", data: { portType: "image", inputRole: "reference-image" } },
  ] });
  return { canvas, node: canvas.graph.nodes.find((node) => node.id === nodeId)! };
}

export async function exportMcpVideoMasterMedia(principal: McpPrincipal, input: {
  projectId: string; nodeId: string; lane: "output" | "original"; scope: "scene" | "video"; clipId?: string;
}) {
  const workspaceId = await assertProject(principal, input.projectId);
  const canvas = await getMcpCanvas(principal, input.projectId);
  const node = canvas.graph.nodes.find((candidate) => candidate.id === input.nodeId && candidate.data.kind === "videoMaster");
  const clips = [...(node?.data.videoMasterClips || [])].sort((a, b) => Number(a.sequenceIndex || 0) - Number(b.sequenceIndex || 0));
  const selected = clips.find((clip) => clip.id === (input.clipId || node?.data.videoMasterSelectedClipId)) || clips[0];
  const targets = input.scope === "video" ? clips : selected ? [selected] : [];
  if (!node || !targets.length) throw Object.assign(new Error("Video Master scene not found"), { status: 404 });
  const requested = targets.map((clip) => {
    const sourceNode = clip.sourceNodeId ? canvas.graph.nodes.find((candidate) => candidate.id === clip.sourceNodeId) : undefined;
    const media = videoMasterClipExportMedia(clip, input.lane, sourceNode);
    const assetId = media.source?.assetId || assetIdFromAssetUrl(media.source?.url);
    if (!assetId) throw new Error(input.lane === "output" ? `Generate ${clip.title} before exporting OUTPUT` : `${clip.title} has no ORIGINAL video`);
    return { id: assetId, start: media.start, end: media.end };
  });
  const ranges = coalesceContiguousVideoAssets(requested);
  const sources: VideoMasterRenderSource[] = [];
  for (const range of ranges) {
    const row = await db.prepare("SELECT id, storage_path, mime_type FROM assets WHERE id = ?").get(range.id) as { id: string; storage_path: string; mime_type: string } | undefined;
    if (!row || !row.mime_type.startsWith("video/") || !await userCanAccessAsset(principal.userId, row.id)) throw Object.assign(new Error("One of the video scenes is no longer available"), { status: 404 });
    sources.push({ ...row, start: range.start, end: range.end });
  }
  const bytes = await renderVideoMasterExport(sources, "video-master-export.mp4");
  const id = crypto.randomUUID();
  const filename = `video-master-${input.lane}-${Date.now()}.mp4`;
  const stored = await saveBytes(bytes, `workspaces/${workspaceId}/projects/${input.projectId}/library`, filename, "video/mp4");
  try {
    await db.transaction(async () => {
      await assertWorkspaceStorageCapacity(workspaceId, stored.size);
      await db.prepare(`INSERT INTO assets (id, workspace_id, project_id, kind, role, filename, storage_path, storage_provider, storage_bucket, object_key, size_bytes, content_hash, mime_type, metadata_json, created_at)
        VALUES (?, ?, ?, 'library_video', 'library', ?, ?, ?, ?, ?, ?, ?, 'video/mp4', ?, ?)`).run(id, workspaceId, input.projectId, filename, stored.reference, stored.provider, stored.bucket, stored.key, stored.size, stored.contentHash, JSON.stringify({ source: "mcp_video_master_export", mediaType: "video", lane: input.lane, scope: input.scope, nodeId: node.id, clipCount: targets.length }), new Date().toISOString());
    })();
  } catch (error) {
    await deleteStorageObject(stored.reference).catch(() => undefined);
    throw error;
  }
  await appendAuditEvent({ workspaceId, actorUserId: principal.userId, action: "mcp.video_master.exported", targetType: "asset", targetId: id, metadata: { connectionId: principal.connectionId, projectId: input.projectId, nodeId: node.id, lane: input.lane, scope: input.scope, clipCount: targets.length } });
  return { asset: { id, projectId: input.projectId, filename, mediaType: "video", mimeType: "video/mp4", url: `/api/assets/${id}`, thumbnailUrl: `/api/assets/${id}?variant=thumbnail&delivery=direct&v=2`, sizeBytes: stored.size } };
}

async function mcpVideoSource(principal: McpPrincipal, projectId: string, sourceNodeId: string) {
  const workspaceId = await assertProject(principal, projectId);
  const canvas = await getMcpCanvas(principal, projectId);
  const node = canvas.graph.nodes.find((candidate) => candidate.id === sourceNodeId);
  const assetId = node?.data.assetId || node?.data.videoSourceAssetId || assetIdFromAssetUrl(String(node?.data.outputUrl || node?.data.imageUrl || ""));
  if (!node || node.data.mediaType !== "video" || !assetId) throw Object.assign(new Error("Source video not found"), { status: 404 });
  const source = await db.prepare("SELECT id, storage_path, mime_type FROM assets WHERE id = ?").get(assetId) as VideoDerivativeSource | undefined;
  if (!source || !source.mime_type.startsWith("video/") || !await userCanAccessAsset(principal.userId, source.id)) throw Object.assign(new Error("Source video not found"), { status: 404 });
  return { workspaceId, canvas, node, source };
}

export async function captureMcpCanvasVideoFrame(principal: McpPrincipal, input: { projectId: string; expectedRevision: number; sourceNodeId: string; time: number }) {
  const initial = await mcpVideoSource(principal, input.projectId, input.sourceNodeId);
  if (initial.canvas.revision !== input.expectedRevision) throw Object.assign(new Error(`Canvas changed. Read it again and use revision ${initial.canvas.revision}.`), { code: "CANVAS_REVISION_CONFLICT", status: 409, currentRevision: initial.canvas.revision });
  const asset = await captureVideoFrameAsset({ source: initial.source, projectId: input.projectId, workspaceId: initial.workspaceId, time: input.time });
  const current = await getMcpCanvas(principal, input.projectId);
  const sourceNode = current.graph.nodes.find((node) => node.id === input.sourceNodeId);
  if (!sourceNode) throw Object.assign(new Error("Source video changed while the frame was captured"), { status: 409 });
  const ratio = Math.max(.2, Number(sourceNode.data.videoAspectRatio || 9 / 16));
  const nodeWidth = ratio >= 1 ? 320 : 260;
  const sourceWidth = Number(sourceNode.data.nodeWidth || 580);
  const sourceHeight = Number(sourceNode.data.nodeHeight || 560);
  const prior = current.graph.nodes.filter((node) => node.data.capturedFromNodeId === sourceNode.id).length;
  const nodeId = crypto.randomUUID();
  const node: FrameNode = {
    id: nodeId, type: "frameNode",
    position: { x: sourceNode.position.x + Math.max(0, (sourceWidth - nodeWidth) / 2) + (prior % 3) * (nodeWidth + 24), y: sourceNode.position.y + sourceHeight + 64 + Math.floor(prior / 3) * (nodeWidth / ratio + 76) },
    data: {
      kind: "scene", title: `Still · ${Math.floor(asset.time / 60)}:${(asset.time % 60).toFixed(3).padStart(6, "0")}`,
      subtitle: `Captured from ${sourceNode.data.title}`, role: "scene", assetId: asset.id, imageUrl: asset.url, mediaType: "image",
      canvasMediaOrigin: "capture", capturedFromNodeId: sourceNode.id, capturedAtSeconds: asset.time, nodeWidth, createdAt: new Date().toISOString(), status: "ready",
    },
  };
  const canvas = await patchMcpCanvas(principal, { projectId: input.projectId, expectedRevision: current.revision, operations: [{ type: "add_node", id: node.id, nodeType: node.type, position: node.position, data: node.data }] });
  return { asset, canvas, node: canvas.graph.nodes.find((candidate) => candidate.id === nodeId)! };
}

export async function materializeMcpCanvasVideoSegment(principal: McpPrincipal, input: { projectId: string; expectedRevision: number; sourceNodeId: string; segmentId: string }) {
  const initial = await mcpVideoSource(principal, input.projectId, input.sourceNodeId);
  if (initial.canvas.revision !== input.expectedRevision) throw Object.assign(new Error(`Canvas changed. Read it again and use revision ${initial.canvas.revision}.`), { code: "CANVAS_REVISION_CONFLICT", status: 409, currentRevision: initial.canvas.revision });
  const segment = initial.node.data.videoSegments?.find((candidate) => candidate.id === input.segmentId);
  if (!segment) throw Object.assign(new Error("Video segment not found"), { status: 404 });
  if (segment.clipAssetId && segment.clipUrl) return { asset: { id: segment.clipAssetId, url: segment.clipUrl, durationSeconds: segment.end - segment.start }, canvas: initial.canvas };
  const asset = await materializeVideoSegmentAsset({ source: initial.source, projectId: input.projectId, workspaceId: initial.workspaceId, segmentId: segment.id, start: segment.start, end: segment.end });
  const current = await getMcpCanvas(principal, input.projectId);
  const source = current.graph.nodes.find((node) => node.id === input.sourceNodeId);
  const liveSegment = source?.data.videoSegments?.find((candidate) => candidate.id === input.segmentId);
  if (!source || !liveSegment || liveSegment.start !== segment.start || liveSegment.end !== segment.end) return { asset, canvas: current, persisted: false, reason: "Scene boundaries changed while the segment was prepared" };
  const operations: CanvasPatchOperation[] = [{ type: "update_node", nodeId: source.id, data: { videoSegments: source.data.videoSegments?.map((candidate) => candidate.id === segment.id ? { ...candidate, clipAssetId: asset.id, clipUrl: asset.url } : candidate) } }];
  for (const node of current.graph.nodes) {
    if (node.data.videoSourceNodeId === source.id && node.data.videoSegmentId === segment.id) operations.push({ type: "update_node", nodeId: node.id, data: { assetId: asset.id, imageUrl: asset.url, outputUrl: asset.url, videoClipStart: 0, videoClipEnd: asset.durationSeconds, duration: String(asset.durationSeconds), segmentMaterializing: false } });
    if (node.data.kind === "videoMaster" && node.data.videoMasterClips?.some((clip) => clip.sourceNodeId === source.id && clip.sourceSegmentId === segment.id)) operations.push({ type: "update_node", nodeId: node.id, data: { videoMasterClips: node.data.videoMasterClips.map((clip) => clip.sourceNodeId === source.id && clip.sourceSegmentId === segment.id ? { ...clip, sourceClipAssetId: asset.id, sourceClipUrl: asset.url } : clip) } });
  }
  for (const edge of current.graph.edges.filter((candidate) => candidate.source === source.id && candidate.data?.sourceSegmentId === segment.id)) {
    operations.push({ type: "remove_edge", edgeId: edge.id }, { type: "add_edge", id: edge.id, source: edge.source, sourceHandle: edge.sourceHandle, target: edge.target, targetHandle: edge.targetHandle, data: { ...edge.data, clipAssetId: asset.id, clipUrl: asset.url } });
  }
  const canvas = await patchMcpCanvas(principal, { projectId: input.projectId, expectedRevision: current.revision, operations });
  return { asset, canvas, persisted: true };
}

export async function listMcpLibraryAssets(principal: McpPrincipal, input: {
  workspaceId: string;
  projectId?: string;
  mediaType?: "all" | "image" | "video";
  search?: string;
  limit?: number;
  cursor?: string;
}, origin: string) {
  if (!principal.libraryAccess) throw Object.assign(new Error("Library access was not approved for this connection"), { status: 403 });
  await assertWorkspace(principal, input.workspaceId);
  if (input.projectId) await assertProject(principal, input.projectId);
  const projects = await listMcpCanvases(principal, input.workspaceId);
  const projectIds = input.projectId ? [input.projectId] : projects.map((project) => project.id);
  if (!projectIds.length) return { assets: [], counts: { all: 0, image: 0, video: 0 }, nextCursor: null };
  const baseValues: unknown[] = [...projectIds];
  const baseConditions = [
    `a.project_id IN (${projectIds.map(() => "?").join(",")})`,
    "((a.role = 'generated' AND a.kind IN ('generated_image', 'generated_video')) OR (a.role = 'library' AND a.kind IN ('library_image', 'library_video')))",
  ];
  const search = input.search?.trim().toLowerCase().slice(0, 120);
  if (search) {
    baseConditions.push("(lower(a.filename) LIKE ? OR lower(p.name) LIKE ? OR lower(COALESCE(a.metadata_json ->> 'originalName', '')) LIKE ?)");
    baseValues.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  const countRows = await db.prepare(`SELECT CASE WHEN a.mime_type LIKE 'video/%' THEN 'video' ELSE 'image' END AS media_type, COUNT(*) AS count
    FROM assets a JOIN projects p ON p.id = a.project_id
    WHERE ${baseConditions.join(" AND ")} GROUP BY media_type`).all(...baseValues) as Array<{ media_type: "image" | "video"; count: number }>;
  const imageCount = Number(countRows.find((row) => row.media_type === "image")?.count || 0);
  const videoCount = Number(countRows.find((row) => row.media_type === "video")?.count || 0);

  const conditions = [...baseConditions];
  const values = [...baseValues];
  if (input.mediaType === "image") conditions.push("a.mime_type LIKE 'image/%'");
  if (input.mediaType === "video") conditions.push("a.mime_type LIKE 'video/%'");
  if (input.cursor) {
    const separator = input.cursor.lastIndexOf("|");
    const cursorDate = separator > 0 ? input.cursor.slice(0, separator) : "";
    const cursorId = separator > 0 ? input.cursor.slice(separator + 1) : "";
    if (!cursorDate || !cursorId || !Number.isFinite(Date.parse(cursorDate))) {
      throw Object.assign(new Error("Invalid Library cursor"), { status: 400 });
    }
    conditions.push("(a.created_at < ? OR (a.created_at = ? AND a.id < ?))");
    values.push(cursorDate, cursorDate, cursorId);
  }
  const limit = Math.min(100, Math.max(1, Number(input.limit || 50)));
  const rows = await db.prepare(`SELECT a.id, a.project_id, p.name AS canvas_name, a.filename, a.mime_type, a.metadata_json, a.created_at, a.role, a.size_bytes,
      (SELECT g.model_id FROM generations g WHERE g.output_asset_id = a.id ORDER BY g.created_at DESC LIMIT 1) AS model_id
    FROM assets a JOIN projects p ON p.id = a.project_id
    WHERE ${conditions.join(" AND ")} ORDER BY a.created_at DESC, a.id DESC LIMIT ?`).all(...values, limit + 1) as Array<Record<string, unknown>>;
  const hasMore = rows.length > limit;
  const visibleRows = rows.slice(0, limit);
  const assets = visibleRows.map((row) => {
    let metadata: Record<string, unknown> = {};
    try { metadata = typeof row.metadata_json === "string" ? JSON.parse(row.metadata_json) : row.metadata_json as Record<string, unknown>; } catch {}
    const positiveNumber = (key: string) => {
      const value = Number(metadata[key]);
      return Number.isFinite(value) && value > 0 ? value : null;
    };
    const url = `/api/assets/${String(row.id)}`;
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      canvasName: String(row.canvas_name),
      filename: String(row.filename),
      originalName: typeof metadata.originalName === "string" ? metadata.originalName : null,
      source: row.role === "library" ? "uploaded" : "generated",
      mediaType: String(row.mime_type).startsWith("video/") ? "video" : "image",
      mimeType: String(row.mime_type),
      url: absoluteAssetUrl(origin, url),
      thumbnailUrl: absoluteAssetUrl(origin, `${url}?variant=thumbnail&delivery=direct&v=2`),
      urlAccess: "signed_in_browser",
      previewTool: "inspect_library_asset",
      sizeBytes: Number(row.size_bytes || 0) || null,
      modelId: typeof row.model_id === "string" ? row.model_id : typeof metadata.modelId === "string" ? metadata.modelId : null,
      durationSeconds: positiveNumber("durationSeconds") || positiveNumber("duration"),
      width: positiveNumber("width"),
      height: positiveNumber("height"),
      aspectRatio: positiveNumber("aspectRatio"),
      createdAt: String(row.created_at),
    };
  });
  const last = visibleRows.at(-1);
  return {
    assets,
    counts: { all: imageCount + videoCount, image: imageCount, video: videoCount },
    nextCursor: hasMore && last ? `${String(last.created_at)}|${String(last.id)}` : null,
  };
}

type McpPreviewAssetRow = {
  id: string;
  workspace_id: string;
  project_id: string | null;
  persona_id: string | null;
  filename: string;
  storage_path: string;
  object_key: string | null;
  mime_type: string;
  thumbnail_storage_path: string | null;
  thumbnail_mime_type: string | null;
  metadata_json: string;
};

function mcpSafePreviewMetadata(value: string) {
  const metadata = readAssetMetadata(value);
  const safe: Record<string, string | number> = {};
  for (const key of ["originalName", "modelId"] as const) {
    if (typeof metadata[key] === "string") safe[key] = metadata[key];
  }
  for (const key of ["durationSeconds", "duration", "width", "height", "aspectRatio", "start", "end", "time"] as const) {
    const number = Number(metadata[key]);
    if (Number.isFinite(number)) safe[key] = number;
  }
  return safe;
}

async function mcpAssetPreview(row: McpPreviewAssetRow) {
  let previewPath = row.thumbnail_storage_path;
  let previewMimeType = row.thumbnail_mime_type || "image/webp";
  let bytes: Buffer;
  if (previewPath) {
    bytes = await readStorageObject(previewPath);
  } else {
    const source = {
      id: row.id,
      workspaceId: row.workspace_id,
      personaId: row.persona_id,
      storagePath: row.storage_path,
      objectKey: row.object_key,
    };
    const thumbnail = row.mime_type.startsWith("video/")
      ? await createVideoAssetThumbnailFromStorage(source)
      : await createAssetThumbnailFromStorage(source);
    previewPath = thumbnail.stored.reference;
    previewMimeType = "image/webp";
    bytes = thumbnail.bytes;
    await db.prepare(`UPDATE assets
      SET thumbnail_storage_path = ?, thumbnail_size_bytes = ?, thumbnail_content_hash = ?, thumbnail_mime_type = 'image/webp'
      WHERE id = ?`).run(thumbnail.stored.reference, thumbnail.stored.size, thumbnail.stored.contentHash, row.id);
  }
  return {
    asset: {
      id: row.id,
      filename: row.filename,
      mediaType: row.mime_type.startsWith("video/") ? "video" as const : "image" as const,
      mimeType: row.mime_type,
      previewMimeType,
      metadata: mcpSafePreviewMetadata(row.metadata_json),
    },
    previewBase64: bytes.toString("base64"),
  };
}

export async function inspectMcpLibraryAsset(principal: McpPrincipal, input: { workspaceId: string; assetId: string }) {
  if (!principal.libraryAccess) throw Object.assign(new Error("Library access was not approved for this connection"), { status: 403 });
  await assertWorkspace(principal, input.workspaceId);
  const row = await db.prepare(`SELECT id, workspace_id, project_id, persona_id, filename, storage_path, object_key, mime_type,
      thumbnail_storage_path, thumbnail_mime_type, metadata_json
    FROM assets WHERE id = ? AND workspace_id = ? AND project_id IS NOT NULL
      AND ((role = 'generated' AND kind IN ('generated_image', 'generated_video')) OR (role = 'library' AND kind IN ('library_image', 'library_video')))`)
    .get(input.assetId, input.workspaceId) as McpPreviewAssetRow | undefined;
  if (!row || !row.project_id || !tokenAllowsProject(principal, row.project_id) || !await userCanAccessAsset(principal.userId, row.id)) {
    throw Object.assign(new Error("Library asset not found"), { status: 404 });
  }
  return mcpAssetPreview(row);
}

export async function inspectMcpIdentityReference(principal: McpPrincipal, input: { workspaceId: string; identityId: string; assetId: string }) {
  await assertWorkspace(principal, input.workspaceId);
  const row = await db.prepare(`SELECT a.id, a.workspace_id, a.project_id, a.persona_id, a.filename, a.storage_path, a.object_key, a.mime_type,
      a.thumbnail_storage_path, a.thumbnail_mime_type, a.metadata_json
    FROM assets a JOIN personas p ON p.id = a.persona_id
    WHERE a.id = ? AND a.persona_id = ? AND a.workspace_id = ? AND p.workspace_id = ?
      AND a.kind = 'persona_ref' AND a.role IN ('reference', 'before', 'after')`)
    .get(input.assetId, input.identityId, input.workspaceId, input.workspaceId) as McpPreviewAssetRow | undefined;
  if (!row) throw Object.assign(new Error("Identity reference not found"), { status: 404 });
  return mcpAssetPreview(row);
}

type McpIdentityRole = "reference" | "before" | "after";
type McpIdentityType = "single" | "before_after";

function mcpIdentityType(roles: McpIdentityRole[]): McpIdentityType {
  return roles.some((role) => role === "before" || role === "after") ? "before_after" : "single";
}

function assertMcpIdentityRoles(identityType: McpIdentityType, references: Array<{ role: McpIdentityRole }>) {
  const invalid = identityType === "single"
    ? references.some((reference) => reference.role !== "reference")
    : references.some((reference) => reference.role === "reference");
  if (invalid) {
    throw Object.assign(new Error(identityType === "single"
      ? "A single Identity accepts only Character references"
      : "A Before / After Identity accepts only Before or After references"), { status: 400 });
  }
}

export async function listMcpIdentities(principal: McpPrincipal, workspaceId: string, origin: string) {
  await assertWorkspace(principal, workspaceId);
  const personas = await db.prepare("SELECT * FROM personas WHERE workspace_id = ? ORDER BY updated_at DESC").all(workspaceId) as Array<Record<string, unknown>>;
  return await Promise.all(personas.map(async (persona) => {
    const assets = await db.prepare(`SELECT id, filename, role, sort_order, metadata_json FROM assets WHERE persona_id = ?
      ORDER BY CASE role WHEN 'reference' THEN 0 WHEN 'before' THEN 1 WHEN 'after' THEN 2 ELSE 3 END, sort_order, created_at, id`).all(persona.id) as Array<Record<string, unknown>>;
    const sourceIds = [...new Set(assets.flatMap((asset) => {
      const sourceAssetId = readAssetMetadata(String(asset.metadata_json || "{}")).sourceAssetId;
      return typeof sourceAssetId === "string" ? [sourceAssetId] : [];
    }))];
    const sourceRows = sourceIds.length
      ? await db.prepare("SELECT id, project_id FROM assets WHERE id = ANY(?::text[])").all(sourceIds) as Array<{ id: string; project_id: string | null }>
      : [];
    const accessibleSourceIds = new Set((await Promise.all(sourceRows.map(async (source) => source.project_id
      && tokenAllowsProject(principal, source.project_id)
      && await userCanAccessAsset(principal.userId, source.id) ? source.id : null))).filter((id): id is string => Boolean(id)));
    const normalizedAssets = assets.map((asset) => {
      const metadata = readAssetMetadata(String(asset.metadata_json || "{}"));
      const role: McpIdentityRole = asset.role === "before" || asset.role === "after" ? asset.role : "reference";
      const sourceAssetId = typeof metadata.sourceAssetId === "string" && accessibleSourceIds.has(metadata.sourceAssetId) ? metadata.sourceAssetId : null;
      return {
        id: String(asset.id),
        filename: String(asset.filename),
        role,
        sortOrder: Number(asset.sort_order || 0),
        sourceAssetId,
        url: absoluteAssetUrl(origin, `/api/assets/${String(asset.id)}`),
        thumbnailUrl: absoluteAssetUrl(origin, `/api/assets/${String(asset.id)}?variant=thumbnail&delivery=direct&v=2`),
        urlAccess: "signed_in_browser",
        previewTool: "inspect_identity_reference",
      };
    });
    const type = mcpIdentityType(normalizedAssets.map((asset) => asset.role));
    return {
      id: String(persona.id),
      name: String(persona.name),
      notes: String(persona.notes || ""),
      type,
      workspaceId: String(persona.workspace_id),
      createdAt: String(persona.created_at),
      updatedAt: String(persona.updated_at),
      groups: {
        character: normalizedAssets.filter((asset) => asset.role === "reference"),
        before: normalizedAssets.filter((asset) => asset.role === "before"),
        after: normalizedAssets.filter((asset) => asset.role === "after"),
      },
      assets: normalizedAssets,
    };
  }));
}

export async function createMcpIdentityFromAssets(principal: McpPrincipal, input: {
  workspaceId: string;
  name: string;
  notes?: string;
  identityType: McpIdentityType;
  references: Array<{ assetId: string; role: McpIdentityRole }>;
}, origin: string) {
  if (!principal.libraryAccess) throw Object.assign(new Error("Library access is required to create an identity from assets"), { status: 403 });
  await assertWorkspace(principal, input.workspaceId);
  if (!input.references.length || input.references.length > 100) throw new Error("Choose between 1 and 100 image references");
  assertMcpIdentityRoles(input.identityType, input.references);
  const unique = new Set(input.references.map((reference) => reference.assetId));
  if (unique.size !== input.references.length) throw new Error("Each identity reference must use a different asset");
  const rows = await db.prepare(`SELECT id, project_id, filename, storage_path, mime_type FROM assets
    WHERE workspace_id = ? AND id = ANY(?::text[])`).all(input.workspaceId, [...unique]) as Array<{ id: string; project_id: string | null; filename: string; storage_path: string; mime_type: string }>;
  const accessibleRows = await Promise.all(rows.map((row) => userCanAccessAsset(principal.userId, row.id)));
  if (rows.length !== unique.size || rows.some((row, index) => !row.mime_type.startsWith("image/") || !tokenAllowsProject(principal, row.project_id || "") || !accessibleRows[index])) {
    throw Object.assign(new Error("Every reference must be an accessible image from this workspace"), { status: 400 });
  }
  const sourceById = new Map(rows.map((row) => [row.id, row]));
  const personaId = crypto.randomUUID();
  const now = new Date().toISOString();
  const writtenStorage: string[] = [];
  const nextOrders = new Map<McpIdentityRole, number>();
  await db.prepare("INSERT INTO personas (id, workspace_id, name, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(personaId, input.workspaceId, input.name.trim().slice(0, 80), (input.notes || "").trim().slice(0, 2000), now, now);
  try {
    for (const [index, reference] of input.references.entries()) {
      const source = sourceById.get(reference.assetId)!;
      const bytes = await readStorageObject(source.storage_path);
      const assetId = crypto.randomUUID();
      const filename = `ref-${String(index + 1).padStart(3, "0")}-${assetId.slice(0, 8)}${safeExtension(source.filename, source.mime_type)}`;
      const stored = await saveBytes(bytes, `workspaces/${input.workspaceId}/personas/${personaId}`, filename, source.mime_type);
      writtenStorage.push(stored.reference);
      const { stored: thumbnail } = await createIdentityThumbnail(bytes, { id: assetId, workspaceId: input.workspaceId, personaId, storagePath: stored.reference, objectKey: stored.key });
      writtenStorage.push(thumbnail.reference);
      const sortOrder = nextOrders.get(reference.role) || 0;
      await db.transaction(async () => {
        await assertWorkspaceStorageCapacity(input.workspaceId, stored.size + thumbnail.size);
        await db.prepare(`INSERT INTO assets
          (id, workspace_id, persona_id, kind, role, sort_order, filename, storage_path, storage_provider, storage_bucket, object_key, size_bytes, content_hash,
           thumbnail_storage_path, thumbnail_size_bytes, thumbnail_content_hash, thumbnail_mime_type, mime_type, metadata_json, created_at)
          VALUES (?, ?, ?, 'persona_ref', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'image/webp', ?, ?, ?)`)
          .run(assetId, input.workspaceId, personaId, reference.role, sortOrder, filename, stored.reference, stored.provider, stored.bucket, stored.key, stored.size, stored.contentHash,
            thumbnail.reference, thumbnail.size, thumbnail.contentHash, source.mime_type, JSON.stringify({ sourceAssetId: source.id }), now);
      })();
      nextOrders.set(reference.role, sortOrder + 1);
    }
  } catch (error) {
    await db.prepare("DELETE FROM personas WHERE id = ?").run(personaId).catch(() => undefined);
    await Promise.all(writtenStorage.map((path) => deleteStorageObject(path).catch(() => undefined)));
    throw error;
  }
  await appendAuditEvent({ workspaceId: input.workspaceId, actorUserId: principal.userId, action: "mcp.identity.created", targetType: "identity", targetId: personaId, metadata: { connectionId: principal.connectionId, clientId: principal.clientId, identityType: input.identityType, referenceCount: input.references.length } });
  const identities = await listMcpIdentities(principal, input.workspaceId, origin);
  return identities.find((identity) => identity.id === personaId)!;
}

export async function addMcpIdentityReferences(principal: McpPrincipal, input: {
  workspaceId: string; identityId: string; references: Array<{ assetId: string; role: McpIdentityRole }>;
}, origin: string) {
  if (!principal.libraryAccess) throw Object.assign(new Error("Library access is required to add identity references"), { status: 403 });
  await assertWorkspace(principal, input.workspaceId);
  const persona = await db.prepare("SELECT id FROM personas WHERE id = ? AND workspace_id = ?").get(input.identityId, input.workspaceId);
  if (!persona) throw Object.assign(new Error("Identity not found"), { status: 404 });
  if (!input.references.length) throw new Error("Choose at least one image reference");
  const existingRoles = (await db.prepare("SELECT DISTINCT role FROM assets WHERE persona_id = ?").all(input.identityId) as Array<{ role: McpIdentityRole }>).map((row) => row.role);
  assertMcpIdentityRoles(mcpIdentityType(existingRoles), input.references);
  const existingCount = Number((await db.prepare("SELECT COUNT(*) AS count FROM assets WHERE persona_id = ?").get(input.identityId) as { count: number }).count || 0);
  if (existingCount + input.references.length > 100) throw new Error(`${100 - existingCount} reference slots remain`);
  const unique = new Set(input.references.map((reference) => reference.assetId));
  if (unique.size !== input.references.length) throw new Error("Each added reference must use a different asset");
  const rows = await db.prepare("SELECT id, project_id, filename, storage_path, mime_type FROM assets WHERE workspace_id = ? AND id = ANY(?::text[])")
    .all(input.workspaceId, [...unique]) as Array<{ id: string; project_id: string | null; filename: string; storage_path: string; mime_type: string }>;
  const accessibleRows = await Promise.all(rows.map((row) => userCanAccessAsset(principal.userId, row.id)));
  if (rows.length !== unique.size || rows.some((row, index) => !row.mime_type.startsWith("image/") || !tokenAllowsProject(principal, row.project_id || "") || !row.project_id || !accessibleRows[index])) throw new Error("Every reference must be an accessible Library image");
  const sourceById = new Map(rows.map((row) => [row.id, row]));
  const nextOrders = new Map<string, number>();
  for (const row of await db.prepare("SELECT role, COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM assets WHERE persona_id = ? GROUP BY role").all(input.identityId) as Array<{ role: string; next_order: number }>) nextOrders.set(row.role, Number(row.next_order));
  const written: string[] = [];
  const writtenAssetIds: string[] = [];
  try {
    for (const reference of input.references) {
      const source = sourceById.get(reference.assetId)!;
      const duplicate = await db.prepare("SELECT id FROM assets WHERE persona_id = ? AND role = ? AND metadata_json->>'sourceAssetId' = ?").get(input.identityId, reference.role, source.id);
      if (duplicate) continue;
      const bytes = await readStorageObject(source.storage_path);
      const assetId = crypto.randomUUID();
      const filename = `ref-${String(existingCount + writtenAssetIds.length + 1).padStart(3, "0")}-${assetId.slice(0, 8)}${safeExtension(source.filename, source.mime_type)}`;
      const stored = await saveBytes(bytes, `workspaces/${input.workspaceId}/personas/${input.identityId}`, filename, source.mime_type);
      written.push(stored.reference);
      const { stored: thumbnail } = await createIdentityThumbnail(bytes, { id: assetId, workspaceId: input.workspaceId, personaId: input.identityId, storagePath: stored.reference, objectKey: stored.key });
      written.push(thumbnail.reference);
      const sortOrder = nextOrders.get(reference.role) || 0;
      await db.transaction(async () => {
        await assertWorkspaceStorageCapacity(input.workspaceId, stored.size + thumbnail.size);
        await db.prepare(`INSERT INTO assets (id, workspace_id, persona_id, kind, role, sort_order, filename, storage_path, storage_provider, storage_bucket, object_key, size_bytes, content_hash, thumbnail_storage_path, thumbnail_size_bytes, thumbnail_content_hash, thumbnail_mime_type, mime_type, metadata_json, created_at)
          VALUES (?, ?, ?, 'persona_ref', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'image/webp', ?, ?, ?)`).run(assetId, input.workspaceId, input.identityId, reference.role, sortOrder, filename, stored.reference, stored.provider, stored.bucket, stored.key, stored.size, stored.contentHash, thumbnail.reference, thumbnail.size, thumbnail.contentHash, source.mime_type, JSON.stringify({ sourceAssetId: source.id }), new Date().toISOString());
      })();
      writtenAssetIds.push(assetId);
      nextOrders.set(reference.role, sortOrder + 1);
    }
  } catch (error) {
    for (const assetId of writtenAssetIds) await db.prepare("DELETE FROM assets WHERE id = ?").run(assetId).catch(() => undefined);
    await Promise.all(written.map((path) => deleteStorageObject(path).catch(() => undefined)));
    throw error;
  }
  await db.prepare("UPDATE personas SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), input.identityId);
  await appendAuditEvent({ workspaceId: input.workspaceId, actorUserId: principal.userId, action: "mcp.identity.references_added", targetType: "identity", targetId: input.identityId, metadata: { connectionId: principal.connectionId, requestedCount: input.references.length, addedCount: writtenAssetIds.length } });
  return (await listMcpIdentities(principal, input.workspaceId, origin)).find((identity) => identity.id === input.identityId)!;
}

export async function reorderMcpIdentityReferences(principal: McpPrincipal, input: { workspaceId: string; identityId: string; role: "reference" | "before" | "after"; assetIds: string[] }, origin: string) {
  await assertWorkspace(principal, input.workspaceId);
  const storedIds = (await db.prepare("SELECT id FROM assets WHERE persona_id = ? AND workspace_id = ? AND role = ? ORDER BY sort_order, created_at, id").all(input.identityId, input.workspaceId, input.role) as Array<{ id: string }>).map((asset) => asset.id);
  if (!storedIds.length) throw Object.assign(new Error("Identity reference group not found"), { status: 404 });
  const unique = new Set(input.assetIds);
  if (input.assetIds.length !== storedIds.length || unique.size !== storedIds.length || storedIds.some((id) => !unique.has(id))) throw Object.assign(new Error("References changed while reordering. Read identities again."), { status: 409 });
  await db.transaction(async () => {
    for (const [index, assetId] of input.assetIds.entries()) await db.prepare("UPDATE assets SET sort_order = ? WHERE id = ? AND persona_id = ? AND role = ?").run(index, assetId, input.identityId, input.role);
    await db.prepare("UPDATE personas SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), input.identityId);
  })();
  return (await listMcpIdentities(principal, input.workspaceId, origin)).find((identity) => identity.id === input.identityId)!;
}

export async function removeMcpIdentityReference(principal: McpPrincipal, input: { workspaceId: string; identityId: string; assetId: string }, origin: string) {
  await assertWorkspace(principal, input.workspaceId);
  const asset = await db.prepare("SELECT id, storage_path, thumbnail_storage_path FROM assets WHERE id = ? AND persona_id = ? AND workspace_id = ?").get(input.assetId, input.identityId, input.workspaceId) as { id: string; storage_path: string; thumbnail_storage_path: string | null } | undefined;
  if (!asset) throw Object.assign(new Error("Identity reference not found"), { status: 404 });
  const remaining = Number((await db.prepare("SELECT COUNT(*) AS count FROM assets WHERE persona_id = ?").get(input.identityId) as { count: number }).count || 0);
  if (remaining <= 1) throw new Error("An identity needs at least one reference");
  await db.transaction(async () => {
    await enqueueStorageDeletion(asset.storage_path, input.workspaceId, "mcp-identity-reference-deleted");
    await enqueueStorageDeletion(asset.thumbnail_storage_path, input.workspaceId, "mcp-identity-thumbnail-deleted");
    await db.prepare("DELETE FROM assets WHERE id = ?").run(asset.id);
    await db.prepare("UPDATE personas SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), input.identityId);
    await appendAuditEvent({ workspaceId: input.workspaceId, actorUserId: principal.userId, action: "mcp.identity.reference_deleted", targetType: "identity_reference", targetId: asset.id, metadata: { identityId: input.identityId, connectionId: principal.connectionId } });
  })();
  return (await listMcpIdentities(principal, input.workspaceId, origin)).find((identity) => identity.id === input.identityId)!;
}

export async function listMcpAutomationWorkflows(principal: McpPrincipal, projectId: string) {
  const workspaceId = await assertProject(principal, projectId);
  const workflows = await listAutomationWorkflows(principal.userId, projectId);
  if (!workflows) throw Object.assign(new Error("Canvas not found"), { status: 404 });
  const capabilities = await automationCapabilitiesForWorkspace(principal.userId, workspaceId);
  return capabilities.edit || capabilities.publish ? workflows : workflows
    .filter((workflow) => workflow.status === "system" || Boolean(workflow.publishedVersionId))
    .map((workflow) => ({ ...workflow, status: workflow.status === "system" ? "system" as const : "published" as const, draftVersionId: null }));
}

export async function getMcpAutomationWorkflow(principal: McpPrincipal, workflowId: string) {
  const detail = await getAutomationWorkflow(principal.userId, workflowId);
  if (!detail || !tokenAllowsWorkspace(principal, detail.workflow.workspaceId)) throw Object.assign(new Error("Automation workflow not found"), { status: 404 });
  if (detail.workflow.projectId) await assertProject(principal, detail.workflow.projectId);
  else await assertWorkspace(principal, detail.workflow.workspaceId);
  const capabilities = await automationCapabilitiesForWorkspace(principal.userId, detail.workflow.workspaceId);
  const canViewDraft = capabilities.edit || capabilities.publish;
  if (!canViewDraft && !detail.published) throw Object.assign(new Error("Automation workflow not found"), { status: 404 });
  const visible = canViewDraft ? detail : { ...detail, draft: null };
  return {
    ...visible,
    draftRunInputs: visible.draft ? automationRunInputFields(visible.draft.graph) : [],
    publishedRunInputs: visible.published ? automationRunInputFields(visible.published.graph) : [],
  };
}

export async function createMcpAutomationWorkflow(principal: McpPrincipal, input: { projectId: string; name: string; description?: string; sourceWorkflowId?: string }) {
  await assertProject(principal, input.projectId);
  if (input.sourceWorkflowId) await getMcpAutomationWorkflow(principal, input.sourceWorkflowId);
  const detail = await createAutomationWorkflow({ userId: principal.userId, ...input });
  if (!detail) throw Object.assign(new Error("Workflow source or canvas not found"), { status: 404 });
  return detail;
}

export async function saveMcpAutomationWorkflow(principal: McpPrincipal, input: {
  workflowId: string;
  baseDraftVersionId: string | null;
  graph: AutomationWorkflowGraph;
  name?: string;
  description?: string;
  changeNote?: string;
}) {
  await getMcpAutomationWorkflow(principal, input.workflowId);
  const detail = await saveAutomationWorkflowDraft({ userId: principal.userId, ...input }).catch((error) => {
    if (error instanceof Error && error.name === "AutomationWorkflowDraftConflictError") {
      throw Object.assign(error, { code: "AUTOMATION_DRAFT_CONFLICT", status: 409 });
    }
    throw error;
  });
  if (!detail) throw Object.assign(new Error("Automation workflow not found"), { status: 404 });
  return detail;
}

async function mcpEditableAutomationDraft(principal: McpPrincipal, workflowId: string, baseDraftVersionId: string) {
  const detail = await getMcpAutomationWorkflow(principal, workflowId);
  if (detail.workflow.status === "system") {
    throw Object.assign(new Error("System workflows cannot be edited. Duplicate the workflow first."), { code: "SYSTEM_WORKFLOW_READ_ONLY", status: 409 });
  }
  if (!detail.draft) {
    throw Object.assign(new Error("Workflow has no editable draft. Duplicate it or create a new draft before editing."), { code: "AUTOMATION_DRAFT_MISSING", status: 409 });
  }
  if (detail.draft.id !== baseDraftVersionId) {
    throw Object.assign(new Error("Workflow draft changed. Read get_automation_workflow again and repeat the intended edit on the current draft."), {
      code: "AUTOMATION_DRAFT_CONFLICT",
      status: 409,
      currentDraftVersionId: detail.draft.id,
    });
  }
  return { detail, graph: structuredClone(detail.draft.graph) };
}

async function saveMcpEditedAutomationDraft(principal: McpPrincipal, input: {
  workflowId: string;
  baseDraftVersionId: string;
  graph: AutomationWorkflowGraph;
  changeNote: string;
}) {
  return await saveMcpAutomationWorkflow(principal, {
    workflowId: input.workflowId,
    baseDraftVersionId: input.baseDraftVersionId,
    graph: input.graph,
    changeNote: input.changeNote,
  });
}

export async function addMcpAutomationNode(principal: McpPrincipal, input: {
  workflowId: string;
  baseDraftVersionId: string;
  type: string;
  version?: number;
  nodeId?: string;
  name?: string;
  description?: string;
  position: { x: number; y: number };
  groupId?: string | null;
  config?: Record<string, unknown>;
  bindings?: Record<string, AutomationBinding>;
  disabled?: boolean;
}) {
  const { graph } = await mcpEditableAutomationDraft(principal, input.workflowId, input.baseDraftVersionId);
  const nodeId = input.nodeId || crypto.randomUUID();
  if (graph.nodes.some((node) => node.id === nodeId)) {
    throw Object.assign(new Error(`Node id ${nodeId} already exists`), { code: "DUPLICATE_NODE_ID", status: 409 });
  }
  if (input.groupId && !graph.groups.some((group) => group.id === input.groupId)) {
    throw Object.assign(new Error(`Group ${input.groupId} does not exist`), { code: "AUTOMATION_GROUP_NOT_FOUND", status: 404 });
  }
  const node = createAutomationNodeTemplate({
    id: nodeId,
    type: input.type,
    version: input.version,
    name: input.name,
    description: input.description,
    position: input.position,
    groupId: input.groupId,
    config: input.config,
    bindings: input.bindings,
    disabled: input.disabled,
  });
  graph.nodes.push(node);
  if (input.groupId) {
    const group = graph.groups.find((candidate) => candidate.id === input.groupId)!;
    group.nodeIds = [...new Set([...group.nodeIds, node.id])];
  }
  const workflow = await saveMcpEditedAutomationDraft(principal, {
    workflowId: input.workflowId,
    baseDraftVersionId: input.baseDraftVersionId,
    graph,
    changeNote: `MCP added ${node.type}@${node.version} (${node.id})`,
  });
  return { workflow, node };
}

export async function configureMcpAutomationNode(principal: McpPrincipal, input: {
  workflowId: string;
  baseDraftVersionId: string;
  nodeId: string;
  name?: string;
  description?: string;
  position?: { x: number; y: number };
  groupId?: string | null;
  config?: Record<string, unknown>;
  removeConfigFields?: string[];
  bindings?: Record<string, AutomationBinding | null>;
  disabled?: boolean;
}) {
  const { graph } = await mcpEditableAutomationDraft(principal, input.workflowId, input.baseDraftVersionId);
  const index = graph.nodes.findIndex((node) => node.id === input.nodeId);
  if (index === -1) throw Object.assign(new Error("Automation node not found"), { code: "AUTOMATION_NODE_NOT_FOUND", status: 404 });
  const current = graph.nodes[index];
  if (input.groupId && !graph.groups.some((group) => group.id === input.groupId)) {
    throw Object.assign(new Error(`Group ${input.groupId} does not exist`), { code: "AUTOMATION_GROUP_NOT_FOUND", status: 404 });
  }
  const config = { ...current.config, ...structuredClone(input.config || {}) };
  for (const field of input.removeConfigFields || []) delete config[field];
  const bindings = structuredClone(current.bindings);
  for (const [field, binding] of Object.entries(input.bindings || {})) {
    if (binding === null) delete bindings[field];
    else bindings[field] = binding;
  }
  const next = {
    ...current,
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.description !== undefined ? { description: input.description.trim() } : {}),
    ...(input.position !== undefined ? { position: input.position } : {}),
    ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
    ...(input.disabled !== undefined ? { disabled: input.disabled } : {}),
    config,
    bindings,
  };
  graph.nodes[index] = next;
  if (input.groupId !== undefined && input.groupId !== current.groupId) {
    for (const group of graph.groups) group.nodeIds = group.nodeIds.filter((id) => id !== current.id);
    if (input.groupId) graph.groups.find((group) => group.id === input.groupId)!.nodeIds.push(current.id);
  }
  const workflow = await saveMcpEditedAutomationDraft(principal, {
    workflowId: input.workflowId,
    baseDraftVersionId: input.baseDraftVersionId,
    graph,
    changeNote: `MCP configured ${current.type}@${current.version} (${current.id})`,
  });
  return { workflow, node: workflow.draft?.graph.nodes.find((node) => node.id === current.id) || next };
}

export async function setMcpAutomationRunInput(principal: McpPrincipal, input: {
  workflowId: string;
  baseDraftVersionId: string;
  nodeId: string;
  fieldId: string;
  mode: "fixed" | "optional" | "required";
  label?: string;
  fixedValue?: unknown;
}) {
  const { graph } = await mcpEditableAutomationDraft(principal, input.workflowId, input.baseDraftVersionId);
  const node = graph.nodes.find((candidate) => candidate.id === input.nodeId);
  if (!node) throw Object.assign(new Error("Automation node not found"), { code: "AUTOMATION_NODE_NOT_FOUND", status: 404 });
  const definition = automationNodeDefinition(node.type, node.version);
  const field = definition?.fields.find((candidate) => candidate.id === input.fieldId);
  if (!field) throw Object.assign(new Error(`Setting ${input.fieldId} does not exist on ${node.type}@${node.version}`), { code: "UNKNOWN_NODE_SETTING", status: 400 });
  if (!field.runtimeBindable) throw Object.assign(new Error(`${field.label} cannot appear in Run inputs`), { code: "SETTING_NOT_RUNTIME_BINDABLE", status: 400 });
  if (input.mode === "optional" && (field.required || field.requiredWhenVisible)) {
    throw Object.assign(new Error(`${field.label} must be a required run input when it appears in the sidebar`), { code: "REQUIRED_BINDING_OPTIONAL", status: 400 });
  }
  const currentBinding = node.bindings[field.id];
  const currentValue = input.fixedValue !== undefined
    ? input.fixedValue
    : currentBinding?.value ?? node.config[field.id] ?? field.defaultValue;
  if (input.mode === "fixed") {
    delete node.bindings[field.id];
    node.config[field.id] = structuredClone(currentValue);
  } else {
    node.bindings[field.id] = {
      mode: "ask-on-run",
      value: structuredClone(currentValue),
      label: input.label?.trim() || field.label,
      required: Boolean(field.required || field.requiredWhenVisible || input.mode === "required"),
    };
  }
  const workflow = await saveMcpEditedAutomationDraft(principal, {
    workflowId: input.workflowId,
    baseDraftVersionId: input.baseDraftVersionId,
    graph,
    changeNote: `MCP set ${node.id}.${field.id} run input mode to ${input.mode}`,
  });
  const runInput = workflow.draft ? automationRunInputFields(workflow.draft.graph).find((candidate) => candidate.key === `${node.id}.${field.id}`) || null : null;
  return {
    workflow,
    sidebar: {
      visible: input.mode !== "fixed",
      mode: input.mode,
      key: `${node.id}.${field.id}`,
      runInput,
    },
  };
}

export async function connectMcpAutomationNodes(principal: McpPrincipal, input: {
  workflowId: string;
  baseDraftVersionId: string;
  edgeId?: string;
  sourceNodeId: string;
  sourcePort: string;
  targetNodeId: string;
  targetPort: string;
  role: "flow" | "data" | "error" | "retry";
}) {
  const { graph } = await mcpEditableAutomationDraft(principal, input.workflowId, input.baseDraftVersionId);
  const edge = {
    id: input.edgeId || crypto.randomUUID(),
    source: input.sourceNodeId,
    sourcePort: input.sourcePort,
    target: input.targetNodeId,
    targetPort: input.targetPort,
    role: input.role,
  };
  if (graph.edges.some((candidate) => candidate.id === edge.id)) {
    throw Object.assign(new Error(`Connection id ${edge.id} already exists`), { code: "DUPLICATE_EDGE_ID", status: 409 });
  }
  const validation = validateAutomationConnection(graph, edge);
  if (!validation.valid) {
    throw Object.assign(new Error(validation.issues.map((issue) => `${issue.code}: ${issue.message}`).join(" ")), {
      code: "INVALID_AUTOMATION_CONNECTION",
      status: 400,
      validation,
    });
  }
  graph.edges.push(edge);
  const workflow = await saveMcpEditedAutomationDraft(principal, {
    workflowId: input.workflowId,
    baseDraftVersionId: input.baseDraftVersionId,
    graph,
    changeNote: `MCP connected ${edge.source}:${edge.sourcePort} to ${edge.target}:${edge.targetPort}`,
  });
  return { workflow, edge };
}

export async function removeMcpAutomationConnection(principal: McpPrincipal, input: {
  workflowId: string;
  baseDraftVersionId: string;
  edgeId: string;
}) {
  const { graph } = await mcpEditableAutomationDraft(principal, input.workflowId, input.baseDraftVersionId);
  const edge = graph.edges.find((candidate) => candidate.id === input.edgeId);
  if (!edge) throw Object.assign(new Error("Automation connection not found"), { code: "AUTOMATION_CONNECTION_NOT_FOUND", status: 404 });
  graph.edges = graph.edges.filter((candidate) => candidate.id !== edge.id);
  const workflow = await saveMcpEditedAutomationDraft(principal, {
    workflowId: input.workflowId,
    baseDraftVersionId: input.baseDraftVersionId,
    graph,
    changeNote: `MCP removed connection ${edge.id}`,
  });
  return { workflow, removedEdgeId: edge.id };
}

export async function removeMcpAutomationNode(principal: McpPrincipal, input: {
  workflowId: string;
  baseDraftVersionId: string;
  nodeId: string;
}) {
  const { graph } = await mcpEditableAutomationDraft(principal, input.workflowId, input.baseDraftVersionId);
  const node = graph.nodes.find((candidate) => candidate.id === input.nodeId);
  if (!node) throw Object.assign(new Error("Automation node not found"), { code: "AUTOMATION_NODE_NOT_FOUND", status: 404 });
  graph.nodes = graph.nodes.filter((candidate) => candidate.id !== node.id);
  const removedEdgeIds = graph.edges.filter((edge) => edge.source === node.id || edge.target === node.id).map((edge) => edge.id);
  graph.edges = graph.edges.filter((edge) => edge.source !== node.id && edge.target !== node.id);
  for (const group of graph.groups) group.nodeIds = group.nodeIds.filter((id) => id !== node.id);
  const workflow = await saveMcpEditedAutomationDraft(principal, {
    workflowId: input.workflowId,
    baseDraftVersionId: input.baseDraftVersionId,
    graph,
    changeNote: `MCP removed ${node.type}@${node.version} (${node.id})`,
  });
  return { workflow, removedNodeId: node.id, removedEdgeIds };
}

export async function configureMcpAutomationWorkflow(principal: McpPrincipal, input: {
  workflowId: string;
  baseDraftVersionId: string;
  settings?: Partial<AutomationWorkflowSettings>;
  viewport?: { x: number; y: number; zoom: number };
  name?: string;
  description?: string;
}) {
  const { graph } = await mcpEditableAutomationDraft(principal, input.workflowId, input.baseDraftVersionId);
  if (input.settings) graph.settings = { ...DEFAULT_AUTOMATION_WORKFLOW_SETTINGS, ...graph.settings, ...input.settings };
  if (input.viewport) graph.viewport = input.viewport;
  return await saveMcpAutomationWorkflow(principal, {
    workflowId: input.workflowId,
    baseDraftVersionId: input.baseDraftVersionId,
    graph,
    name: input.name,
    description: input.description,
    changeNote: "MCP configured workflow settings",
  });
}

export async function publishMcpAutomationWorkflow(principal: McpPrincipal, workflowId: string) {
  await getMcpAutomationWorkflow(principal, workflowId);
  const result = await publishAutomationWorkflow(principal.userId, workflowId);
  if (!result) throw Object.assign(new Error("Automation workflow has no draft to publish"), { status: 409 });
  return result;
}

export async function listMcpAutomationRuns(principal: McpPrincipal, input: { projectId: string; workflowId?: string; before?: string; limit?: number }) {
  await assertProject(principal, input.projectId);
  const runs = await listAutomationWorkflowRuns({ userId: principal.userId, ...input });
  if (!runs) throw Object.assign(new Error("Canvas not found"), { status: 404 });
  return runs;
}

export async function getMcpAutomationRun(principal: McpPrincipal, runId: string) {
  const run = await getAutomationWorkflowRun(principal.userId, runId);
  if (!run) throw Object.assign(new Error("Automation run not found"), { status: 404 });
  await assertProject(principal, run.projectId);
  const captured = await db.prepare("SELECT input_json, input_snapshot_json FROM automation_runs WHERE id = ? AND user_id = ?")
    .get(runId, principal.userId) as { input_json: unknown; input_snapshot_json: unknown } | undefined;
  const parseJson = (value: unknown) => typeof value === "string" ? JSON.parse(value) as unknown : value;
  const nodeIds = [...new Set(run.nodeRuns.map((nodeRun) => nodeRun.nodeId))];
  const nodeRunDetails = (await Promise.all(nodeIds.map((nodeId) => getAutomationWorkflowNodeRunDetails(principal.userId, runId, nodeId))))
    .flatMap((details) => details || []);
  return {
    ...run,
    runtimeInputs: parseJson(captured?.input_json || {}) as Record<string, unknown>,
    inputSnapshot: parseJson(captured?.input_snapshot_json || {}) as Record<string, unknown>,
    nodeRunDetails,
  };
}

export async function runMcpAutomationWorkflow(principal: McpPrincipal, input: { projectId: string; workflowId: string; inputs?: Record<string, unknown>; mode?: "production" | "test" }) {
  await assertProject(principal, input.projectId);
  await getMcpAutomationWorkflow(principal, input.workflowId);
  const result = await enqueueAutomationWorkflowRun({ userId: principal.userId, projectId: input.projectId, workflowId: input.workflowId, runtimeInputs: input.inputs || {}, mode: input.mode || "production" });
  if (!("runId" in result)) throw Object.assign(new Error(result.error), {
    status: result.status,
    ...(typeof (result as { code?: unknown }).code === "string" ? { code: (result as { code: string }).code } : {}),
    ...((result as { validation?: unknown }).validation ? { validation: (result as { validation: unknown }).validation } : {}),
  });
  return result;
}

export async function cancelMcpAutomationRun(principal: McpPrincipal, runId: string) {
  await getMcpAutomationRun(principal, runId);
  if (!await cancelAutomationWorkflowRun(principal.userId, runId)) throw Object.assign(new Error("Automation run is already complete or unavailable"), { status: 409 });
  return { cancelled: true, runId };
}

export async function listMcpAutomationTriggers(principal: McpPrincipal, workflowId: string) {
  await getMcpAutomationWorkflow(principal, workflowId);
  const triggers = await listAutomationWorkflowTriggers(principal.userId, workflowId);
  if (!triggers) throw Object.assign(new Error("Automation workflow not found"), { status: 404 });
  return triggers;
}

export async function listMcpAutomationTriggerDeliveries(principal: McpPrincipal, input: {
  projectId: string;
  workflowId?: string;
  triggerId?: string;
  status?: AutomationTriggerDeliveryStatus;
  limit?: number;
}) {
  await assertProject(principal, input.projectId);
  const deliveries = await listAutomationTriggerDeliveries({ userId: principal.userId, ...input });
  if (!deliveries) throw Object.assign(new Error("Canvas not found"), { status: 404 });
  return deliveries;
}

export async function replayMcpAutomationTriggerDelivery(principal: McpPrincipal, deliveryId: string) {
  const owner = await db.prepare("SELECT project_id FROM automation_trigger_deliveries WHERE id = ?")
    .get(deliveryId) as { project_id: string } | undefined;
  if (!owner) throw Object.assign(new Error("Automation trigger delivery not found"), { status: 404 });
  await assertProject(principal, owner.project_id);
  const delivery = await replayAutomationTriggerDelivery({ userId: principal.userId, deliveryId });
  if (!delivery) throw Object.assign(new Error("Automation trigger delivery not found"), { status: 404 });
  await appendAuditEvent({
    workspaceId: delivery.workspaceId,
    actorUserId: principal.userId,
    action: "automation.trigger_delivery.replayed",
    targetType: "automation_trigger_delivery",
    targetId: deliveryId,
    metadata: {
      replayDeliveryId: delivery.id,
      workflowId: delivery.workflowId,
      mcpConnectionId: principal.connectionId,
      mcpClientId: principal.clientId,
    },
  });
  return delivery;
}

export async function createMcpAutomationTrigger(principal: McpPrincipal, input: {
  workflowId: string;
  projectId: string;
  type: AutomationTriggerType;
  name: string;
  overlapPolicy?: AutomationOverlapPolicy;
  maxConcurrentRuns?: number;
  config: Record<string, unknown>;
  inputs: Record<string, unknown>;
}, origin: string) {
  const detail = await getMcpAutomationWorkflow(principal, input.workflowId);
  await assertProject(principal, input.projectId);
  if (detail.workflow.projectId && detail.workflow.projectId !== input.projectId) {
    throw Object.assign(new Error("Trigger canvas must match the workflow canvas"), { code: "TRIGGER_CANVAS_MISMATCH", status: 400 });
  }
  const result = await createAutomationWorkflowTrigger({ userId: principal.userId, ...input });
  if (!result) throw Object.assign(new Error("Publish the workflow before adding an automatic trigger"), { code: "TRIGGER_VERSION_MISSING", status: 409 });
  return {
    trigger: result.trigger,
    ...(result.token ? {
      webhookUrl: new URL(`/api/automation-webhooks/${encodeURIComponent(result.trigger.id)}/${encodeURIComponent(result.token)}`, origin).toString(),
      webhookSecretNotice: "This authenticated webhook URL is returned only now. Store it securely; Scenelith does not reveal the token again.",
    } : {}),
  };
}

async function mcpAutomationTriggerOwner(principal: McpPrincipal, triggerId: string) {
  const row = await db.prepare("SELECT workflow_id, project_id FROM automation_workflow_triggers WHERE id = ?").get(triggerId) as { workflow_id: string; project_id: string } | undefined;
  if (!row) throw Object.assign(new Error("Automation trigger not found"), { status: 404 });
  await assertProject(principal, row.project_id);
  await getMcpAutomationWorkflow(principal, row.workflow_id);
  return row;
}

export async function setMcpAutomationTriggerStatus(principal: McpPrincipal, triggerId: string, status: "active" | "paused") {
  await mcpAutomationTriggerOwner(principal, triggerId);
  const result = await setAutomationWorkflowTriggerStatus(principal.userId, triggerId, status);
  if (!result) throw Object.assign(new Error("Automation trigger not found"), { status: 404 });
  return result;
}

export async function deleteMcpAutomationTrigger(principal: McpPrincipal, triggerId: string) {
  await mcpAutomationTriggerOwner(principal, triggerId);
  const result = await deleteAutomationWorkflowTrigger(principal.userId, triggerId);
  if (!result) throw Object.assign(new Error("Automation trigger not found"), { status: 404 });
  return { id: result.id, deleted: true };
}

export async function listMcpAutomationDeploymentBindings(principal: McpPrincipal, workflowId: string) {
  const detail = await getMcpAutomationWorkflow(principal, workflowId);
  const capabilities = await automationCapabilitiesForWorkspace(principal.userId, detail.workflow.workspaceId);
  const revealCredentialMetadata = principal.scopes.includes("automation:credentials") && capabilities.manageCredentials;
  const bindings = await db.prepare(`SELECT binding.slot_key AS "slotKey", binding.binding_type AS type,
    binding.credential_id AS "credentialId", credential.name AS "credentialName", credential.kind AS "credentialKind",
    binding.target_workflow_id AS "targetWorkflowId", target.name AS "targetWorkflowName"
    FROM automation_workflow_bindings binding
    LEFT JOIN automation_credentials credential ON credential.id = binding.credential_id
    LEFT JOIN automation_workflows target ON target.id = binding.target_workflow_id
    WHERE binding.workflow_id = ? ORDER BY binding.slot_key`).all(workflowId) as Array<Record<string, unknown>>;
  return bindings.map((binding) => binding.type === "credential" && !revealCredentialMetadata
    ? { slotKey: binding.slotKey, type: "credential", credentialConnected: true }
    : binding);
}

export async function listMcpAutomationCredentials(principal: McpPrincipal, workspaceId: string) {
  await assertWorkspace(principal, workspaceId);
  const credentials = await listAutomationCredentials(principal.userId, workspaceId);
  if (!credentials) throw Object.assign(new Error("Workspace not found"), { status: 404 });
  return credentials;
}

export async function bindMcpAutomationCredential(principal: McpPrincipal, input: { workflowId: string; slotKey: string; credentialId: string }) {
  const detail = await getMcpAutomationWorkflow(principal, input.workflowId);
  const binding = await bindAutomationCredential({
    userId: principal.userId,
    workflowId: input.workflowId,
    workspaceId: detail.workflow.workspaceId,
    slotKey: input.slotKey,
    credentialId: input.credentialId,
  });
  if (!binding) throw Object.assign(new Error("Workflow or credential not found"), { status: 404 });
  return binding;
}

export async function bindMcpAutomationSubworkflow(principal: McpPrincipal, input: { workflowId: string; slotKey: string; targetWorkflowId: string }) {
  const source = await getMcpAutomationWorkflow(principal, input.workflowId);
  const target = await getMcpAutomationWorkflow(principal, input.targetWorkflowId);
  if (source.workflow.workspaceId !== target.workflow.workspaceId) {
    throw Object.assign(new Error("Child workflow must belong to the same workspace"), { code: "SUBWORKFLOW_UNAVAILABLE", status: 400 });
  }
  const binding = await bindAutomationSubworkflow({
    userId: principal.userId,
    workflowId: input.workflowId,
    workspaceId: source.workflow.workspaceId,
    slotKey: input.slotKey,
    targetWorkflowId: input.targetWorkflowId,
  });
  if (!binding) throw Object.assign(new Error("Workflow not found"), { status: 404 });
  return binding;
}

export async function unbindMcpAutomationDeploymentSlot(principal: McpPrincipal, input: { workflowId: string; slotKey: string }) {
  const detail = await getMcpAutomationWorkflow(principal, input.workflowId);
  const existing = await db.prepare("SELECT binding_type FROM automation_workflow_bindings WHERE workflow_id = ? AND workspace_id = ? AND slot_key = ?")
    .get(input.workflowId, detail.workflow.workspaceId, input.slotKey) as { binding_type: "credential" | "subworkflow" } | undefined;
  if (existing?.binding_type === "credential" && !principal.scopes.includes("automation:credentials")) {
    throw Object.assign(new Error("This OAuth connection was not approved to change credential bindings"), { code: "MCP_SCOPE_REQUIRED", scope: "automation:credentials", status: 403 });
  }
  const result = await unbindAutomationWorkflowSlot({
    userId: principal.userId,
    workflowId: input.workflowId,
    workspaceId: detail.workflow.workspaceId,
    slotKey: input.slotKey,
  });
  if (!result) throw Object.assign(new Error("Workflow not found"), { status: 404 });
  return result;
}

export async function listMcpAutomationVersions(principal: McpPrincipal, workflowId: string) {
  await getMcpAutomationWorkflow(principal, workflowId);
  const versions = await listAutomationWorkflowVersions(principal.userId, workflowId);
  if (!versions) throw Object.assign(new Error("Automation workflow not found"), { status: 404 });
  return versions;
}

export async function restoreMcpAutomationVersion(principal: McpPrincipal, workflowId: string, versionId: string) {
  await getMcpAutomationWorkflow(principal, workflowId);
  const workflow = await restoreAutomationWorkflowVersion({ userId: principal.userId, workflowId, versionId });
  if (!workflow) throw Object.assign(new Error("Automation workflow or version not found"), { status: 404 });
  return workflow;
}

export async function exportMcpAutomationWorkflow(principal: McpPrincipal, workflowId: string, version: "published" | "draft") {
  await getMcpAutomationWorkflow(principal, workflowId);
  const result = await exportAutomationWorkflowPackage({ userId: principal.userId, workflowId, version });
  if (!result) throw Object.assign(new Error("Automation workflow not found"), { status: 404 });
  if ("error" in result) throw Object.assign(new Error(result.error), { code: "AUTOMATION_VERSION_MISSING", status: 409 });
  return result;
}

export async function importMcpAutomationWorkflow(principal: McpPrincipal, projectId: string, packageValue: unknown) {
  await assertProject(principal, projectId);
  const result = await importAutomationWorkflowPackage({ userId: principal.userId, projectId, package: packageValue });
  if (!result) throw Object.assign(new Error("Canvas not found"), { status: 404 });
  return result;
}

export async function archiveMcpAutomationWorkflow(principal: McpPrincipal, workflowId: string) {
  await getMcpAutomationWorkflow(principal, workflowId);
  const result = await archiveAutomationWorkflow(principal.userId, workflowId);
  if (!result) throw Object.assign(new Error("Automation workflow not found or protected"), { status: 404 });
  return result;
}

export async function setMcpSystemAutomationModel(principal: McpPrincipal, input: { workflowId: string; nodeId: string; modelId: string | null }) {
  await getMcpAutomationWorkflow(principal, input.workflowId);
  const workflow = await setSystemAutomationModelOverride({ userId: principal.userId, workflowId: input.workflowId, nodeId: input.nodeId, modelId: input.modelId });
  if (!workflow) throw Object.assign(new Error("System workflow or editable model setting not found"), { status: 404 });
  return workflow;
}

export async function listMcpAutomationFixtures(principal: McpPrincipal, workflowId: string) {
  await getMcpAutomationWorkflow(principal, workflowId);
  const fixtures = await listAutomationWorkflowFixtures(principal.userId, workflowId);
  if (!fixtures) throw Object.assign(new Error("Automation workflow not found"), { status: 404 });
  return fixtures;
}

export async function createMcpAutomationFixture(principal: McpPrincipal, input: {
  workflowId: string; name: string; runtimeInputs?: Record<string, unknown>; nodeInputs?: Record<string, Record<string, unknown>>; sourceRunId?: string; sourceNodeId?: string;
}) {
  await getMcpAutomationWorkflow(principal, input.workflowId);
  if (input.sourceRunId) await getMcpAutomationRun(principal, input.sourceRunId);
  const fixture = await createAutomationWorkflowFixture({ userId: principal.userId, workflowId: input.workflowId, value: {
    name: input.name, runtimeInputs: input.runtimeInputs || {}, nodeInputs: input.nodeInputs || {}, sourceRunId: input.sourceRunId, sourceNodeId: input.sourceNodeId,
  } });
  if (!fixture) throw Object.assign(new Error("Automation workflow not found"), { status: 404 });
  return fixture;
}

export async function deleteMcpAutomationFixture(principal: McpPrincipal, workflowId: string, fixtureId: string) {
  await getMcpAutomationWorkflow(principal, workflowId);
  const result = await deleteAutomationWorkflowFixture({ userId: principal.userId, workflowId, fixtureId });
  if (!result) throw Object.assign(new Error("Automation workflow not found"), { status: 404 });
  return result;
}

export async function previewMcpAutomationNode(principal: McpPrincipal, input: { workflowId: string; fixtureId: string; nodeId: string }) {
  await getMcpAutomationWorkflow(principal, input.workflowId);
  const result = await enqueueAutomationNodePreview({ userId: principal.userId, ...input });
  if (!result) throw Object.assign(new Error("Automation fixture not found"), { status: 404 });
  return result;
}

export async function retryMcpAutomationRun(principal: McpPrincipal, runId: string, nodeId: string) {
  await getMcpAutomationRun(principal, runId);
  const result = await retryAutomationWorkflowRun({ userId: principal.userId, runId, nodeId });
  if (!("runId" in result)) {
    const failure = result as unknown as { status: number; error: string; code?: unknown };
    throw Object.assign(new Error(failure.error), {
      status: failure.status,
      ...(typeof failure.code === "string" ? { code: failure.code } : {}),
    });
  }
  return result;
}
