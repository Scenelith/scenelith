import { db } from "@/lib/postgres-db";
import { automationNodeDefinition } from "./registry";
import { automationRunInputFields, validateAutomationRunInputs } from "./validation";
import { automationWorkflowGraphSchema, DEFAULT_AUTOMATION_WORKFLOW_SETTINGS, type AutomationNode, type AutomationValidationIssue, type AutomationWorkflowGraph } from "./types";
import { z } from "zod";

type BindingRow = {
  slot_key: string;
  binding_type: "credential" | "subworkflow";
  credential_kind: string | null;
  credential_id: string | null;
  target_workflow_id: string | null;
  published_version_id: string | null;
  graph_json: unknown;
};

export const automationDeploymentSnapshotSchema = z.object({
  version: z.literal(1),
  workflows: z.record(z.string().min(1), z.object({
    credentials: z.record(z.string().min(1), z.object({ credentialId: z.string().min(1), kind: z.string().min(1) }).strict()),
    subworkflows: z.record(z.string().min(1), z.object({ workflowId: z.string().min(1), workflowVersionId: z.string().min(1) }).strict()),
  }).strict()),
}).strict();

export type AutomationDeploymentSnapshot = z.infer<typeof automationDeploymentSnapshotSchema>;

export function parseAutomationDeploymentSnapshot(value: unknown): AutomationDeploymentSnapshot {
  return automationDeploymentSnapshotSchema.parse(value);
}

function jsonValue<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function slotsForGraph(graph: AutomationWorkflowGraph) {
  const credentials = new Map<string, { kind: string; nodeIds: string[] }>();
  const subworkflows = new Map<string, { nodes: AutomationNode[] }>();
  for (const node of graph.nodes.filter((candidate) => !candidate.disabled)) {
    const definition = automationNodeDefinition(node.type, node.version);
    const setting = (fieldId: string) => node.bindings[fieldId]?.mode === "fixed" && node.bindings[fieldId].value !== undefined
      ? node.bindings[fieldId].value
      : node.config[fieldId] ?? definition?.fields.find((field) => field.id === fieldId)?.defaultValue;
    const credentialSlot = String(setting("credentialSlot") || "").trim();
    if (credentialSlot) {
      const kind = String(setting("credentialKind") || "api-key");
      const current = credentials.get(credentialSlot);
      if (current) current.nodeIds.push(node.id);
      else credentials.set(credentialSlot, { kind, nodeIds: [node.id] });
    }
    const subworkflowSlot = String(setting("subworkflowSlot") || "").trim();
    if (subworkflowSlot) {
      const current = subworkflows.get(subworkflowSlot);
      if (current) current.nodes.push(node);
      else subworkflows.set(subworkflowSlot, { nodes: [node] });
    }
  }
  return { credentials, subworkflows };
}

export async function validateAutomationDeploymentBindings(input: {
  workflowId: string;
  workspaceId: string;
  graph: AutomationWorkflowGraph;
}) {
  const issues: AutomationValidationIssue[] = [];
  const deepestVisit = new Map<string, number>();
  const snapshot: AutomationDeploymentSnapshot = { version: 1, workflows: {} };
  const maximumDepth = input.graph.settings?.maxSubworkflowDepth ?? DEFAULT_AUTOMATION_WORKFLOW_SETTINGS.maxSubworkflowDepth;

  const visit = async (workflowId: string, graph: AutomationWorkflowGraph, path: string[]) => {
    const depth = path.length - 1;
    const priorDepth = deepestVisit.get(workflowId);
    if (priorDepth !== undefined && priorDepth >= depth) return;
    deepestVisit.set(workflowId, depth);
    const slots = slotsForGraph(graph);
    const rows = await db.prepare(`SELECT binding.slot_key, binding.binding_type, binding.credential_id, credential.kind AS credential_kind,
      binding.target_workflow_id, target.published_version_id, version.graph_json
      FROM automation_workflow_bindings binding
      LEFT JOIN automation_credentials credential ON credential.id = binding.credential_id AND credential.workspace_id = binding.workspace_id
      LEFT JOIN automation_workflows target ON target.id = binding.target_workflow_id AND target.workspace_id = binding.workspace_id
      LEFT JOIN automation_workflow_versions version ON version.id = target.published_version_id
      WHERE binding.workflow_id = ? AND binding.workspace_id = ?`).all(workflowId, input.workspaceId) as BindingRow[];
    const bindings = new Map(rows.map((row) => [row.slot_key, row]));
    const workflowSnapshot = snapshot.workflows[workflowId] ||= { credentials: {}, subworkflows: {} };

    for (const [slot, requirement] of slots.credentials) {
      const binding = bindings.get(slot);
      if (!binding || binding.binding_type !== "credential" || !binding.credential_kind) {
        issues.push({ code: "CREDENTIAL_BINDING_MISSING", message: `Connect credential slot “${slot}” before running this workflow.`, nodeId: requirement.nodeIds[0] });
      } else if (binding.credential_kind !== requirement.kind) {
        issues.push({ code: "CREDENTIAL_KIND_MISMATCH", message: `Credential slot “${slot}” expects ${requirement.kind}, but ${binding.credential_kind} is connected.`, nodeId: requirement.nodeIds[0] });
      } else if (binding.credential_id) {
        workflowSnapshot.credentials[slot] = { credentialId: binding.credential_id, kind: binding.credential_kind };
      }
    }
    for (const [slot, requirement] of slots.subworkflows) {
      const binding = bindings.get(slot);
      if (!binding || binding.binding_type !== "subworkflow" || !binding.target_workflow_id) {
        issues.push({ code: "SUBWORKFLOW_BINDING_MISSING", message: `Connect workflow slot “${slot}” before running this workflow.`, nodeId: requirement.nodes[0]?.id });
        continue;
      }
      if (!binding.published_version_id || !binding.graph_json) {
        issues.push({ code: "SUBWORKFLOW_NOT_PUBLISHED", message: `The workflow connected to “${slot}” must be ready to run.`, nodeId: requirement.nodes[0]?.id });
        continue;
      }
      const childGraph = automationWorkflowGraphSchema.parse(jsonValue(binding.graph_json));
      const childFields = new Map(automationRunInputFields(childGraph).map((field) => [field.key, field]));
      for (const node of requirement.nodes) {
        const definition = automationNodeDefinition(node.type, node.version);
        const setting = (fieldId: string) => node.bindings[fieldId]?.mode === "fixed" && node.bindings[fieldId].value !== undefined
          ? node.bindings[fieldId].value
          : node.config[fieldId] ?? definition?.fields.find((field) => field.id === fieldId)?.defaultValue;
        const fixedInputs = setting("childInputs");
        const runtimeInputs = fixedInputs && typeof fixedInputs === "object" && !Array.isArray(fixedInputs)
          ? structuredClone(fixedInputs as Record<string, unknown>) : {};
        for (const childNode of childGraph.nodes.filter((candidate) => candidate.type === "input.workflow-data")) {
          const dynamicField = childFields.get(`${childNode.id}.value`);
          if (!dynamicField) continue;
          runtimeInputs[dynamicField.key] = dynamicField.valueType === "boolean" ? false
            : dynamicField.valueType === "number" ? 0
              : dynamicField.valueType === "json" ? {}
                : dynamicField.options?.[0]?.value || "deployment-preflight";
        }
        const inputValidation = validateAutomationRunInputs(childGraph, runtimeInputs);
        for (const childIssue of inputValidation.issues) {
          issues.push({
            code: `SUBWORKFLOW_${childIssue.code}`,
            message: `“${node.name}” does not satisfy workflow slot “${slot}”: ${childIssue.message}`,
            nodeId: node.id,
          });
        }
      }
      workflowSnapshot.subworkflows[slot] = { workflowId: binding.target_workflow_id, workflowVersionId: binding.published_version_id };
      if (path.includes(binding.target_workflow_id)) {
        issues.push({ code: "SUBWORKFLOW_RECURSION", message: `Workflow slot “${slot}” creates a recursive workflow chain.`, nodeId: requirement.nodes[0]?.id });
        continue;
      }
      const nextDepth = path.length;
      if (nextDepth > maximumDepth) {
        issues.push({ code: "SUBWORKFLOW_DEPTH_LIMIT", message: `Workflow slot “${slot}” exceeds the root workflow limit of ${maximumDepth} nested level${maximumDepth === 1 ? "" : "s"}.`, nodeId: requirement.nodes[0]?.id });
        continue;
      }
      await visit(binding.target_workflow_id, childGraph, [...path, binding.target_workflow_id]);
    }
  };

  await visit(input.workflowId, input.graph, [input.workflowId]);
  const uniqueIssues = [...new Map(issues.map((entry) => [`${entry.code}\u0000${entry.nodeId || ""}\u0000${entry.message}`, entry])).values()];
  return { valid: uniqueIssues.length === 0, issues: uniqueIssues, snapshot };
}
