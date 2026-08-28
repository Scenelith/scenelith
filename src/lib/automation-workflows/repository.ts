import { randomUUID } from "node:crypto";
import { db, userCanAccessProject, userCanAccessWorkspace, workspaceIdForProject } from "@/lib/postgres-db";
import { createAutomationPackage, parseAutomationPackage } from "./portable";
import { AUTOMATION_SYSTEM_WORKFLOW_TEMPLATES, DEFAULT_TIKTOK_AUTOMATION_TEMPLATE, type AutomationSystemWorkflowTemplate } from "./system-templates";
import { automationWorkflowGraphSchema, DEFAULT_AUTOMATION_WORKFLOW_SETTINGS, type AutomationWorkflowDetail, type AutomationWorkflowGraph, type AutomationWorkflowRecord, type AutomationWorkflowVersion, type AutomationWorkflowVersionSummary } from "./types";
import { validateAutomationRunInputs, validateAutomationWorkflowGraph } from "./validation";
import { canPerformAutomationAction, requireAutomationPermission } from "./permissions";

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
    const graph = template.createGraph();
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

export async function getAutomationWorkflow(userId: string, workflowId: string): Promise<AutomationWorkflowDetail | null> {
  const row = await workflowRowById(workflowId);
  if (!row || !await userCanAccessWorkspace(userId, row.workspace_id)) return null;
  if (row.project_id && !await userCanAccessProject(userId, row.project_id)) return null;
  return {
    workflow: workflowRecord(row),
    draft: await versionById(row.draft_version_id),
    published: await versionById(row.published_version_id),
  };
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
    const now = new Date().toISOString();
    const activeTriggers = await db.prepare("SELECT id, input_json FROM automation_workflow_triggers WHERE workflow_id = ? AND status = 'active'").all(row.id) as Array<{ id: string; input_json: unknown }>;
    const incompatibleTriggerIds = activeTriggers.filter((trigger) => !validateAutomationRunInputs(draft.graph, jsonValue(trigger.input_json)).valid).map((trigger) => trigger.id);
    if (incompatibleTriggerIds.length) {
      for (const triggerId of incompatibleTriggerIds) await db.prepare("UPDATE automation_workflow_triggers SET status = 'paused', updated_at = ? WHERE id = ?").run(now, triggerId);
    }
    if (current.published_version_id) await db.prepare("UPDATE automation_workflow_versions SET status = 'superseded' WHERE id = ? AND status = 'published'").run(current.published_version_id);
    await db.prepare("UPDATE automation_workflow_versions SET status = 'published', validation_json = ?, published_at = ? WHERE id = ? AND status = 'draft'")
      .run(JSON.stringify(validation), now, draft.id);
    await db.prepare("UPDATE automation_workflows SET status = 'published', published_version_id = ?, draft_version_id = NULL, updated_at = ? WHERE id = ?")
      .run(draft.id, now, row.id);
    return { kind: "published" as const, validation, pausedTriggerCount: incompatibleTriggerIds.length };
  })();
  if (outcome.kind === "missing") return null;
  return { detail: await getAutomationWorkflow(userId, workflowId), validation: outcome.validation, published: outcome.kind === "published", pausedTriggerCount: outcome.kind === "published" ? outcome.pausedTriggerCount : 0 };
}
