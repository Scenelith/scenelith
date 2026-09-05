import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { automationWorkflowGraphSchema } from "@/lib/automation-workflows/types";
import {
  getAutomationCapabilities,
  diagnoseAutomationRun,
  inspectAutomationConnection,
  inspectAutomationWorkflowGraph,
  SCENELITH_AUTOMATION_GUIDE,
} from "@/lib/mcp/automation";
import { SCENELITH_AGENT_GUIDE, SCENELITH_MCP_INSTRUCTIONS, scenelithConnectionAccess } from "@/lib/mcp/discovery";
import { principalHasScope, type McpPrincipal } from "@/lib/mcp/oauth";
import {
  archiveMcpAutomationWorkflow,
  attachMcpCanvasReference,
  addMcpVideoMasterAsset,
  addMcpVideoMasterScene,
  addMcpIdentityReferences,
  addMcpAutomationNode,
  bindMcpAutomationCredential,
  bindMcpAutomationSubworkflow,
  cancelMcpAutomationRun,
  cancelMcpCanvasGeneration,
  captureMcpCanvasVideoFrame,
  createMcpAutomationFixture,
  createMcpAutomationWorkflow,
  createMcpAutomationTrigger,
  createMcpCanvas,
  createMcpCanvasNode,
  createMcpCanvasRemakeBranch,
  createMcpCanvasSegmentNode,
  createMcpVideoMaster,
  createMcpIdentityFromAssets,
  configureMcpCanvasNode,
  configureMcpAutomationNode,
  configureMcpAutomationWorkflow,
  configureMcpVideoMasterClip,
  composeMcpCanvasPrompt,
  connectMcpCanvasNodes,
  connectMcpAutomationNodes,
  duplicateMcpCanvasNodes,
  downloadMcpCanvasNodeOutput,
  detachMcpCanvasReference,
  deleteMcpAutomationFixture,
  editMcpCanvasImage,
  exportMcpAutomationWorkflow,
  exportMcpCanvasDocument,
  exportMcpVideoMasterMedia,
  getMcpAutomationRun,
  getMcpAutomationWorkflow,
  listMcpAutomationTriggers,
  listMcpAutomationTriggerDeliveries,
  listMcpAutomationCredentials,
  listMcpAutomationDeploymentBindings,
  listMcpAutomationFixtures,
  listMcpAutomationVersions,
  getMcpCanvas,
  getMcpCanvasCapabilities,
  getMcpCanvasGeneration,
  listMcpAutomationRuns,
  listMcpAutomationWorkflows,
  listMcpCanvases,
  listMcpIdentities,
  listMcpLibraryAssets,
  listMcpWorkspaces,
  materializeMcpCanvasVideoSegment,
  moveMcpVideoMasterAssetLane,
  inspectMcpCanvasNodeInputs,
  importMcpTikTokToCanvas,
  importMcpAutomationWorkflow,
  importMcpCanvasDocument,
  inspectMcpIdentityReference,
  inspectMcpLibraryAsset,
  patchMcpCanvas,
  placeMcpCanvasAsset,
  placeMcpCanvasIdentity,
  previewMcpAutomationNode,
  publishMcpAutomationWorkflow,
  refreshMcpTikTokSource,
  removeMcpIdentityReference,
  removeMcpAutomationConnection,
  removeMcpAutomationNode,
  deleteMcpAutomationTrigger,
  removeMcpVideoMasterScene,
  replaceMcpCanvasVideoSegment,
  retryMcpAutomationRun,
  replayMcpAutomationTriggerDelivery,
  runMcpAutomationWorkflow,
  runMcpCanvasAssistant,
  runMcpCanvasGeneration,
  reorderMcpIdentityReferences,
  saveMcpAutomationWorkflow,
  selectMcpCanvasOutput,
  setMcpAutomationRunInput,
  setMcpAutomationTriggerStatus,
  setMcpSystemAutomationModel,
  copyMcpVideoMasterOutput,
  uploadMcpLibraryAsset,
  updateMcpCanvasVideoTimeline,
  unbindMcpAutomationDeploymentSlot,
  restoreMcpAutomationVersion,
  type CanvasPatchOperation,
} from "@/lib/mcp/service";

const jsonRecord = z.record(z.string(), z.unknown());
const automationBindingInput = z.object({
  mode: z.enum(["fixed", "ask-on-run"]),
  value: z.unknown().optional(),
  label: z.string().max(120).optional(),
  required: z.boolean().default(false),
}).strict();
const automationSettingsInput = z.object({
  timeoutSeconds: z.number().int().min(60).max(86_400).optional(),
  maxNodeExecutions: z.number().int().min(1).max(100_000).optional(),
  maxGeneratedAssets: z.number().int().min(1).max(5_000).optional(),
  maxCredits: z.number().int().nonnegative().max(1_000_000_000).nullable().optional(),
  maxParallelism: z.number().int().min(1).max(32).optional(),
  maxSubworkflowDepth: z.number().int().min(1).max(16).optional(),
  overlapPolicy: z.enum(["queue", "skip", "cancel-previous"]).optional(),
  maxConcurrentRuns: z.number().int().min(1).max(32).optional(),
}).strict();
const automationScheduleInput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("calendar"), cron: z.string().trim().min(1).max(160), timezone: z.string().min(1).max(100), misfirePolicy: z.enum(["skip", "catch-up-once"]).default("catch-up-once") }).strict(),
  z.object({ mode: z.literal("interval"), everyMinutes: z.number().int().min(1).max(525_600), misfirePolicy: z.enum(["skip", "catch-up-once"]).default("catch-up-once") }).strict(),
]);
const automationTriggerCommon = {
  workflow_id: z.string().min(1), canvas_id: z.string().min(1), name: z.string().trim().min(1).max(120),
  inputs: jsonRecord.default({}), overlap_policy: z.enum(["queue", "skip", "cancel-previous"]).default("queue"),
  max_concurrent_runs: z.number().int().min(1).max(32).default(1),
};
const automationTriggerInput = z.discriminatedUnion("type", [
  z.object({ ...automationTriggerCommon, type: z.literal("schedule"), schedule: automationScheduleInput }).strict(),
  z.object({ ...automationTriggerCommon, type: z.literal("webhook") }).strict(),
  z.object({ ...automationTriggerCommon, type: z.literal("canvas-event"), event: z.enum(["tiktok.imported", "generation.completed"]), version: z.literal(1).default(1) }).strict(),
]);
const point = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const viewport = z.object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().positive().max(20) }).strict();
const patchOperation = z.discriminatedUnion("type", [
  z.object({ type: z.literal("update_node"), nodeId: z.string().min(1).max(120), position: point }).strict(),
  z.object({ type: z.literal("remove_node"), nodeId: z.string().min(1).max(120) }).strict(),
  z.object({ type: z.literal("remove_edge"), edgeId: z.string().min(1).max(160) }).strict(),
  z.object({ type: z.literal("set_viewport"), viewport }).strict(),
]);

function toolResult(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function previewToolResult(result: { asset: Record<string, unknown>; previewBase64: string }): CallToolResult {
  const data = { asset: result.asset };
  return {
    content: [
      { type: "text", text: JSON.stringify(data, null, 2) },
      { type: "image", data: result.previewBase64, mimeType: String(result.asset.previewMimeType || "image/webp") },
    ],
    structuredContent: data,
  };
}

function toolError(error: unknown): CallToolResult {
  const value = error as { code?: unknown; status?: unknown; scope?: unknown; currentRevision?: unknown; currentDraftVersionId?: unknown; retryAfterMs?: unknown; requiredCredits?: unknown; validation?: unknown };
  const payload = {
    error: error instanceof Error ? error.message : "Scenelith could not complete this action",
    ...(typeof value?.code === "string" ? { code: value.code } : {}),
    ...(typeof value?.status === "number" ? { status: value.status } : {}),
    ...(typeof value?.scope === "string" ? { requiredScope: value.scope } : {}),
    ...(typeof value?.currentRevision === "number" ? { currentRevision: value.currentRevision } : {}),
    ...(typeof value?.currentDraftVersionId === "string" ? { currentDraftVersionId: value.currentDraftVersionId } : {}),
    ...(typeof value?.retryAfterMs === "number" ? { retryAfterMs: value.retryAfterMs } : {}),
    ...(typeof value?.requiredCredits === "number" ? { requiredCredits: value.requiredCredits } : {}),
    ...(value?.validation && typeof value.validation === "object" ? { validation: value.validation } : {}),
  };
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload, isError: true };
}

function safeTool<T>(callback: () => Promise<T>, wrap: (value: T) => Record<string, unknown>) {
  return callback().then((value) => toolResult(wrap(value))).catch(toolError);
}

export function createScenelithMcpServer(principal: McpPrincipal, origin: string) {
  const server = new McpServer(
    { name: "scenelith", title: "Scenelith Creative Platform", version: "0.1.0" },
    { instructions: SCENELITH_MCP_INSTRUCTIONS },
  );

  server.registerResource("agent-workflows", "scenelith://guide/agent-workflows", {
    title: "Scenelith agent workflow guide",
    description: "The object model, four tool domains, canonical recipes, and guardrails for reliable Scenelith agent work.",
    mimeType: "text/markdown",
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: SCENELITH_AGENT_GUIDE }] }));

  server.registerResource("connection-access", "scenelith://connection/access", {
    title: "Approved Scenelith access",
    description: "The workspace, canvases, Library grant, and scopes approved for this OAuth connection. Contains no credentials.",
    mimeType: "application/json",
  }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(scenelithConnectionAccess(principal), null, 2) }],
  }));

  server.registerResource("automation-guide", "scenelith://automation/guide", {
    title: "Scenelith Automation agent guide",
    description: "The safe workflow lifecycle, bindings, edge roles, prompt variables, publishing, running, and error rules.",
    mimeType: "text/markdown",
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: SCENELITH_AUTOMATION_GUIDE }] }));

  server.registerResource("automation-node-catalog", "scenelith://automation/node-catalog", {
    title: "Scenelith Automation node catalog",
    description: "The current node types, versions, exact ports, settings, defaults, run bindings, prompt variables, and help generated from the canonical registry.",
    mimeType: "application/json",
  }, async (uri) => ({ contents: [{
    uri: uri.href,
    mimeType: "application/json",
    text: JSON.stringify(getAutomationCapabilities({ includeHelp: true }), null, 2),
  }] }));

  server.registerTool("list_workspaces", {
    title: "List workspaces",
    description: "List the Scenelith workspaces this connection can access. Use the returned workspace IDs for canvas, library, and identity tools.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, () => safeTool(() => listMcpWorkspaces(principal), (workspaces) => ({ workspaces })));

  server.registerTool("list_canvases", {
    title: "List canvases",
    description: "List accessible canvases with IDs, current revisions, status, and compact graph summaries. Optionally limit the result to one workspace.",
    inputSchema: z.object({ workspace_id: z.string().min(1).optional() }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ workspace_id }) => safeTool(() => listMcpCanvases(principal, workspace_id), (canvases) => ({ canvases })));

  server.registerTool("get_canvas", {
    title: "Get canvas",
    description: "Get one complete canvas graph. Always call this immediately before patch_canvas and pass its revision as expected_revision.",
    inputSchema: z.object({ canvas_id: z.string().min(1) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ canvas_id }) => safeTool(() => getMcpCanvas(principal, canvas_id), (canvas) => ({ canvas })));

  server.registerTool("download_canvas_node_output", {
    title: "Download original node output",
    description: "Get a temporary download URL for the full original image or video from a generator node, matching its Canvas Download button. No browser login is needed. Omit output_index for the currently selected result, or use a 1-based index into generatedOutputs from get_canvas. Download the returned URL as a file; it is not a preview. Links expire within 10 minutes and may be invalidated by reconnecting. Does not generate media, spend credits, or change the canvas.",
    inputSchema: z.object({ canvas_id: z.string().min(1), node_id: z.string().min(1), output_index: z.number().int().positive().optional() }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ canvas_id, node_id, output_index }) => safeTool(
    () => downloadMcpCanvasNodeOutput(principal, { projectId: canvas_id, nodeId: node_id, outputIndex: output_index }),
    (download) => ({ download }),
  ));

  server.registerTool("get_canvas_capabilities", {
    title: "Get canvas capabilities",
    description: "Read the exact node types, generation and Assistant models, model settings, semantic input ports, reference roles, and supported agent operations for one canvas. Call this before creating or configuring nodes.",
    inputSchema: z.object({ canvas_id: z.string().min(1) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ canvas_id }) => safeTool(() => getMcpCanvasCapabilities(principal, canvas_id), (capabilities) => ({ capabilities })));

  server.registerTool("inspect_canvas_node_inputs", {
    title: "Inspect canvas node inputs",
    description: "Resolve one node's exact connected Assistant text and concrete image, video or audio asset references, including identity cards and attached references. Reports video segments that still need materialization.",
    inputSchema: z.object({ canvas_id: z.string().min(1), node_id: z.string().min(1) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ canvas_id, node_id }) => safeTool(
    () => inspectMcpCanvasNodeInputs(principal, { projectId: canvas_id, nodeId: node_id }),
    (inputs) => ({ inputs }),
  ));

  server.registerTool("export_canvas_document", {
    title: "Export portable canvas",
    description: "Export one approved canvas as a credential-free portable .scenelith.json document. Instance asset IDs, media URLs and generated outputs are deliberately removed.",
    inputSchema: z.object({ canvas_id: z.string().min(1) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ canvas_id }) => safeTool(() => exportMcpCanvasDocument(principal, canvas_id), (result) => result));

  if (principal.libraryAccess) {
    server.registerTool("list_library_assets", {
      title: "List library assets",
      description: "List one page of generated or uploaded images and videos from the canvases approved for this connection. Returns stable asset IDs, media metadata, counts, and next_cursor. Browser URLs require a signed-in Scenelith session; call inspect_library_asset when the agent needs to see the media.",
      inputSchema: z.object({
        workspace_id: z.string().min(1),
        canvas_id: z.string().min(1).optional(),
        media_type: z.enum(["all", "image", "video"]).default("all"),
        search: z.string().max(120).optional(),
        limit: z.number().int().min(1).max(100).default(50),
        cursor: z.string().max(300).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, ({ workspace_id, canvas_id, media_type, search, limit, cursor }) => safeTool(
      () => listMcpLibraryAssets(principal, { workspaceId: workspace_id, projectId: canvas_id, mediaType: media_type, search, limit, cursor }, origin),
      (page) => ({ assets: page.assets, counts: page.counts, next_cursor: page.nextCursor }),
    ));

    server.registerTool("inspect_library_asset", {
      title: "Inspect library asset",
      description: "Return a bounded visual preview plus exact metadata for one approved Library asset. Images return an image thumbnail; videos return a representative frame. Use this before selecting visual references.",
      inputSchema: z.object({ workspace_id: z.string().min(1), asset_id: z.string().min(1) }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, ({ workspace_id, asset_id }) => inspectMcpLibraryAsset(principal, { workspaceId: workspace_id, assetId: asset_id })
      .then(previewToolResult).catch(toolError));
  }

  server.registerTool("list_identities", {
    title: "List identities",
    description: "List reusable Scenelith identities with explicit single or before_after type, separated Character/Before/After groups, copied identity asset IDs, and accessible Library source lineage.",
    inputSchema: z.object({ workspace_id: z.string().min(1) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ workspace_id }) => safeTool(() => listMcpIdentities(principal, workspace_id, origin), (identities) => ({ identities })));

  server.registerTool("inspect_identity_reference", {
    title: "Inspect identity reference",
    description: "Return a bounded image preview plus metadata for one Character, Before, or After reference returned by list_identities. Identity references are workspace-level and do not expose their original Library source when that canvas was not approved.",
    inputSchema: z.object({ workspace_id: z.string().min(1), identity_id: z.string().min(1), asset_id: z.string().min(1) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ workspace_id, identity_id, asset_id }) => inspectMcpIdentityReference(principal, { workspaceId: workspace_id, identityId: identity_id, assetId: asset_id })
    .then(previewToolResult).catch(toolError));

  server.registerTool("list_automation_workflows", {
    title: "List automation workflows",
    description: "List workflows available to a canvas, including system workflows and user workflows. Use get_automation_workflow for the graph and current draft version ID.",
    inputSchema: z.object({ canvas_id: z.string().min(1) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ canvas_id }) => safeTool(() => listMcpAutomationWorkflows(principal, canvas_id), (workflows) => ({ workflows })));

  server.registerTool("get_automation_workflow", {
    title: "Get automation workflow",
    description: "Get a workflow, its draft and published immutable versions, graph validation, and system-model issues.",
    inputSchema: z.object({ workflow_id: z.string().min(1) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ workflow_id }) => safeTool(() => getMcpAutomationWorkflow(principal, workflow_id), (workflow) => ({ workflow })));

  server.registerTool("list_automation_triggers", {
    title: "List Automation triggers",
    description: "List paused or active schedules, webhooks, and Canvas-event triggers for one workflow, including pinned version, fixed run inputs, overlap policy, concurrency, and next/last fire times. Webhook secrets are never re-exposed.",
    inputSchema: z.object({ workflow_id: z.string().min(1) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ workflow_id }) => safeTool(() => listMcpAutomationTriggers(principal, workflow_id), (triggers) => ({ triggers })));

  server.registerTool("list_automation_trigger_deliveries", {
    title: "List Automation trigger deliveries",
    description: "Inspect automatic trigger delivery attempts, immutable version and input snapshots, retry state, errors, resulting run IDs, and open dead-letter alerts for one approved canvas.",
    inputSchema: z.object({
      canvas_id: z.string().min(1),
      workflow_id: z.string().min(1).optional(),
      trigger_id: z.string().min(1).optional(),
      status: z.enum(["queued", "processing", "retry_wait", "delivered", "dead_letter", "cancelled"]).optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ canvas_id, workflow_id, trigger_id, status, limit }) => safeTool(
    () => listMcpAutomationTriggerDeliveries(principal, { projectId: canvas_id, workflowId: workflow_id, triggerId: trigger_id, status, limit }),
    (deliveries) => ({ deliveries }),
  ));

  server.registerTool("list_automation_deployment_bindings", {
    title: "List Automation deployment bindings",
    description: "List credential and child-workflow slots connected to one workflow. Without the separately approved automation:credentials scope, credential names and IDs stay redacted while connection status remains visible.",
    inputSchema: z.object({ workflow_id: z.string().min(1) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ workflow_id }) => safeTool(() => listMcpAutomationDeploymentBindings(principal, workflow_id), (bindings) => ({ bindings })));

  server.registerTool("list_automation_versions", {
    title: "List Automation versions",
    description: "List immutable draft, published, superseded, restored, and named-checkpoint version metadata for one workflow.",
    inputSchema: z.object({ workflow_id: z.string().min(1) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ workflow_id }) => safeTool(() => listMcpAutomationVersions(principal, workflow_id), (versions) => ({ versions })));

  server.registerTool("export_automation_workflow", {
    title: "Export portable Automation workflow",
    description: "Export a draft or published workflow as an integrity-checked credential-free package. Instance credentials and deployment bindings are never embedded.",
    inputSchema: z.object({ workflow_id: z.string().min(1), version: z.enum(["published", "draft"]) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ workflow_id, version }) => safeTool(() => exportMcpAutomationWorkflow(principal, workflow_id, version), (result) => result));

  server.registerTool("list_automation_fixtures", {
    title: "List Automation test fixtures",
    description: "List pinned test fixtures for single-node previews, including immutable version, runtime inputs, and captured per-node inputs.",
    inputSchema: z.object({ workflow_id: z.string().min(1) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ workflow_id }) => safeTool(() => listMcpAutomationFixtures(principal, workflow_id), (fixtures) => ({ fixtures })));

  if (principalHasScope(principal, "automation:credentials")) server.registerTool("list_automation_credentials", {
    title: "List saved Automation credentials",
    description: "List safe metadata for existing workspace credentials: ID, name, kind, fingerprint, and timestamps. Secret payloads are never returned to MCP.",
    inputSchema: z.object({ workspace_id: z.string().min(1) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ workspace_id }) => safeTool(() => listMcpAutomationCredentials(principal, workspace_id), (credentials) => ({ credentials })));

  server.registerTool("get_automation_capabilities", {
    title: "Get Automation capabilities",
    description: "Read the canonical versioned node catalog: exact inputs, outputs, settings, defaults, RUN INPUTS sidebar bindings, prompt variables, dynamic ports, help, triggers, edge roles, and limits. Pass canvas_id to include the live model/ratio/resolution catalogue.",
    inputSchema: z.object({
      canvas_id: z.string().min(1).optional(),
      category: z.enum(["trigger", "input", "ai", "logic", "integration", "generation", "output"]).optional(),
      node_type: z.string().min(1).max(120).optional(),
      version: z.number().int().positive().optional(),
      include_help: z.boolean().default(true),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ canvas_id, category, node_type, version, include_help }) => safeTool(
    async () => ({
      ...getAutomationCapabilities({ category, nodeType: node_type, version, includeHelp: include_help }),
      ...(canvas_id ? { live_canvas_models: await getMcpCanvasCapabilities(principal, canvas_id) } : {}),
    }),
    (capabilities) => ({ capabilities }),
  ));

  server.registerTool("validate_automation_workflow", {
    title: "Validate Automation workflow",
    description: "Validate a complete draft without saving it. Returns every structural, node-setting, prompt-variable, port, route, retry, secret, and terminal-path issue plus ordered nodes and the exact run-input contract when parseable.",
    inputSchema: z.object({ graph: z.unknown() }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ graph }) => safeTool(
    async () => inspectAutomationWorkflowGraph(graph),
    (inspection) => ({ inspection }),
  ));

  server.registerTool("validate_automation_connection", {
    title: "Validate Automation connection",
    description: "Validate one proposed typed connection against the current graph before saving it, including exact ports, compatibility, edge role, duplicate inputs, disabled nodes, cycles, terminal nodes, error routes, and bounded retry rules.",
    inputSchema: z.object({
      graph: z.unknown(),
      connection: z.object({
        id: z.string().min(1).max(160).optional(),
        source: z.string().min(1).max(120),
        source_port: z.string().min(1).max(120),
        target: z.string().min(1).max(120),
        target_port: z.string().min(1).max(120),
        role: z.enum(["flow", "data", "error", "retry"]),
      }).strict(),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ graph, connection }) => safeTool(
    async () => inspectAutomationConnection(graph, {
      id: connection.id,
      source: connection.source,
      sourcePort: connection.source_port,
      target: connection.target,
      targetPort: connection.target_port,
      role: connection.role,
    }),
    (validation) => ({ validation }),
  ));

  server.registerTool("list_automation_runs", {
    title: "List automation runs",
    description: "List recent top-level automation runs for a canvas, optionally filtered to one workflow.",
    inputSchema: z.object({ canvas_id: z.string().min(1), workflow_id: z.string().min(1).optional(), before: z.string().datetime().optional(), limit: z.number().int().min(1).max(100).default(30) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ canvas_id, workflow_id, before, limit }) => safeTool(() => listMcpAutomationRuns(principal, { projectId: canvas_id, workflowId: workflow_id, before, limit }), (runs) => ({ runs })));

  server.registerTool("get_automation_run", {
    title: "Get automation run",
    description: "Get one automation run with captured inputs, node outputs, events, costs, warnings, and exact immutable workflow version.",
    inputSchema: z.object({ run_id: z.string().min(1) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ run_id }) => safeTool(() => getMcpAutomationRun(principal, run_id), (run) => ({ run })));

  server.registerTool("diagnose_automation_run", {
    title: "Diagnose Automation run",
    description: "Explain one run from its immutable workflow version, captured runtime inputs and asset snapshot, exact failed node attempts, error codes, outputs, and events. Returns targeted repair guidance and never retries automatically.",
    inputSchema: z.object({ run_id: z.string().min(1) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ run_id }) => safeTool(
    () => getMcpAutomationRun(principal, run_id),
    (run) => ({ diagnosis: diagnoseAutomationRun(run as unknown as Record<string, unknown>) }),
  ));

  if (principalHasScope(principal, "canvas:write")) {
    if (!principal.projectIds) server.registerTool("create_canvas", {
      title: "Create canvas",
      description: "Create an empty canvas in a workspace. This changes Scenelith but does not run generation.",
      inputSchema: z.object({ workspace_id: z.string().min(1), name: z.string().trim().min(1).max(120) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, ({ workspace_id, name }) => safeTool(() => createMcpCanvas(principal, { workspaceId: workspace_id, name }), (canvas) => ({ canvas })));

    if (!principal.projectIds) server.registerTool("import_canvas_document", {
      title: "Import portable canvas",
      description: "Validate and import a portable .scenelith.json document into an approved workspace. Fresh canvas, node, edge and Video Master scene IDs are assigned; embedded secrets and unknown fields fail closed.",
      inputSchema: z.object({ workspace_id: z.string().min(1), document: z.unknown() }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, ({ workspace_id, document }) => safeTool(() => importMcpCanvasDocument(principal, { workspaceId: workspace_id, document }), (result) => result));

    server.registerTool("patch_canvas", {
      title: "Patch canvas",
      description: "Atomically move or remove nodes, remove connections, rename the canvas, or set its viewport. Use the semantic create, configure, place, connect and duplicate tools for content changes so models, assets and ports are validated.",
      inputSchema: z.object({
        canvas_id: z.string().min(1),
        expected_revision: z.number().int().nonnegative(),
        name: z.string().trim().min(1).max(120).optional(),
        operations: z.array(patchOperation).max(100).default([]),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, ({ canvas_id, expected_revision, name, operations }) => safeTool(
      () => patchMcpCanvas(principal, { projectId: canvas_id, expectedRevision: expected_revision, name, operations: operations as CanvasPatchOperation[] }),
      (canvas) => ({ canvas }),
    ));

    server.registerTool("create_canvas_node", {
      title: "Create canvas node",
      description: "Create a configured Image Generator, Video Generator, Assistant, or Sticky Note using the same defaults as the Canvas UI. Use place_canvas_asset or place_canvas_identity for media and identity nodes.",
      inputSchema: z.object({
        canvas_id: z.string().min(1),
        expected_revision: z.number().int().nonnegative(),
        type: z.enum(["image_generator", "video_generator", "assistant", "note"]),
        position: point,
        title: z.string().trim().min(1).max(240).optional(),
        model_id: z.string().min(1).max(120).optional(),
        text_model_id: z.string().min(1).max(120).optional(),
        prompt: z.string().max(30_000).optional(),
        instruction: z.string().max(10_000).optional(),
        system_prompt: z.string().max(10_000).optional(),
        note_text: z.string().max(20_000).optional(),
        note_color: z.enum(["yellow", "blue", "rose", "gray"]).optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, ({ canvas_id, expected_revision, type, position, title, model_id, text_model_id, prompt, instruction, system_prompt, note_text, note_color }) => safeTool(
      () => createMcpCanvasNode(principal, { projectId: canvas_id, expectedRevision: expected_revision, type, position, title, modelId: model_id, textModelId: text_model_id, prompt, instruction, systemPrompt: system_prompt, noteText: note_text, noteColor: note_color }),
      (result) => result,
    ));

    server.registerTool("configure_canvas_node", {
      title: "Configure canvas node",
      description: "Configure a node with semantic fields. Generator model, ratio, resolution, duration, audio and batch values are normalized against the live model catalogue; Assistant and note settings are type checked.",
      inputSchema: z.object({
        canvas_id: z.string().min(1),
        expected_revision: z.number().int().nonnegative(),
        node_id: z.string().min(1),
        title: z.string().trim().min(1).max(240).optional(),
        position: point.optional(),
        prompt: z.string().max(30_000).optional(),
        model_id: z.string().min(1).max(120).optional(),
        aspect_ratio: z.string().min(1).max(20).optional(),
        resolution: z.string().min(1).max(20).optional(),
        duration: z.string().regex(/^\d+(?:\.\d+)?$/).optional(),
        generate_audio: z.boolean().optional(),
        generation_count: z.number().int().min(1).max(8).optional(),
        instruction: z.string().max(10_000).optional(),
        system_prompt: z.string().max(10_000).optional(),
        text_model_id: z.string().min(1).max(120).optional(),
        note_text: z.string().max(20_000).optional(),
        note_color: z.enum(["yellow", "blue", "rose", "gray"]).optional(),
        node_width: z.number().finite().min(180).max(1_180).optional(),
        node_height: z.number().finite().min(120).max(1_200).optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, ({ canvas_id, expected_revision, node_id, title, position, prompt, model_id, aspect_ratio, resolution, duration, generate_audio, generation_count, instruction, system_prompt, text_model_id, note_text, note_color, node_width, node_height }) => safeTool(
      () => configureMcpCanvasNode(principal, { projectId: canvas_id, expectedRevision: expected_revision, nodeId: node_id, configuration: { title, position, prompt, modelId: model_id, aspectRatio: aspect_ratio, resolution, duration, generateAudio: generate_audio, generationCount: generation_count, instruction, systemPrompt: system_prompt, textModelId: text_model_id, noteText: note_text, noteColor: note_color, nodeWidth: node_width, nodeHeight: node_height } }),
      (canvas) => ({ canvas }),
    ));

    server.registerTool("connect_canvas_nodes", {
      title: "Connect canvas nodes",
      description: "Connect one node output to a typed text, image, video or audio input. The server derives semantic handles, validates media compatibility and model capacity, and replaces only single-value inputs.",
      inputSchema: z.object({
        canvas_id: z.string().min(1),
        expected_revision: z.number().int().nonnegative(),
        source_node_id: z.string().min(1),
        target_node_id: z.string().min(1),
        target_clip_id: z.string().min(1).max(200).optional(),
        input_role: z.enum(["reference-image", "start-frame", "end-frame", "motion-video", "reference-video", "reference-audio"]).optional(),
        source_segment_id: z.string().min(1).max(180).optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, ({ canvas_id, expected_revision, source_node_id, target_node_id, target_clip_id, input_role, source_segment_id }) => safeTool(
      () => connectMcpCanvasNodes(principal, { projectId: canvas_id, expectedRevision: expected_revision, sourceNodeId: source_node_id, targetNodeId: target_node_id, targetClipId: target_clip_id, inputRole: input_role, sourceSegmentId: source_segment_id }),
      (canvas) => ({ canvas }),
    ));

    if (principal.libraryAccess) server.registerTool("place_canvas_asset", {
      title: "Place Library asset on canvas",
      description: "Place one approved Library image or video on the canvas as a real scene node that can feed generator and Assistant inputs.",
      inputSchema: z.object({ canvas_id: z.string().min(1), expected_revision: z.number().int().nonnegative(), asset_id: z.string().min(1), position: point, title: z.string().trim().min(1).max(240).optional() }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, ({ canvas_id, expected_revision, asset_id, position, title }) => safeTool(
      () => placeMcpCanvasAsset(principal, { projectId: canvas_id, expectedRevision: expected_revision, assetId: asset_id, position, title }),
      (result) => result,
    ));

    if (principal.libraryAccess) server.registerTool("attach_canvas_reference", {
      title: "Attach Library reference",
      description: "Attach one approved Library or identity asset directly to a generator or Assistant input. The server validates MIME type, model port, capacity, Assistant vision support and project grants.",
      inputSchema: z.object({
        canvas_id: z.string().min(1), expected_revision: z.number().int().nonnegative(), node_id: z.string().min(1), clip_id: z.string().min(1).max(200).optional(), asset_id: z.string().min(1),
        input_role: z.enum(["reference-image", "start-frame", "end-frame", "motion-video", "reference-video", "reference-audio"]),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, ({ canvas_id, expected_revision, node_id, clip_id, asset_id, input_role }) => safeTool(
      () => attachMcpCanvasReference(principal, { projectId: canvas_id, expectedRevision: expected_revision, nodeId: node_id, clipId: clip_id, assetId: asset_id, role: input_role }),
      (canvas) => ({ canvas }),
    ));

    if (principal.libraryAccess) server.registerTool("detach_canvas_reference", {
      title: "Detach Library reference",
      description: "Detach one directly attached Library or identity reference from a generator, Assistant, or exact Video Master scene. Visible node-to-node connections remain removable through patch_canvas.remove_edge.",
      inputSchema: z.object({ canvas_id: z.string().min(1), expected_revision: z.number().int().nonnegative(), node_id: z.string().min(1), clip_id: z.string().min(1).max(200).optional(), asset_id: z.string().min(1), input_role: z.enum(["reference-image", "start-frame", "end-frame", "motion-video", "reference-video", "reference-audio"]).optional() }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    }, ({ canvas_id, expected_revision, node_id, clip_id, asset_id, input_role }) => safeTool(
      () => detachMcpCanvasReference(principal, { projectId: canvas_id, expectedRevision: expected_revision, nodeId: node_id, clipId: clip_id, assetId: asset_id, role: input_role }),
      (canvas) => ({ canvas }),
    ));

    server.registerTool("place_canvas_identity", {
      title: "Place identity on canvas",
      description: "Place selected Character, Before, or After identity references on the canvas as one persona node. Omit reference_asset_ids to use every asset in the chosen variant.",
      inputSchema: z.object({
        canvas_id: z.string().min(1), expected_revision: z.number().int().nonnegative(), identity_id: z.string().min(1),
        variant: z.enum(["reference", "before", "after"]), reference_asset_ids: z.array(z.string().min(1)).max(100).optional(), position: point,
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, ({ canvas_id, expected_revision, identity_id, variant, reference_asset_ids, position }) => safeTool(
      () => placeMcpCanvasIdentity(principal, { projectId: canvas_id, expectedRevision: expected_revision, identityId: identity_id, variant, assetIds: reference_asset_ids, position }),
      (result) => result,
    ));

    server.registerTool("duplicate_canvas_nodes", {
      title: "Duplicate canvas nodes",
      description: "Duplicate selected nodes and only the connections between them, offsetting the copy and removing automation lineage just like manual Canvas duplication.",
      inputSchema: z.object({ canvas_id: z.string().min(1), expected_revision: z.number().int().nonnegative(), node_ids: z.array(z.string().min(1)).min(1).max(100), offset: point.optional() }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, ({ canvas_id, expected_revision, node_ids, offset }) => safeTool(
      () => duplicateMcpCanvasNodes(principal, { projectId: canvas_id, expectedRevision: expected_revision, nodeIds: node_ids, offset }),
      (result) => result,
    ));

    server.registerTool("select_canvas_output", {
      title: "Select generated output",
      description: "Select one previously generated output as the active media for a generator node or one Video Master scene without deleting output history.",
      inputSchema: z.object({ canvas_id: z.string().min(1), expected_revision: z.number().int().nonnegative(), node_id: z.string().min(1), output_index: z.number().int().min(0).max(19), clip_id: z.string().min(1).max(200).optional() }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, ({ canvas_id, expected_revision, node_id, output_index, clip_id }) => safeTool(
      () => selectMcpCanvasOutput(principal, { projectId: canvas_id, expectedRevision: expected_revision, nodeId: node_id, outputIndex: output_index, clipId: clip_id }),
      (canvas) => ({ canvas }),
    ));

    server.registerTool("create_video_master", {
      title: "Create Video Master",
      description: "Open a video source with a detected scene map as a complete editable Video Master sequence. Every detected scene is retained and linked to its exact source segment.",
      inputSchema: z.object({ canvas_id: z.string().min(1), expected_revision: z.number().int().nonnegative(), source_node_id: z.string().min(1), focus_segment_id: z.string().min(1).max(180).optional() }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, ({ canvas_id, expected_revision, source_node_id, focus_segment_id }) => safeTool(
      () => createMcpVideoMaster(principal, { projectId: canvas_id, expectedRevision: expected_revision, sourceNodeId: source_node_id, focusSegmentId: focus_segment_id }),
      (result) => result,
    ));

    server.registerTool("configure_video_master_scene", {
      title: "Configure Video Master scene",
      description: "Configure one Video Master scene's order, role, prompt, video model, output ratio mode, resolution, generation duration and audio using the live provider catalogue.",
      inputSchema: z.object({
        canvas_id: z.string().min(1), expected_revision: z.number().int().nonnegative(), node_id: z.string().min(1), clip_id: z.string().min(1),
        title: z.string().trim().min(1).max(160).optional(), role: z.enum(["hook", "scene", "cta"]).optional(), prompt: z.string().max(30_000).optional(),
        model_id: z.string().min(1).max(120).optional(), aspect_ratio: z.string().min(1).max(20).optional(), aspect_ratio_mode: z.enum(["original", "custom"]).optional(),
        resolution: z.string().min(1).max(20).optional(), duration: z.number().finite().min(.1).max(30).optional(), generate_audio: z.boolean().optional(), sequence_index: z.number().int().min(0).max(500).optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, ({ canvas_id, expected_revision, node_id, clip_id, title, role, prompt, model_id, aspect_ratio, aspect_ratio_mode, resolution, duration, generate_audio, sequence_index }) => safeTool(
      () => configureMcpVideoMasterClip(principal, { projectId: canvas_id, expectedRevision: expected_revision, nodeId: node_id, clipId: clip_id, title, role, prompt, modelId: model_id, aspectRatio: aspect_ratio, aspectRatioMode: aspect_ratio_mode, resolution, duration, generateAudio: generate_audio, sequenceIndex: sequence_index }),
      (canvas) => ({ canvas }),
    ));

    server.registerTool("create_canvas_segment_node", {
      title: "Add video scene as canvas clip",
      description: "Materialize one detected source scene when needed and place it as a standalone, frame-accurate video node with source lineage.",
      inputSchema: z.object({ canvas_id: z.string().min(1), expected_revision: z.number().int().nonnegative(), source_node_id: z.string().min(1), segment_id: z.string().min(1).max(180), position: point }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, ({ canvas_id, expected_revision, source_node_id, segment_id, position }) => safeTool(
      () => createMcpCanvasSegmentNode(principal, { projectId: canvas_id, expectedRevision: expected_revision, sourceNodeId: source_node_id, segmentId: segment_id, position }),
      (result) => result,
    ));

    server.registerTool("update_canvas_video_timeline", {
      title: "Edit source video timeline",
      description: "Set exact source-scene cut times, select the full video or one resulting scene as the active output, or restore the immutable detected cuts. Changed ranges deliberately discard stale materialized clips.",
      inputSchema: z.object({
        canvas_id: z.string().min(1), expected_revision: z.number().int().nonnegative(), source_node_id: z.string().min(1),
        cuts_seconds: z.array(z.number().finite().positive()).max(79).optional(), restore_detected: z.boolean().optional(), output_selection: z.string().min(1).max(180).optional(),
      }).strict().refine((value) => value.cuts_seconds !== undefined || value.restore_detected || value.output_selection, "Choose cuts, restore_detected, or output_selection")
        .refine((value) => !(value.cuts_seconds !== undefined && value.restore_detected), "cuts_seconds and restore_detected are mutually exclusive"),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, ({ canvas_id, expected_revision, source_node_id, cuts_seconds, restore_detected, output_selection }) => safeTool(
      () => updateMcpCanvasVideoTimeline(principal, { projectId: canvas_id, expectedRevision: expected_revision, sourceNodeId: source_node_id, cuts: cuts_seconds, restoreDetected: restore_detected, outputSelection: output_selection }),
      (canvas) => ({ canvas }),
    ));

    server.registerTool("create_canvas_remake_branch", {
      title: "Create remake branch",
      description: "Create the same source-aware Image Generator branch as the Canvas 'Create my version' action, with a safe original-content prompt and typed image connection.",
      inputSchema: z.object({ canvas_id: z.string().min(1), expected_revision: z.number().int().nonnegative(), source_node_id: z.string().min(1), position: point.optional() }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, ({ canvas_id, expected_revision, source_node_id, position }) => safeTool(
      () => createMcpCanvasRemakeBranch(principal, { projectId: canvas_id, expectedRevision: expected_revision, sourceNodeId: source_node_id, position }),
      (result) => result,
    ));

    if (principal.libraryAccess) {
      server.registerTool("replace_canvas_video_segment", {
        title: "Replace source video scene",
        description: "Use an approved Library video as the OUTPUT replacement for one detected source segment and synchronize any related Video Master scene.",
        inputSchema: z.object({ canvas_id: z.string().min(1), expected_revision: z.number().int().nonnegative(), source_node_id: z.string().min(1), segment_id: z.string().min(1).max(180), replacement_asset_id: z.string().min(1) }).strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      }, ({ canvas_id, expected_revision, source_node_id, segment_id, replacement_asset_id }) => safeTool(
        () => replaceMcpCanvasVideoSegment(principal, { projectId: canvas_id, expectedRevision: expected_revision, sourceNodeId: source_node_id, segmentId: segment_id, replacementAssetId: replacement_asset_id }),
        (canvas) => ({ canvas }),
      ));

      server.registerTool("add_video_master_asset", {
        title: "Add Library video to Video Master",
        description: "Append an approved Library video as a standalone Video Master scene using the same model, ratio, duration and ORIGINAL/OUTPUT defaults as a manual upload.",
        inputSchema: z.object({ canvas_id: z.string().min(1), expected_revision: z.number().int().nonnegative(), node_id: z.string().min(1), asset_id: z.string().min(1) }).strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      }, ({ canvas_id, expected_revision, node_id, asset_id }) => safeTool(
        () => addMcpVideoMasterAsset(principal, { projectId: canvas_id, expectedRevision: expected_revision, nodeId: node_id, assetId: asset_id }),
        (result) => result,
      ));

      server.registerTool("export_video_master_media", {
        title: "Export Video Master media",
        description: "Render one scene or the full ordered Video Master sequence from OUTPUT or ORIGINAL, save the MP4 into the approved canvas Library, and return its asset ID.",
        inputSchema: z.object({ canvas_id: z.string().min(1), node_id: z.string().min(1), lane: z.enum(["output", "original"]), scope: z.enum(["scene", "video"]), clip_id: z.string().min(1).optional() }).strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      }, ({ canvas_id, node_id, lane, scope, clip_id }) => safeTool(
        () => exportMcpVideoMasterMedia(principal, { projectId: canvas_id, nodeId: node_id, lane, scope, clipId: clip_id }),
        (result) => result,
      ));
    }

    server.registerTool("copy_video_master_output", {
      title: "Copy Video Master output",
      description: "Copy one saved generated output from a source Video Master scene into another scene without deleting either scene's output history.",
      inputSchema: z.object({ canvas_id: z.string().min(1), expected_revision: z.number().int().nonnegative(), node_id: z.string().min(1), source_clip_id: z.string().min(1), output_index: z.number().int().min(0).max(19), target_clip_id: z.string().min(1) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, ({ canvas_id, expected_revision, node_id, source_clip_id, output_index, target_clip_id }) => safeTool(
      () => copyMcpVideoMasterOutput(principal, { projectId: canvas_id, expectedRevision: expected_revision, nodeId: node_id, sourceClipId: source_clip_id, outputIndex: output_index, targetClipId: target_clip_id }),
      (canvas) => ({ canvas }),
    ));

    server.registerTool("add_video_master_scene", {
      title: "Add blank Video Master scene",
      description: "Append a new generator-only Video Master scene using the selected scene's model and format defaults, ready for a prompt and references.",
      inputSchema: z.object({ canvas_id: z.string().min(1), expected_revision: z.number().int().nonnegative(), node_id: z.string().min(1) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, ({ canvas_id, expected_revision, node_id }) => safeTool(
      () => addMcpVideoMasterScene(principal, { projectId: canvas_id, expectedRevision: expected_revision, nodeId: node_id }),
      (result) => result,
    ));

    server.registerTool("move_video_master_asset_lane", {
      title: "Move uploaded Video Master clip lane",
      description: "Move one standalone uploaded Library clip between OUTPUT and ORIGINAL, updating the implicit scene video reference exactly like timeline drag-and-drop.",
      inputSchema: z.object({ canvas_id: z.string().min(1), expected_revision: z.number().int().nonnegative(), node_id: z.string().min(1), clip_id: z.string().min(1), lane: z.enum(["output", "original"]) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, ({ canvas_id, expected_revision, node_id, clip_id, lane }) => safeTool(
      () => moveMcpVideoMasterAssetLane(principal, { projectId: canvas_id, expectedRevision: expected_revision, nodeId: node_id, clipId: clip_id, lane }),
      (canvas) => ({ canvas }),
    ));

    server.registerTool("remove_video_master_scene", {
      title: "Remove Video Master scene",
      description: "Remove one Video Master scene, its scene-scoped reference edges, normalize the remaining order, and select the nearest surviving scene.",
      inputSchema: z.object({ canvas_id: z.string().min(1), expected_revision: z.number().int().nonnegative(), node_id: z.string().min(1), clip_id: z.string().min(1) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, ({ canvas_id, expected_revision, node_id, clip_id }) => safeTool(
      () => removeMcpVideoMasterScene(principal, { projectId: canvas_id, expectedRevision: expected_revision, nodeId: node_id, clipId: clip_id }),
      (canvas) => ({ canvas }),
    ));
  }

  if (principalHasScope(principal, "identity:write") && principal.libraryAccess) {
    server.registerTool("create_identity_from_assets", {
      title: "Create identity from assets",
      description: "Create one explicit Identity type from approved Library images. A single Identity accepts only Character references; a Before / After Identity accepts only Before and After groups. Use list_library_assets first; videos are not accepted.",
      inputSchema: z.object({
        workspace_id: z.string().min(1),
        name: z.string().trim().min(1).max(80),
        notes: z.string().max(2000).optional(),
        identity_type: z.enum(["single", "before_after"]),
        references: z.array(z.object({ asset_id: z.string().min(1), role: z.enum(["reference", "before", "after"]).default("reference") }).strict()).min(1).max(100),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, ({ workspace_id, name, notes, identity_type, references }) => safeTool(
      () => createMcpIdentityFromAssets(principal, { workspaceId: workspace_id, name, notes, identityType: identity_type, references: references.map((reference) => ({ assetId: reference.asset_id, role: reference.role })) }, origin),
      (identity) => ({ identity }),
    ));

    server.registerTool("add_identity_references", {
      title: "Add references to identity",
      description: "Copy approved Library images into an existing identity without changing its type: Character for a single Identity, or Before/After for a transformation Identity. Source assets remain in Library.",
      inputSchema: z.object({
        workspace_id: z.string().min(1), identity_id: z.string().min(1),
        references: z.array(z.object({ asset_id: z.string().min(1), role: z.enum(["reference", "before", "after"]) }).strict()).min(1).max(100),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, ({ workspace_id, identity_id, references }) => safeTool(
      () => addMcpIdentityReferences(principal, { workspaceId: workspace_id, identityId: identity_id, references: references.map((reference) => ({ assetId: reference.asset_id, role: reference.role })) }, origin),
      (identity) => ({ identity }),
    ));

    server.registerTool("reorder_identity_references", {
      title: "Reorder identity references",
      description: "Set the complete order of one identity reference group. The full current asset list is required so concurrent changes fail closed.",
      inputSchema: z.object({ workspace_id: z.string().min(1), identity_id: z.string().min(1), role: z.enum(["reference", "before", "after"]), asset_ids: z.array(z.string().min(1)).min(1).max(100) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, ({ workspace_id, identity_id, role, asset_ids }) => safeTool(
      () => reorderMcpIdentityReferences(principal, { workspaceId: workspace_id, identityId: identity_id, role, assetIds: asset_ids }, origin),
      (identity) => ({ identity }),
    ));

    server.registerTool("remove_identity_reference", {
      title: "Remove identity reference",
      description: "Remove one saved image from an identity while preserving the rule that every identity keeps at least one reference.",
      inputSchema: z.object({ workspace_id: z.string().min(1), identity_id: z.string().min(1), asset_id: z.string().min(1) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, ({ workspace_id, identity_id, asset_id }) => safeTool(
      () => removeMcpIdentityReference(principal, { workspaceId: workspace_id, identityId: identity_id, assetId: asset_id }, origin),
      (identity) => ({ identity }),
    ));
  }

  if (principalHasScope(principal, "assistant:run") && principalHasScope(principal, "canvas:write")) {
    server.registerTool("run_canvas_assistant", {
      title: "Run Canvas Assistant",
      description: "Run an Assistant node with its exact connected text, system prompt, model and visual references. This may consume credits or provider resources. The result is saved only if the node inputs did not change while the model was running.",
      inputSchema: z.object({
        canvas_id: z.string().min(1),
        expected_revision: z.number().int().nonnegative(),
        node_id: z.string().min(1),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, ({ canvas_id, expected_revision, node_id }) => safeTool(
      () => runMcpCanvasAssistant(principal, { projectId: canvas_id, expectedRevision: expected_revision, nodeId: node_id }),
      (result) => ({ result }),
    ));

    server.registerTool("compose_canvas_prompt", {
      title: "Build generator prompt with Assistant",
      description: "Turn a brief into a model-aware Image or Video Generator prompt using the node's exact connected references. This may consume credits or provider resources. The prompt is inserted only if the node inputs did not change during the run.",
      inputSchema: z.object({
        canvas_id: z.string().min(1),
        expected_revision: z.number().int().nonnegative(),
        node_id: z.string().min(1),
        brief: z.string().trim().min(2).max(5_000),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, ({ canvas_id, expected_revision, node_id, brief }) => safeTool(
      () => composeMcpCanvasPrompt(principal, { projectId: canvas_id, expectedRevision: expected_revision, nodeId: node_id, brief }),
      (result) => ({ result }),
    ));
  }

  if (principalHasScope(principal, "generation:run") && principalHasScope(principal, "canvas:write")) {
    server.registerTool("run_canvas_generation", {
      title: "Run canvas generation",
      description: "Start the configured Image or Video Generator node with its exact Assistant text, local prompt, model settings and typed asset references. This consumes credits or provider resources and returns a durable generation ID for get_canvas_generation.",
      inputSchema: z.object({ canvas_id: z.string().min(1), expected_revision: z.number().int().nonnegative(), node_id: z.string().min(1), clip_id: z.string().min(1).max(200).optional(), generation_count: z.number().int().min(1).max(8).optional() }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, ({ canvas_id, expected_revision, node_id, clip_id, generation_count }) => safeTool(
      () => runMcpCanvasGeneration(principal, { projectId: canvas_id, expectedRevision: expected_revision, nodeId: node_id, clipId: clip_id, generationCount: generation_count }),
      (result) => ({ result }),
    ));

    server.registerTool("get_canvas_generation", {
      title: "Get canvas generation",
      description: "Check and reconcile one generation. Completed media is durably stored in the Library and merged into the target canvas node before the updated canvas is returned.",
      inputSchema: z.object({ generation_id: z.string().uuid() }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, ({ generation_id }) => safeTool(
      () => getMcpCanvasGeneration(principal, generation_id),
      (result) => result,
    ));

    server.registerTool("cancel_canvas_generation", {
      title: "Cancel canvas generation",
      description: "Cancel a queued or active generation owned by an approved canvas, settle or release its usage reservation correctly, and clear the node's running state.",
      inputSchema: z.object({ generation_id: z.string().uuid() }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    }, ({ generation_id }) => safeTool(() => cancelMcpCanvasGeneration(principal, generation_id), (result) => result));

    server.registerTool("edit_canvas_image", {
      title: "Edit canvas image in place",
      description: "Edit the active image in one existing canvas node, preserving the base image and output history. Optional approved Library references receive stable prompt tokens. This consumes credits or provider resources.",
      inputSchema: z.object({
        canvas_id: z.string().min(1), expected_revision: z.number().int().nonnegative(), node_id: z.string().min(1), prompt: z.string().trim().min(2).max(20_000),
        model_id: z.string().min(1).max(120).optional(), resolution: z.string().min(1).max(20).optional(), aspect_ratio: z.string().min(1).max(20).optional(), size_mode: z.enum(["original", "custom"]).default("original"),
        references: z.array(z.object({ asset_id: z.string().min(1), title: z.string().trim().min(1).max(160).optional(), detail: z.string().max(500).optional(), origin: z.enum(["canvas", "identity", "upload"]).optional() }).strict()).max(49).default([]),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, ({ canvas_id, expected_revision, node_id, prompt, model_id, resolution, aspect_ratio, size_mode, references }) => safeTool(
      () => editMcpCanvasImage(principal, { projectId: canvas_id, expectedRevision: expected_revision, nodeId: node_id, prompt, modelId: model_id, resolution, aspectRatio: aspect_ratio, sizeMode: size_mode, references: references.map((reference) => ({ assetId: reference.asset_id, title: reference.title, detail: reference.detail, origin: reference.origin })) }),
      (result) => result,
    ));
  }

  if (principalHasScope(principal, "library:write") && principal.libraryAccess) {
    server.registerTool("upload_library_asset", {
      title: "Upload media to Library",
      description: "Upload bounded base64-encoded JPG, PNG, MP4, MOV or WebM media into one approved canvas Library. Bytes are format-checked; arbitrary server paths and remote URLs are never accepted. For large video use the Scenelith UI upload flow.",
      inputSchema: z.object({
        canvas_id: z.string().min(1), filename: z.string().trim().min(1).max(240),
        mime_type: z.enum(["image/jpeg", "image/png", "video/mp4", "video/webm", "video/quicktime"]),
        content_base64: z.string().min(4),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, ({ canvas_id, filename, mime_type, content_base64 }) => safeTool(
      () => uploadMcpLibraryAsset(principal, { projectId: canvas_id, filename, mimeType: mime_type, contentBase64: content_base64 }),
      (asset) => ({ asset }),
    ));
  }

  if (principalHasScope(principal, "import:write") && principalHasScope(principal, "canvas:write")) {
    server.registerTool("import_tiktok_to_canvas", {
      title: "Import TikTok to canvas",
      description: "Import a direct TikTok slideshow or video, persist its media in the approved canvas Library, extract available hook evidence, detect video scenes, and append the same source/scene graph created by the Canvas UI. This fetches external media and may take several minutes.",
      inputSchema: z.object({
        canvas_id: z.string().min(1),
        expected_revision: z.number().int().nonnegative(),
        url: z.string().url().refine((value) => /tiktok\.com/i.test(value), "TikTok URL required"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, ({ canvas_id, expected_revision, url }) => safeTool(
      () => importMcpTikTokToCanvas(principal, { projectId: canvas_id, expectedRevision: expected_revision, url }),
      (result) => result,
    ));

    server.registerTool("capture_canvas_video_frame", {
      title: "Capture video frame",
      description: "Capture an exact still frame from an accessible canvas video, store it in the same canvas Library, and add the resulting image node below the source just like the Canvas editor.",
      inputSchema: z.object({ canvas_id: z.string().min(1), expected_revision: z.number().int().nonnegative(), source_node_id: z.string().min(1), time_seconds: z.number().finite().min(0).max(21_600) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, ({ canvas_id, expected_revision, source_node_id, time_seconds }) => safeTool(
      () => captureMcpCanvasVideoFrame(principal, { projectId: canvas_id, expectedRevision: expected_revision, sourceNodeId: source_node_id, time: time_seconds }),
      (result) => result,
    ));

    server.registerTool("materialize_canvas_video_segment", {
      title: "Prepare video segment",
      description: "Materialize one detected or edited source scene as an exact zero-based MP4, then update every related canvas node, edge and Video Master scene without losing concurrent unrelated edits.",
      inputSchema: z.object({ canvas_id: z.string().min(1), expected_revision: z.number().int().nonnegative(), source_node_id: z.string().min(1), segment_id: z.string().min(1).max(180) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, ({ canvas_id, expected_revision, source_node_id, segment_id }) => safeTool(
      () => materializeMcpCanvasVideoSegment(principal, { projectId: canvas_id, expectedRevision: expected_revision, sourceNodeId: source_node_id, segmentId: segment_id }),
      (result) => result,
    ));

    server.registerTool("refresh_tiktok_source", {
      title: "Refresh TikTok source stats",
      description: "Refresh the author, publication time and engagement counters for one imported TikTok source node and update matching original-hook views.",
      inputSchema: z.object({ canvas_id: z.string().min(1), expected_revision: z.number().int().nonnegative(), source_node_id: z.string().min(1) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, ({ canvas_id, expected_revision, source_node_id }) => safeTool(
      () => refreshMcpTikTokSource(principal, { projectId: canvas_id, expectedRevision: expected_revision, sourceNodeId: source_node_id }),
      (result) => result,
    ));
  }

  if (principalHasScope(principal, "automation:write")) {
    server.registerTool("create_automation_workflow", {
      title: "Create automation workflow",
      description: "Create a new draft workflow, optionally duplicating an existing workflow graph. This does not run or publish it.",
      inputSchema: z.object({ canvas_id: z.string().min(1), name: z.string().trim().min(1).max(120), description: z.string().max(500).optional(), source_workflow_id: z.string().min(1).optional() }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, ({ canvas_id, name, description, source_workflow_id }) => safeTool(
      () => createMcpAutomationWorkflow(principal, { projectId: canvas_id, name, description, sourceWorkflowId: source_workflow_id }),
      (workflow) => ({ workflow }),
    ));

    server.registerTool("import_automation_workflow", {
      title: "Import portable Automation workflow",
      description: "Integrity-check and import a credential-free Automation package as an isolated draft on one approved canvas. Deployment slots must be connected again.",
      inputSchema: z.object({ canvas_id: z.string().min(1), package: z.unknown() }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, ({ canvas_id, package: packageValue }) => safeTool(() => importMcpAutomationWorkflow(principal, canvas_id, packageValue), (result) => result));

    server.registerTool("restore_automation_version", {
      title: "Restore Automation version",
      description: "Create a new immutable draft copied from one historical version. Existing versions and run history remain preserved; it is not published automatically.",
      inputSchema: z.object({ workflow_id: z.string().min(1), version_id: z.string().min(1) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, ({ workflow_id, version_id }) => safeTool(() => restoreMcpAutomationVersion(principal, workflow_id, version_id), (workflow) => ({ workflow })));

    server.registerTool("set_system_automation_model", {
      title: "Set system Automation model",
      description: "Change or reset one explicitly editable AI/image model override in a protected system workflow. Use null to reset to its template default.",
      inputSchema: z.object({ workflow_id: z.string().min(1), node_id: z.string().min(1).max(120), model_id: z.string().min(1).max(120).nullable() }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, ({ workflow_id, node_id, model_id }) => safeTool(() => setMcpSystemAutomationModel(principal, { workflowId: workflow_id, nodeId: node_id, modelId: model_id }), (workflow) => ({ workflow })));

    server.registerTool("create_automation_fixture", {
      title: "Create Automation test fixture",
      description: "Save a bounded fixture pinned to the current workflow version for safe single-node previews, using explicit inputs or captured input from an accessible run.",
      inputSchema: z.object({
        workflow_id: z.string().min(1), name: z.string().trim().min(1).max(120), runtime_inputs: jsonRecord.default({}),
        node_inputs: z.record(z.string().max(120), jsonRecord).default({}), source_run_id: z.string().min(1).optional(), source_node_id: z.string().min(1).max(120).optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, ({ workflow_id, name, runtime_inputs, node_inputs, source_run_id, source_node_id }) => safeTool(
      () => createMcpAutomationFixture(principal, { workflowId: workflow_id, name, runtimeInputs: runtime_inputs, nodeInputs: node_inputs, sourceRunId: source_run_id, sourceNodeId: source_node_id }),
      (fixture) => ({ fixture }),
    ));

    server.registerTool("delete_automation_fixture", {
      title: "Delete Automation test fixture",
      description: "Delete one saved test fixture. Workflow versions and run history remain unchanged.",
      inputSchema: z.object({ workflow_id: z.string().min(1), fixture_id: z.string().min(1) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    }, ({ workflow_id, fixture_id }) => safeTool(() => deleteMcpAutomationFixture(principal, workflow_id, fixture_id), (result) => result));

    server.registerTool("create_automation_trigger", {
      title: "Create Automation trigger",
      description: "Create a paused schedule, authenticated webhook, or versioned Canvas-event trigger for a published workflow. Inputs must exactly match its published RUN INPUTS contract. Webhook URL secret is returned once.",
      inputSchema: automationTriggerInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, (input) => safeTool(
      () => createMcpAutomationTrigger(principal, {
        workflowId: input.workflow_id,
        projectId: input.canvas_id,
        type: input.type,
        name: input.name,
        overlapPolicy: input.overlap_policy,
        maxConcurrentRuns: input.max_concurrent_runs,
        config: input.type === "schedule" ? input.schedule : input.type === "canvas-event" ? { event: input.event, version: input.version } : {},
        inputs: input.inputs,
      }, origin),
      (result) => result,
    ));

    server.registerTool("add_automation_node", {
      title: "Add Automation node",
      description: "Add one canonical versioned node to the current draft using registry defaults. Optional config and run bindings are merged over those defaults; the returned draft includes validation issues that remain to be fixed.",
      inputSchema: z.object({
        workflow_id: z.string().min(1), base_draft_version_id: z.string().min(1),
        type: z.string().min(1).max(120), version: z.number().int().positive().optional(), node_id: z.string().min(1).max(120).optional(),
        name: z.string().trim().min(1).max(120).optional(), description: z.string().max(500).optional(), position: point,
        group_id: z.string().min(1).max(120).nullable().optional(), config: jsonRecord.optional(),
        bindings: z.record(z.string(), automationBindingInput).optional(), disabled: z.boolean().optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, ({ workflow_id, base_draft_version_id, type, version, node_id, name, description, position, group_id, config, bindings, disabled }) => safeTool(
      () => addMcpAutomationNode(principal, { workflowId: workflow_id, baseDraftVersionId: base_draft_version_id, type, version, nodeId: node_id, name, description, position, groupId: group_id, config, bindings, disabled }),
      (result) => result,
    ));

    server.registerTool("configure_automation_node", {
      title: "Configure Automation node",
      description: "Patch one existing node without replacing its type or version. Config keys merge, remove_config_fields deletes selected overrides, and a null binding removes that run binding. Re-read the returned draft ID before the next edit.",
      inputSchema: z.object({
        workflow_id: z.string().min(1), base_draft_version_id: z.string().min(1), node_id: z.string().min(1).max(120),
        name: z.string().trim().min(1).max(120).optional(), description: z.string().max(500).optional(), position: point.optional(),
        group_id: z.string().min(1).max(120).nullable().optional(), config: jsonRecord.optional(),
        remove_config_fields: z.array(z.string().min(1).max(120)).max(100).optional(),
        bindings: z.record(z.string(), z.union([automationBindingInput, z.null()])).optional(), disabled: z.boolean().optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, ({ workflow_id, base_draft_version_id, node_id, name, description, position, group_id, config, remove_config_fields, bindings, disabled }) => safeTool(
      () => configureMcpAutomationNode(principal, { workflowId: workflow_id, baseDraftVersionId: base_draft_version_id, nodeId: node_id, name, description, position, groupId: group_id, config, removeConfigFields: remove_config_fields, bindings, disabled }),
      (result) => result,
    ));

    server.registerTool("set_automation_run_input", {
      title: "Set Automation Run input",
      description: "Control whether one runtime-bindable node setting is saved in the step or appears in the left RUN INPUTS sidebar. optional/required adds it immediately with key node-id.field-id; fixed removes it while preserving its current value.",
      inputSchema: z.object({
        workflow_id: z.string().min(1), base_draft_version_id: z.string().min(1),
        node_id: z.string().min(1).max(120), field_id: z.string().min(1).max(120),
        mode: z.enum(["fixed", "optional", "required"]), label: z.string().trim().min(1).max(120).optional(),
        fixed_value: z.unknown().optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, ({ workflow_id, base_draft_version_id, node_id, field_id, mode, label, fixed_value }) => safeTool(
      () => setMcpAutomationRunInput(principal, { workflowId: workflow_id, baseDraftVersionId: base_draft_version_id, nodeId: node_id, fieldId: field_id, mode, label, fixedValue: fixed_value }),
      (result) => result,
    ));

    server.registerTool("connect_automation_nodes", {
      title: "Connect Automation nodes",
      description: "Validate and add one exact typed connection. Invalid ports, roles, duplicate inputs, terminal continuations, cycles, and unsafe Retry routes are rejected before any draft is saved.",
      inputSchema: z.object({
        workflow_id: z.string().min(1), base_draft_version_id: z.string().min(1), edge_id: z.string().min(1).max(160).optional(),
        source_node_id: z.string().min(1).max(120), source_port: z.string().min(1).max(120),
        target_node_id: z.string().min(1).max(120), target_port: z.string().min(1).max(120),
        role: z.enum(["flow", "data", "error", "retry"]),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, ({ workflow_id, base_draft_version_id, edge_id, source_node_id, source_port, target_node_id, target_port, role }) => safeTool(
      () => connectMcpAutomationNodes(principal, { workflowId: workflow_id, baseDraftVersionId: base_draft_version_id, edgeId: edge_id, sourceNodeId: source_node_id, sourcePort: source_port, targetNodeId: target_node_id, targetPort: target_port, role }),
      (result) => result,
    ));

    server.registerTool("remove_automation_connection", {
      title: "Remove Automation connection",
      description: "Remove one exact connection from the current draft. The run history and published version are unchanged.",
      inputSchema: z.object({ workflow_id: z.string().min(1), base_draft_version_id: z.string().min(1), edge_id: z.string().min(1).max(160) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, ({ workflow_id, base_draft_version_id, edge_id }) => safeTool(
      () => removeMcpAutomationConnection(principal, { workflowId: workflow_id, baseDraftVersionId: base_draft_version_id, edgeId: edge_id }),
      (result) => result,
    ));

    server.registerTool("remove_automation_node", {
      title: "Remove Automation node",
      description: "Remove one node, its incident connections, and group membership from the current draft. The published version and previous run history are unchanged.",
      inputSchema: z.object({ workflow_id: z.string().min(1), base_draft_version_id: z.string().min(1), node_id: z.string().min(1).max(120) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, ({ workflow_id, base_draft_version_id, node_id }) => safeTool(
      () => removeMcpAutomationNode(principal, { workflowId: workflow_id, baseDraftVersionId: base_draft_version_id, nodeId: node_id }),
      (result) => result,
    ));

    server.registerTool("configure_automation_workflow", {
      title: "Configure Automation workflow",
      description: "Patch workflow name, description, execution limits, overlap policy, concurrency, budget, or editor viewport while preserving the current graph. Re-read the returned draft ID before the next edit.",
      inputSchema: z.object({
        workflow_id: z.string().min(1), base_draft_version_id: z.string().min(1),
        name: z.string().trim().min(1).max(120).optional(), description: z.string().max(500).optional(),
        settings: automationSettingsInput.optional(), viewport: viewport.optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, ({ workflow_id, base_draft_version_id, name, description, settings, viewport }) => safeTool(
      () => configureMcpAutomationWorkflow(principal, { workflowId: workflow_id, baseDraftVersionId: base_draft_version_id, name, description, settings, viewport }),
      (workflow) => ({ workflow }),
    ));

    server.registerTool("bind_automation_subworkflow", {
      title: "Bind Automation child workflow",
      description: "Connect one deployment slot used by Run workflow or Map workflow to a published workflow in the same workspace. Recursive dependency cycles are rejected.",
      inputSchema: z.object({
        workflow_id: z.string().min(1), slot_key: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), target_workflow_id: z.string().min(1),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, ({ workflow_id, slot_key, target_workflow_id }) => safeTool(
      () => bindMcpAutomationSubworkflow(principal, { workflowId: workflow_id, slotKey: slot_key, targetWorkflowId: target_workflow_id }),
      (binding) => ({ binding }),
    ));

    server.registerTool("unbind_automation_deployment_slot", {
      title: "Unbind Automation deployment slot",
      description: "Disconnect one child-workflow or credential slot. Disconnecting a credential additionally requires the automation:credentials OAuth permission. Secret values are never exposed.",
      inputSchema: z.object({ workflow_id: z.string().min(1), slot_key: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    }, ({ workflow_id, slot_key }) => safeTool(
      () => unbindMcpAutomationDeploymentSlot(principal, { workflowId: workflow_id, slotKey: slot_key }),
      (result) => result,
    ));

    if (principalHasScope(principal, "automation:credentials")) server.registerTool("bind_automation_credential", {
      title: "Bind saved Automation credential",
      description: "Connect one existing saved workspace credential to an HTTP node deployment slot. Only credential metadata crosses MCP; the encrypted secret remains inside Scenelith.",
      inputSchema: z.object({
        workflow_id: z.string().min(1), slot_key: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), credential_id: z.string().min(1),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, ({ workflow_id, slot_key, credential_id }) => safeTool(
      () => bindMcpAutomationCredential(principal, { workflowId: workflow_id, slotKey: slot_key, credentialId: credential_id }),
      (binding) => ({ binding }),
    ));

    server.registerTool("delete_automation_trigger", {
      title: "Delete Automation trigger",
      description: "Permanently remove one automatic trigger. Existing runs and their immutable history remain available.",
      inputSchema: z.object({ trigger_id: z.string().min(1) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, ({ trigger_id }) => safeTool(() => deleteMcpAutomationTrigger(principal, trigger_id), (result) => result));

    server.registerTool("archive_automation_workflow", {
      title: "Archive Automation workflow",
      description: "Archive one user workflow and disable its automatic triggers. Protected system workflows cannot be archived; immutable versions and run history remain stored.",
      inputSchema: z.object({ workflow_id: z.string().min(1) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, ({ workflow_id }) => safeTool(() => archiveMcpAutomationWorkflow(principal, workflow_id), (result) => ({ result })));

    server.registerTool("save_automation_workflow", {
      title: "Save automation workflow",
      description: "Save a new immutable draft version of a user workflow. Pass the current draft ID from get_automation_workflow as base_draft_version_id; conflicts are rejected.",
      inputSchema: z.object({
        workflow_id: z.string().min(1),
        base_draft_version_id: z.string().min(1).nullable(),
        graph: automationWorkflowGraphSchema,
        name: z.string().trim().min(1).max(120).optional(),
        description: z.string().max(500).optional(),
        change_note: z.string().max(500).optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, ({ workflow_id, base_draft_version_id, graph, name, description, change_note }) => safeTool(
      () => saveMcpAutomationWorkflow(principal, { workflowId: workflow_id, baseDraftVersionId: base_draft_version_id, graph, name, description, changeNote: change_note }),
      (workflow) => ({ workflow }),
    ));

    server.registerTool("publish_automation_workflow", {
      title: "Publish automation workflow",
      description: "Publish the current valid draft. Active triggers advance to the published immutable version. Invalid graphs or missing bindings are rejected.",
      inputSchema: z.object({ workflow_id: z.string().min(1) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, ({ workflow_id }) => safeTool(() => publishMcpAutomationWorkflow(principal, workflow_id), (result) => ({ result })));
  }

  if (principalHasScope(principal, "automation:run")) {
    server.registerTool("run_automation_workflow", {
      title: "Run automation workflow",
      description: "Queue an immutable workflow run with explicit run inputs. Production mode may consume provider resources or Cloud credits and can call external integrations configured in the workflow.",
      inputSchema: z.object({ canvas_id: z.string().min(1), workflow_id: z.string().min(1), inputs: jsonRecord.default({}), mode: z.enum(["production", "test"]).default("production") }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, ({ canvas_id, workflow_id, inputs, mode }) => safeTool(
      () => runMcpAutomationWorkflow(principal, { projectId: canvas_id, workflowId: workflow_id, inputs, mode }),
      (run) => ({ run }),
    ));

    server.registerTool("cancel_automation_run", {
      title: "Cancel automation run",
      description: "Cancel a queued or running automation and its active child runs. Completed runs and their history are not deleted.",
      inputSchema: z.object({ run_id: z.string().min(1) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, ({ run_id }) => safeTool(() => cancelMcpAutomationRun(principal, run_id), (result) => ({ result })));

    server.registerTool("preview_automation_node", {
      title: "Preview one Automation node",
      description: "Queue a side-effect-aware single-node preview using one pinned fixture. Poll get_automation_run for captured input, exact output, events, and errors.",
      inputSchema: z.object({ workflow_id: z.string().min(1), fixture_id: z.string().min(1), node_id: z.string().min(1).max(120) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, ({ workflow_id, fixture_id, node_id }) => safeTool(
      () => previewMcpAutomationNode(principal, { workflowId: workflow_id, fixtureId: fixture_id, nodeId: node_id }),
      (run) => ({ run }),
    ));

    server.registerTool("retry_automation_run_from_node", {
      title: "Retry Automation run from node",
      description: "Create a linked immutable retry run from one failed node. Only retry-safe upstream outputs are reused; diagnose the original run before calling this.",
      inputSchema: z.object({ run_id: z.string().min(1), node_id: z.string().min(1).max(120) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, ({ run_id, node_id }) => safeTool(() => retryMcpAutomationRun(principal, run_id, node_id), (run) => ({ run })));

    if (principalHasScope(principal, "automation:write")) server.registerTool("set_automation_trigger_status", {
      title: "Activate or pause Automation trigger",
      description: "Activate or pause one trigger. Activation revalidates its exact inputs and deployment bindings, then pins the workflow's current published immutable version.",
      inputSchema: z.object({ trigger_id: z.string().min(1), status: z.enum(["active", "paused"]) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, ({ trigger_id, status }) => safeTool(() => setMcpAutomationTriggerStatus(principal, trigger_id, status), (result) => ({ result })));

    if (principalHasScope(principal, "automation:write")) server.registerTool("replay_automation_trigger_delivery", {
      title: "Replay failed Automation trigger delivery",
      description: "Replay one dead-letter delivery from its immutable workflow version, runtime inputs, payload, deployment snapshot, and admission policy. Diagnose the original failure first; non-dead-letter deliveries are rejected.",
      inputSchema: z.object({ delivery_id: z.string().min(1) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, ({ delivery_id }) => safeTool(
      () => replayMcpAutomationTriggerDelivery(principal, delivery_id),
      (delivery) => ({ delivery }),
    ));
  }

  return server;
}
