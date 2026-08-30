import { randomUUID } from "node:crypto";
import { db, userCanAccessProject, userCanAccessWorkspace, workspaceIdForProject } from "@/lib/postgres-db";
import { createAutomationPackage, parseAutomationPackage } from "./portable";
import { AUTOMATION_SYSTEM_WORKFLOW_TEMPLATES, DEFAULT_TIKTOK_AUTOMATION_TEMPLATE, automationSystemWorkflowTemplate, type AutomationSystemWorkflowTemplate } from "./system-templates";
import { automationWorkflowGraphSchema, DEFAULT_AUTOMATION_WORKFLOW_SETTINGS, type AutomationWorkflowDetail, type AutomationWorkflowGraph, type AutomationWorkflowRecord, type AutomationWorkflowVersion, type AutomationWorkflowVersionSummary } from "./types";
import { validateAutomationRunInputs, validateAutomationWorkflowGraph } from "./validation";
import { canPerformAutomationAction, requireAutomationPermission } from "./permissions";
import { automationNodeDefinition } from "./registry";
import { generationProvider } from "@/platform/providers/registry";
import { validateAutomationDeploymentBindings } from "./deployment-validation";

type WorkflowRow = {
  id: string;
  workspace_id: string;
  project_id: string | null;
  name: string;
  description: string;
  status: AutomationWorkflowRecord["status"];
  system_key: string | null;
  draft_version_id: string | null;
  published_version_id: string | null;
  source_package_digest: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type VersionRow = {
  id: string;
  workflow_id: string;
  version: number;
  status: AutomationWorkflowVersion["status"];
  graph_json: unknown;
  validation_json: unknown;
  created_by: string | null;
  created_at: string;
  published_at: string | null;
  change_note: string | null;
  restored_from_version_id: string | null;
};

export class AutomationWorkflowDraftConflictError extends Error {
  constructor() {
    super("This workflow changed in another window. Reopen it before saving so newer work is not overwritten.");
    this.name = "AutomationWorkflowDraftConflictError";
  }
}

function jsonValue<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function workflowRecord(row: WorkflowRow): AutomationWorkflowRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    status: row.status,
    systemKey: row.system_key,
    draftVersionId: row.draft_version_id,
    publishedVersionId: row.published_version_id,
    sourcePackageDigest: row.source_package_digest,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function workflowVersion(row: VersionRow): AutomationWorkflowVersion {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    version: Number(row.version),
    status: row.status,
    graph: automationWorkflowGraphSchema.parse(jsonValue(row.graph_json)),
    validation: jsonValue(row.validation_json),
    createdBy: row.created_by,
    createdAt: row.created_at,
    publishedAt: row.published_at,
  };
}

async function versionById(id: string | null) {
  if (!id) return null;
  const row = await db.prepare("SELECT * FROM automation_workflow_versions WHERE id = ?").get(id) as VersionRow | undefined;
  return row ? workflowVersion(row) : null;
}

async function workflowRowById(id: string) {
  return await db.prepare("SELECT * FROM automation_workflows WHERE id = ?").get(id) as WorkflowRow | undefined;
}

type SystemModelOverrideRow = { node_id: string; model_id: string };
const AUTOMATION_AUTOSAVE_HISTORY_LIMIT = 25;

function configurableSystemModelNode(graph: AutomationWorkflowGraph, nodeId: string) {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  const definition = node ? automationNodeDefinition(node.type, node.version) : null;
  const field = definition?.fields.find((candidate) => candidate.id === "modelId" && candidate.kind === "model" && (candidate.modelCapability === "assistant" || candidate.modelCapability === "image"));
  return node && field ? { node, field } : null;
}

function applySystemModelSelection(graph: AutomationWorkflowGraph, defaults: AutomationWorkflowGraph, nodeId: string, modelId: string | null) {
  const configurable = configurableSystemModelNode(graph, nodeId);
  const defaultNode = defaults.nodes.find((candidate) => candidate.id === nodeId);
  const defaultConfigurable = configurableSystemModelNode(defaults, nodeId);
  if (!configurable || !defaultNode || !defaultConfigurable) return false;
  const selectedModelId = modelId || String(defaultNode.config.modelId || "");
  if (!selectedModelId) return false;
  if (configurable.field.modelCapability === "assistant") {
    if (!configurable.field.options?.some((option) => option.value === selectedModelId)) return false;
  } else {
    try {
      const provider = generationProvider();
      const model = provider.getModel(selectedModelId);
      if (model.id !== selectedModelId || model.mediaType !== "image" || model.maxReferences < 1) return false;
      if (modelId) {
        const resolution = String(configurable.node.config.resolution || "");
        const ratio = String(configurable.node.config.ratio || "");
        if (!provider.allowedResolutions(model, false).includes(resolution)) return false;
        if (!provider.allowedRatios(model, resolution, true).includes(ratio)) return false;
      }
    } catch {
      return false;
    }
  }
  configurable.node.config = { ...configurable.node.config, modelId: selectedModelId };
  if (configurable.field.modelCapability !== "image") return true;
  if (!modelId) {
    configurable.node.config = {
      ...configurable.node.config,
      ...(defaultNode.config.resolution !== undefined ? { resolution: defaultNode.config.resolution } : {}),
      ...(defaultNode.config.ratio !== undefined ? { ratio: defaultNode.config.ratio } : {}),
    };
    return true;
  }
  return true;
}

async function applyPersistedSystemModelOverrides(workflowId: string, graph: AutomationWorkflowGraph, defaults: AutomationWorkflowGraph) {
  const rows = await db.prepare("SELECT node_id, model_id FROM automation_system_model_overrides WHERE workflow_id = ? ORDER BY node_id")
    .all(workflowId) as SystemModelOverrideRow[];
  for (const row of rows) applySystemModelSelection(graph, defaults, row.node_id, row.model_id);
  return graph;
}

async function systemAutomationModelIssues(workflowId: string, systemKey: string | null) {
  const template = automationSystemWorkflowTemplate(systemKey || "");
  if (!template) return [];
  const defaults = template.createGraph();
  const rows = await db.prepare("SELECT node_id, model_id FROM automation_system_model_overrides WHERE workflow_id = ? ORDER BY node_id")
    .all(workflowId) as SystemModelOverrideRow[];
  return rows.flatMap((row) => {
    const graph = structuredClone(defaults);
    if (applySystemModelSelection(graph, defaults, row.node_id, row.model_id)) return [];
    const nodeName = defaults.nodes.find((node) => node.id === row.node_id)?.name;
    return [{
      nodeId: row.node_id,
      modelId: row.model_id,
      message: nodeName
        ? `The saved model ${row.model_id} is no longer available for ${nodeName}. The current template default is active instead.`
        : `The saved model ${row.model_id} belongs to a system step that no longer exists. The current template ignored this override.`,
    }];
  });
}

async function advanceSystemWorkflowTriggers(input: {
  workflowId: string;
  workspaceId: string;
  graph: AutomationWorkflowGraph;
  versionId: string;
  now: string;
}) {
  const active = await db.prepare("SELECT id, input_json FROM automation_workflow_triggers WHERE workflow_id = ? AND status = 'active'")
    .all(input.workflowId) as Array<{ id: string; input_json: unknown }>;
  if (!active.length) return;
  const deployment = await validateAutomationDeploymentBindings({ workflowId: input.workflowId, workspaceId: input.workspaceId, graph: input.graph });
  for (const trigger of active) {
    const compatible = deployment.valid && validateAutomationRunInputs(input.graph, jsonValue<Record<string, unknown>>(trigger.input_json)).valid;
    if (compatible) {
      await db.prepare("UPDATE automation_workflow_triggers SET active_version_id = ?, updated_at = ? WHERE id = ? AND status = 'active'")
        .run(input.versionId, input.now, trigger.id);
    } else {
      await db.prepare("UPDATE automation_workflow_triggers SET status = 'paused', active_version_id = NULL, next_fire_at = NULL, updated_at = ? WHERE id = ? AND status = 'active'")
        .run(input.now, trigger.id);
    }
  }
}

async function pruneAutomationAutosaveHistory(workflowId: string) {
  await db.prepare(`WITH expired_autosaves AS (
    SELECT candidate.id
    FROM automation_workflow_versions candidate
    WHERE candidate.workflow_id = ?
      AND candidate.status = 'superseded'
      AND candidate.published_at IS NULL
      AND candidate.change_note IS NULL
      AND NOT EXISTS (SELECT 1 FROM automation_workflow_versions restored WHERE restored.workflow_id = candidate.workflow_id AND restored.restored_from_version_id = candidate.id)
      AND NOT EXISTS (SELECT 1 FROM automation_runs run WHERE run.workflow_id = candidate.workflow_id AND run.workflow_version_id = candidate.id)
      AND NOT EXISTS (SELECT 1 FROM automation_workflow_fixtures fixture WHERE fixture.workflow_id = candidate.workflow_id AND fixture.workflow_version_id = candidate.id)
      AND NOT EXISTS (SELECT 1 FROM automation_workflow_triggers trigger WHERE trigger.workflow_id = candidate.workflow_id AND trigger.active_version_id = candidate.id)
      AND NOT EXISTS (SELECT 1 FROM automation_trigger_deliveries delivery WHERE delivery.workflow_id = candidate.workflow_id AND delivery.workflow_version_id = candidate.id)
    ORDER BY candidate.version DESC
    OFFSET ?
  )
  DELETE FROM automation_workflow_versions version
  USING expired_autosaves expired
  WHERE version.workflow_id = ? AND version.id = expired.id`)
    .run(workflowId, AUTOMATION_AUTOSAVE_HISTORY_LIMIT, workflowId);
}

async function ensureSystemAutomationWorkflow(
  workspaceId: string,
  userId: string,
  template: AutomationSystemWorkflowTemplate,
) {
  return await db.transaction(async () => {
    await db.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`automation-system:${workspaceId}:${template.key}`);
    const current = await db.prepare("SELECT * FROM automation_workflows WHERE workspace_id = ? AND system_key = ?")
      .get(workspaceId, template.key) as (WorkflowRow & { system_revision: number | null }) | undefined;
    const currentRevision = Number(current?.system_revision || 0);
    if (current && currentRevision > template.revision) return workflowRecord(current);
    if (current && currentRevision === template.revision) {
      if (current.name !== template.name || current.description !== template.description || current.status !== "system") {
        const now = new Date().toISOString();
        await db.prepare("UPDATE automation_workflows SET name = ?, description = ?, status = 'system', updated_at = ? WHERE id = ?")
          .run(template.name, template.description, now, current.id);
        return workflowRecord((await workflowRowById(current.id))!);
      }
      return workflowRecord(current);
    }

    const now = new Date().toISOString();
    const defaults = template.createGraph();
    const graph = await applyPersistedSystemModelOverrides(current?.id || "", structuredClone(defaults), defaults);
    const validation = validateAutomationWorkflowGraph(graph);
    if (!validation.valid) throw new Error(`System workflow ${template.key} is invalid: ${validation.issues.map((entry) => entry.message).join("; ")}`);
    const workflowId = current?.id || randomUUID();
    if (!current) {
      await db.prepare(`INSERT INTO automation_workflows
        (id, workspace_id, project_id, name, description, status, system_key, system_revision, created_by, created_at, updated_at)
        VALUES (?, ?, NULL, ?, ?, 'system', ?, ?, ?, ?, ?)`)
        .run(workflowId, workspaceId, template.name, template.description, template.key, template.revision, userId, now, now);
    }
    const latest = await db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM automation_workflow_versions WHERE workflow_id = ?")
      .get(workflowId) as { version: number };
    const versionId = randomUUID();
    const nextVersion = Number(latest.version || 0) + 1;
    if (current?.published_version_id) {
      await db.prepare("UPDATE automation_workflow_versions SET status = 'superseded' WHERE id = ? AND status = 'published'").run(current.published_version_id);
    }
    await db.prepare(`INSERT INTO automation_workflow_versions
      (id, workflow_id, version, status, graph_json, validation_json, created_by, created_at, published_at)
      VALUES (?, ?, ?, 'published', ?, ?, ?, ?, ?)`)
      .run(versionId, workflowId, nextVersion, JSON.stringify(graph), JSON.stringify(validation), userId, now, now);
    await db.prepare(`UPDATE automation_workflows SET
      name = ?, description = ?, status = 'system', system_revision = ?, published_version_id = ?, draft_version_id = NULL, updated_at = ?
      WHERE id = ?`)
      .run(template.name, template.description, template.revision, versionId, now, workflowId);
    await advanceSystemWorkflowTriggers({ workflowId, workspaceId, graph, versionId, now });
    return workflowRecord((await workflowRowById(workflowId))!);
  })();
}

export async function ensureSystemAutomationWorkflows(workspaceId: string, userId: string) {
  const workflows: AutomationWorkflowRecord[] = [];
  for (const template of AUTOMATION_SYSTEM_WORKFLOW_TEMPLATES) {
    workflows.push(await ensureSystemAutomationWorkflow(workspaceId, userId, template));
  }
  return workflows;
}

export async function reconcilePersistedSystemAutomationWorkflows() {
  const actors = await db.prepare(`SELECT DISTINCT ON (workflow.workspace_id)
      workflow.workspace_id, member.user_id
    FROM automation_workflows workflow
    JOIN workspace_members member ON member.workspace_id = workflow.workspace_id
    WHERE workflow.system_key IS NOT NULL
    ORDER BY workflow.workspace_id,
      CASE WHEN member.role = 'owner' THEN 0 ELSE 1 END,
      member.created_at,
      member.user_id`).all() as Array<{ workspace_id: string; user_id: string }>;
  for (const actor of actors) {
    await ensureSystemAutomationWorkflows(actor.workspace_id, actor.user_id);
  }
  return actors.length;
}

export async function ensureDefaultAutomationWorkflow(workspaceId: string, userId: string) {
  return await ensureSystemAutomationWorkflow(workspaceId, userId, DEFAULT_TIKTOK_AUTOMATION_TEMPLATE);
}

export async function listAutomationWorkflows(userId: string, projectId: string) {
  if (!await userCanAccessProject(userId, projectId)) return null;
  const workspaceId = await workspaceIdForProject(projectId);
  if (!workspaceId) return null;
  if (await canPerformAutomationAction(userId, workspaceId, "automation.edit")) {
    await ensureSystemAutomationWorkflows(workspaceId, userId);
  }
  const rows = await db.prepare(`SELECT * FROM automation_workflows
    WHERE workspace_id = ? AND status <> 'archived' AND (project_id IS NULL OR project_id = ?)
    ORDER BY CASE WHEN status = 'system' THEN 0 ELSE 1 END, updated_at DESC`).all(workspaceId, projectId) as WorkflowRow[];
  return rows.map(workflowRecord);
}

export async function archiveAutomationWorkflow(userId: string, workflowId: string) {
  const row = await workflowRowById(workflowId);
  if (!row || !await userCanAccessWorkspace(userId, row.workspace_id)) return null;
  if (row.project_id && !await userCanAccessProject(userId, row.project_id)) return null;
  await requireAutomationPermission(userId, row.workspace_id, "automation.edit");
  if (row.status === "system" || row.system_key) return { protected: true as const, workflow: workflowRecord(row), disconnectedWorkflowIds: [] as string[] };
  if (row.status === "archived") return null;
  return await db.transaction(async () => {
    await db.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`automation-workflow:${workflowId}`);
    const current = await db.prepare("SELECT * FROM automation_workflows WHERE id = ? FOR UPDATE").get(workflowId) as WorkflowRow | undefined;
    if (!current || current.status === "archived") return null;
    if (current.status === "system" || current.system_key) return { protected: true as const, workflow: workflowRecord(current), disconnectedWorkflowIds: [] as string[] };
    const now = new Date().toISOString();
    const parents = await db.prepare("SELECT DISTINCT workflow_id FROM automation_workflow_bindings WHERE target_workflow_id = ?").all(workflowId) as Array<{ workflow_id: string }>;
    await db.prepare("DELETE FROM automation_workflow_bindings WHERE target_workflow_id = ?").run(workflowId);
    await db.prepare(`UPDATE automation_workflow_triggers SET status = 'paused', active_version_id = NULL,
      next_fire_at = NULL, locked_at = NULL, worker_id = NULL, updated_at = ? WHERE workflow_id = ?`).run(now, workflowId);
    await db.prepare(`UPDATE automation_trigger_deliveries SET status = 'cancelled', locked_at = NULL, worker_id = NULL,
      error_code = 'WORKFLOW_DELETED', error = 'Workflow was deleted before delivery', updated_at = ?
      WHERE workflow_id = ? AND status IN ('queued', 'retry_wait')`).run(now, workflowId);
    await db.prepare("UPDATE automation_workflows SET status = 'archived', updated_at = ? WHERE id = ?").run(now, workflowId);
    const archived = await workflowRowById(workflowId);
    return archived ? { protected: false as const, workflow: workflowRecord(archived), disconnectedWorkflowIds: parents.map((parent) => parent.workflow_id) } : null;
  })();
}

export async function getAutomationWorkflow(userId: string, workflowId: string): Promise<AutomationWorkflowDetail | null> {
  const row = await workflowRowById(workflowId);
  if (!row || !await userCanAccessWorkspace(userId, row.workspace_id)) return null;
  if (row.project_id && !await userCanAccessProject(userId, row.project_id)) return null;
  return {
    workflow: workflowRecord(row),
    draft: await versionById(row.draft_version_id),
    published: await versionById(row.published_version_id),
    systemModelIssues: row.status === "system" ? await systemAutomationModelIssues(row.id, row.system_key) : [],
  };
}

export function systemAutomationModelDefaults(systemKey: string | null) {
  const template = automationSystemWorkflowTemplate(systemKey || "");
  if (!template) return {};
  const graph = template.createGraph();
  return Object.fromEntries(graph.nodes.flatMap((node) => configurableSystemModelNode(graph, node.id)
    ? [[`${node.id}.modelId`, String(node.config.modelId || "")]]
    : []));
}

export async function setSystemAutomationModelOverride(input: { userId: string; workflowId: string; nodeId: string; modelId: string | null }) {
  const row = await workflowRowById(input.workflowId);
  if (!row || row.status !== "system" || !row.system_key || !await userCanAccessWorkspace(input.userId, row.workspace_id)) return null;
  await requireAutomationPermission(input.userId, row.workspace_id, "automation.edit");
  const template = automationSystemWorkflowTemplate(row.system_key);
  const published = await versionById(row.published_version_id);
  if (!template || !published) return null;
  const defaults = template.createGraph();
  const graph = structuredClone(published.graph);
  const defaultNode = defaults.nodes.find((node) => node.id === input.nodeId);
  const overrideModelId = input.modelId && input.modelId !== String(defaultNode?.config.modelId || "") ? input.modelId : null;
  const selectionApplied = applySystemModelSelection(graph, defaults, input.nodeId, overrideModelId);
  if (!selectionApplied && input.modelId !== null) {
    throw Object.assign(new Error("This system step does not support that model with its locked settings"), { status: 400 });
  }
  const graphChanged = selectionApplied && JSON.stringify(graph) !== JSON.stringify(published.graph);
  const validation = graphChanged ? validateAutomationWorkflowGraph(graph) : published.validation;
  if (!validation.valid) throw Object.assign(new Error(validation.issues.map((issue) => issue.message).join(" ")), { status: 400 });
  const now = new Date().toISOString();
  await db.transaction(async () => {
    await db.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`automation-system-model:${row.id}`);
    const current = await workflowRowById(row.id);
    if (!current || current.status !== "system" || current.published_version_id !== published.id) {
      throw Object.assign(new Error("The system workflow changed. Reopen it and choose the model again."), { status: 409 });
    }
    if (overrideModelId) {
      await db.prepare(`INSERT INTO automation_system_model_overrides
        (workflow_id, workspace_id, node_id, model_id, updated_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (workflow_id, node_id) DO UPDATE SET model_id = excluded.model_id, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .run(row.id, row.workspace_id, input.nodeId, overrideModelId, input.userId, now, now);
    } else {
      await db.prepare("DELETE FROM automation_system_model_overrides WHERE workflow_id = ? AND node_id = ?")
        .run(row.id, input.nodeId);
    }
    if (!graphChanged) return;
    const latest = await db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM automation_workflow_versions WHERE workflow_id = ?")
      .get(row.id) as { version: number };
    const versionId = randomUUID();
    await db.prepare("UPDATE automation_workflow_versions SET status = 'superseded' WHERE id = ? AND status = 'published'").run(published.id);
    await db.prepare(`INSERT INTO automation_workflow_versions
      (id, workflow_id, version, status, graph_json, validation_json, created_by, created_at, published_at, change_note)
      VALUES (?, ?, ?, 'published', ?, ?, ?, ?, ?, ?)`)
      .run(versionId, row.id, Number(latest.version || 0) + 1, JSON.stringify(graph), JSON.stringify(validation), input.userId, now, now, overrideModelId ? `Changed ${input.nodeId} model` : `Reset ${input.nodeId} model`);
    await db.prepare("UPDATE automation_workflows SET published_version_id = ?, updated_at = ? WHERE id = ?")
      .run(versionId, now, row.id);
    await advanceSystemWorkflowTriggers({ workflowId: row.id, workspaceId: row.workspace_id, graph, versionId, now });
  })();
  return await getAutomationWorkflow(input.userId, row.id);
}

export async function createAutomationWorkflow(input: {
  userId: string;
  projectId: string;
  name: string;
  description?: string;
  sourceWorkflowId?: string;
}) {
  if (!await userCanAccessProject(input.userId, input.projectId)) return null;
  const workspaceId = await workspaceIdForProject(input.projectId);
  if (!workspaceId) return null;
  await requireAutomationPermission(input.userId, workspaceId, "automation.edit");
  let graph: AutomationWorkflowGraph = {
    schemaVersion: 1,
    nodes: [{ id: "manual-run", type: "core.manual-trigger", version: 1, name: "Run", description: "Start from the Automation panel.", position: { x: 0, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false }],
    edges: [], groups: [], settings: { ...DEFAULT_AUTOMATION_WORKFLOW_SETTINGS }, viewport: { x: 120, y: 180, zoom: 1 },
  };
  if (input.sourceWorkflowId) {
    const source = await getAutomationWorkflow(input.userId, input.sourceWorkflowId);
    if (!source) return null;
    graph = structuredClone((source.draft || source.published)!.graph);
  }
  const now = new Date().toISOString();
  const workflowId = randomUUID();
  const versionId = randomUUID();
  const validation = validateAutomationWorkflowGraph(graph);
  await db.transaction(async () => {
    await db.prepare(`INSERT INTO automation_workflows
      (id, workspace_id, project_id, name, description, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)`)
      .run(workflowId, workspaceId, input.projectId, input.name.trim().slice(0, 120), (input.description || "").trim().slice(0, 500), input.userId, now, now);
    await db.prepare(`INSERT INTO automation_workflow_versions
      (id, workflow_id, version, status, graph_json, validation_json, created_by, created_at)
      VALUES (?, ?, 1, 'draft', ?, ?, ?, ?)`)
      .run(versionId, workflowId, JSON.stringify(graph), JSON.stringify(validation), input.userId, now);
    await db.prepare("UPDATE automation_workflows SET draft_version_id = ? WHERE id = ?").run(versionId, workflowId);
  })();
  return await getAutomationWorkflow(input.userId, workflowId);
}

export async function exportAutomationWorkflowPackage(input: {
  userId: string;
  workflowId: string;
  version: "published" | "draft";
}) {
  const detail = await getAutomationWorkflow(input.userId, input.workflowId);
  if (!detail) return null;
  const selected = input.version === "draft" ? detail.draft : detail.published;
  if (!selected) return { error: `Workflow has no ${input.version} version` } as const;
  return {
    package: createAutomationPackage({
      name: detail.workflow.name,
      description: detail.workflow.description,
      graph: selected.graph,
    }),
    filename: `${detail.workflow.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72) || "scenelith-automation"}.scenelith-automation.json`,
  };
}

export async function importAutomationWorkflowPackage(input: {
  userId: string;
  projectId: string;
  package: unknown;
}) {
  if (!await userCanAccessProject(input.userId, input.projectId)) return null;
  const workspaceId = await workspaceIdForProject(input.projectId);
  if (!workspaceId) return null;
  await requireAutomationPermission(input.userId, workspaceId, "automation.edit");
  const portable = parseAutomationPackage(input.package);
  const now = new Date().toISOString();
  const workflowId = randomUUID();
  const versionId = randomUUID();
  const validation = validateAutomationWorkflowGraph(portable.graph);
  await db.transaction(async () => {
    await db.prepare(`INSERT INTO automation_workflows
      (id, workspace_id, project_id, name, description, status, source_package_digest, source_package_metadata_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`)
      .run(
        workflowId,
        workspaceId,
        input.projectId,
        portable.metadata.name,
        portable.metadata.description.slice(0, 500),
        portable.integrity.digest,
        JSON.stringify({ format: portable.format, version: portable.version, minimumScenelithVersion: portable.minimumScenelithVersion, metadata: portable.metadata, requirements: portable.requirements }),
        input.userId,
        now,
        now,
      );
    await db.prepare(`INSERT INTO automation_workflow_versions
      (id, workflow_id, version, status, graph_json, validation_json, created_by, created_at)
      VALUES (?, ?, 1, 'draft', ?, ?, ?, ?)`)
      .run(versionId, workflowId, JSON.stringify(portable.graph), JSON.stringify(validation), input.userId, now);
    await db.prepare("UPDATE automation_workflows SET draft_version_id = ? WHERE id = ?").run(versionId, workflowId);
  })();
  return { detail: await getAutomationWorkflow(input.userId, workflowId), package: portable, validation };
}

export async function listAutomationWorkflowVersions(userId: string, workflowId: string): Promise<AutomationWorkflowVersionSummary[] | null> {
  const detail = await getAutomationWorkflow(userId, workflowId);
  if (!detail) return null;
  const canInspectVersions = await canPerformAutomationAction(userId, detail.workflow.workspaceId, "automation.edit")
    || await canPerformAutomationAction(userId, detail.workflow.workspaceId, "automation.publish");
  if (!canInspectVersions) await requireAutomationPermission(userId, detail.workflow.workspaceId, "automation.edit");
  const rows = await db.prepare(`SELECT id, workflow_id, version, status, validation_json, created_by, created_at, published_at, change_note, restored_from_version_id
    FROM automation_workflow_versions WHERE workflow_id = ? ORDER BY version DESC`).all(workflowId) as VersionRow[];
  return rows.map((row) => ({
    id: row.id,
    workflowId: row.workflow_id,
    version: Number(row.version),
    status: row.status,
    validation: jsonValue(row.validation_json),
    createdBy: row.created_by,
    createdAt: row.created_at,
    publishedAt: row.published_at,
    changeNote: row.change_note,
    restoredFromVersionId: row.restored_from_version_id,
  }));
}

export async function restoreAutomationWorkflowVersion(input: { userId: string; workflowId: string; versionId: string }) {
  const row = await workflowRowById(input.workflowId);
  if (!row || row.status === "system" || !await userCanAccessWorkspace(input.userId, row.workspace_id)) return null;
  if (row.project_id && !await userCanAccessProject(input.userId, row.project_id)) return null;
  await requireAutomationPermission(input.userId, row.workspace_id, "automation.edit");
  await db.transaction(async () => {
    await db.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`automation-workflow:${row.id}`);
    const current = await workflowRowById(row.id);
    const historicalRow = await db.prepare("SELECT * FROM automation_workflow_versions WHERE workflow_id = ? AND id = ?").get(row.id, input.versionId) as VersionRow | undefined;
    if (!current || current.status === "system" || !historicalRow) throw new Error("Workflow version is no longer available");
    const historical = workflowVersion(historicalRow);
    const latest = await db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM automation_workflow_versions WHERE workflow_id = ?").get(row.id) as { version: number };
    const versionId = randomUUID();
    const now = new Date().toISOString();
    if (current.draft_version_id) await db.prepare("UPDATE automation_workflow_versions SET status = 'superseded' WHERE id = ? AND status = 'draft'").run(current.draft_version_id);
    await db.prepare(`INSERT INTO automation_workflow_versions
      (id, workflow_id, version, status, graph_json, validation_json, created_by, created_at, change_note, restored_from_version_id)
      VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`)
      .run(versionId, row.id, Number(latest.version || 0) + 1, JSON.stringify(historical.graph), JSON.stringify(historical.validation), input.userId, now, `Restored from version ${historical.version}`, historical.id);
    await db.prepare("UPDATE automation_workflows SET status = 'draft', draft_version_id = ?, updated_at = ? WHERE id = ?")
      .run(versionId, now, row.id);
  })();
  return await getAutomationWorkflow(input.userId, row.id);
}

export async function saveAutomationWorkflowDraft(input: {
  userId: string;
  workflowId: string;
  baseDraftVersionId: string | null;
  graph: AutomationWorkflowGraph;
  name?: string;
  description?: string;
  changeNote?: string;
}) {
  const row = await workflowRowById(input.workflowId);
  if (!row || row.status === "system" || !await userCanAccessWorkspace(input.userId, row.workspace_id)) return null;
  if (row.project_id && !await userCanAccessProject(input.userId, row.project_id)) return null;
  await requireAutomationPermission(input.userId, row.workspace_id, "automation.edit");
  const graph = automationWorkflowGraphSchema.parse(input.graph);
  const validation = validateAutomationWorkflowGraph(graph);
  const now = new Date().toISOString();
  await db.transaction(async () => {
    await db.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`automation-workflow:${row.id}`);
    const current = await workflowRowById(row.id);
    if (!current || current.status === "system") throw new Error("Workflow is no longer editable");
    if (current.draft_version_id !== input.baseDraftVersionId) throw new AutomationWorkflowDraftConflictError();
    const latest = await db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM automation_workflow_versions WHERE workflow_id = ?")
      .get(row.id) as { version: number };
    const versionId = randomUUID();
    if (current.draft_version_id) await db.prepare("UPDATE automation_workflow_versions SET status = 'superseded' WHERE id = ? AND status = 'draft'").run(current.draft_version_id);
    await db.prepare(`INSERT INTO automation_workflow_versions
      (id, workflow_id, version, status, graph_json, validation_json, created_by, created_at, change_note)
      VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)`)
      .run(versionId, row.id, Number(latest.version || 0) + 1, JSON.stringify(graph), JSON.stringify(validation), input.userId, now, input.changeNote?.trim().slice(0, 500) || null);
    await db.prepare(`UPDATE automation_workflows SET
      name = COALESCE(?, name), description = COALESCE(?, description), status = 'draft', draft_version_id = ?, updated_at = ?
      WHERE id = ?`)
      .run(input.name?.trim().slice(0, 120) || null, input.description?.trim().slice(0, 500) ?? null, versionId, now, row.id);
    await pruneAutomationAutosaveHistory(row.id);
  })();
  return await getAutomationWorkflow(input.userId, row.id);
}

export async function publishAutomationWorkflow(userId: string, workflowId: string) {
  const row = await workflowRowById(workflowId);
  if (!row || row.status === "system" || !await userCanAccessWorkspace(userId, row.workspace_id)) return null;
  if (row.project_id && !await userCanAccessProject(userId, row.project_id)) return null;
  await requireAutomationPermission(userId, row.workspace_id, "automation.publish");
  const outcome = await db.transaction(async () => {
    await db.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`automation-workflow:${row.id}`);
    const current = await workflowRowById(row.id);
    if (!current || current.status === "system" || !current.draft_version_id) return { kind: "missing" as const };
    const draft = await versionById(current.draft_version_id);
    if (!draft) return { kind: "missing" as const };
    const validation = validateAutomationWorkflowGraph(draft.graph);
    if (!validation.valid) return { kind: "invalid" as const, validation };
    const deployment = await validateAutomationDeploymentBindings({ workflowId: row.id, workspaceId: row.workspace_id, graph: draft.graph });
    if (!deployment.valid) {
      return { kind: "invalid" as const, validation: { valid: false, issues: deployment.issues } };
    }
    const activeTriggers = await db.prepare("SELECT id, input_json FROM automation_workflow_triggers WHERE workflow_id = ? AND status = 'active'").all(row.id) as Array<{ id: string; input_json: unknown }>;
    const triggerIssues = activeTriggers.flatMap((trigger) => validateAutomationRunInputs(draft.graph, jsonValue(trigger.input_json)).issues.map((entry) => ({
      ...entry,
      code: `ACTIVE_TRIGGER_${entry.code}`,
      message: `Active trigger ${trigger.id} is incompatible with this version: ${entry.message}`,
    })));
    if (triggerIssues.length) {
      return { kind: "invalid" as const, validation: { valid: false, issues: triggerIssues } };
    }
    const now = new Date().toISOString();
    if (current.published_version_id) await db.prepare("UPDATE automation_workflow_versions SET status = 'superseded' WHERE id = ? AND status = 'published'").run(current.published_version_id);
    await db.prepare("UPDATE automation_workflow_versions SET status = 'published', validation_json = ?, published_at = ? WHERE id = ? AND status = 'draft'")
      .run(JSON.stringify(validation), now, draft.id);
    await db.prepare("UPDATE automation_workflows SET status = 'published', published_version_id = ?, draft_version_id = NULL, updated_at = ? WHERE id = ?")
      .run(draft.id, now, row.id);
    for (const trigger of activeTriggers) {
      await db.prepare("UPDATE automation_workflow_triggers SET active_version_id = ?, updated_at = ? WHERE id = ? AND status = 'active'")
        .run(draft.id, now, trigger.id);
    }
    return { kind: "published" as const, validation };
  })();
  if (outcome.kind === "missing") return null;
  return { detail: await getAutomationWorkflow(userId, workflowId), validation: outcome.validation, published: outcome.kind === "published" };
}
