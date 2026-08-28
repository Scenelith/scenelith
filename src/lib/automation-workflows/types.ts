import { z } from "zod";

export const automationPortTypes = [
  "run-context",
  "tiktok-source",
  "identity",
  "visual-references",
  "source-analysis",
  "creative-plan",
  "text-sequence",
  "reference-plan",
  "slide-plan-set",
  "review-result",
  "generated-assets",
  "canvas-result",
  "workflow-result",
  "data",
  "error",
] as const;

export type AutomationPortType = (typeof automationPortTypes)[number];

export const automationBindingSchema = z.object({
  mode: z.enum(["fixed", "ask-on-run"]).default("fixed"),
  value: z.unknown().optional(),
  label: z.string().max(120).optional(),
  required: z.boolean().default(false),
}).strict();

export type AutomationBinding = z.infer<typeof automationBindingSchema>;

export const automationNodeSchema = z.object({
  id: z.string().min(1).max(120),
  type: z.string().min(1).max(120),
  version: z.number().int().positive().default(1),
  name: z.string().min(1).max(120),
  description: z.string().max(500).default(""),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
  groupId: z.string().min(1).max(120).nullable().default(null),
  config: z.record(z.string(), z.unknown()).default({}),
  bindings: z.record(z.string(), automationBindingSchema).default({}),
  disabled: z.boolean().default(false),
}).strict();

export type AutomationNode = z.infer<typeof automationNodeSchema>;

export const automationEdgeRoles = ["flow", "data", "error"] as const;
export type AutomationEdgeRole = (typeof automationEdgeRoles)[number];

export const automationEdgeSchema = z.object({
  id: z.string().min(1).max(160),
  source: z.string().min(1).max(120),
  sourcePort: z.string().min(1).max(120),
  target: z.string().min(1).max(120),
  targetPort: z.string().min(1).max(120),
  /**
   * `flow` is the readable execution route shown on the canvas. `data` is
   * supporting information consumed by a later step. Roles affect execution
   * semantics; the editor keeps every saved connection visible as a solid line.
   * when that step is selected. `error` is an explicit recovery route.
   *
   * Optional keeps version-one portable workflows importable. The runtime and
   * editor treat a missing role as `flow`; newly authored graphs always store
   * the role explicitly.
   */
  role: z.enum(automationEdgeRoles).optional(),
}).strict();

export type AutomationEdge = z.infer<typeof automationEdgeSchema>;

export const automationGroupSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(120),
  description: z.string().max(500).default(""),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
  size: z.object({ width: z.number().min(240).max(2400), height: z.number().min(160).max(1800) }).strict(),
  collapsedByDefault: z.boolean().default(true),
  nodeIds: z.array(z.string().min(1).max(120)).min(1),
}).strict();

export type AutomationGroup = z.infer<typeof automationGroupSchema>;

export const automationAnnotationSchema = z.object({
  id: z.string().min(1).max(120),
  kind: z.literal("sticky-note"),
  title: z.string().min(1).max(120),
  markdown: z.string().max(30_000),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
  size: z.object({ width: z.number().min(320).max(2400), height: z.number().min(220).max(1600) }).strict(),
  color: z.enum(["yellow", "blue", "rose", "gray"]).default("yellow"),
}).strict();

export type AutomationAnnotation = z.infer<typeof automationAnnotationSchema>;

export const automationWorkflowSettingsSchema = z.object({
  timeoutSeconds: z.number().int().min(60).max(86_400).default(3_600),
  maxNodeExecutions: z.number().int().min(1).max(100_000).default(5_000),
  maxGeneratedAssets: z.number().int().min(1).max(5_000).default(200),
  maxCredits: z.number().int().nonnegative().max(1_000_000_000).nullable().default(null),
  maxParallelism: z.number().int().min(1).max(32).default(8),
  maxSubworkflowDepth: z.number().int().min(1).max(16).default(8),
  overlapPolicy: z.enum(["queue", "skip", "cancel-previous"]).default("queue"),
  maxConcurrentRuns: z.number().int().min(1).max(32).default(1),
}).strict();

export type AutomationWorkflowSettings = z.infer<typeof automationWorkflowSettingsSchema>;
export const DEFAULT_AUTOMATION_WORKFLOW_SETTINGS: AutomationWorkflowSettings = {
  timeoutSeconds: 3_600,
  maxNodeExecutions: 5_000,
  maxGeneratedAssets: 200,
  maxCredits: null,
  maxParallelism: 8,
  maxSubworkflowDepth: 8,
  overlapPolicy: "queue",
  maxConcurrentRuns: 1,
};

export const automationWorkflowGraphSchema = z.object({
  schemaVersion: z.literal(1),
  nodes: z.array(automationNodeSchema).min(1).max(500),
  edges: z.array(automationEdgeSchema).max(2_000),
  groups: z.array(automationGroupSchema).max(80).default([]),
  annotations: z.array(automationAnnotationSchema).max(80).default([]),
  settings: automationWorkflowSettingsSchema.default(DEFAULT_AUTOMATION_WORKFLOW_SETTINGS),
  viewport: z.object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().min(0.05).max(4) }).strict().optional(),
}).strict().superRefine((graph, context) => {
  try {
    if (JSON.stringify(graph).length > 2_000_000) context.addIssue({ code: "custom", message: "Workflow graph is larger than the 2 MB safety limit" });
  } catch {
    context.addIssue({ code: "custom", message: "Workflow graph must be serializable" });
  }
});

// Node and edge contracts are always normalized. Workflow authors may omit the
// policy block; persistence and package boundaries materialize its defaults.
// Keeping only the outer default optional prevents optional node-version/config
// fields from leaking into the editor and runtime types.
export type AutomationWorkflowGraph = {
  schemaVersion: 1;
  nodes: AutomationNode[];
  edges: AutomationEdge[];
  groups: AutomationGroup[];
  annotations?: AutomationAnnotation[];
  settings?: AutomationWorkflowSettings;
  viewport?: { x: number; y: number; zoom: number };
};

export const automationWorkflowStatusSchema = z.enum(["system", "draft", "published", "archived"]);
export type AutomationWorkflowStatus = z.infer<typeof automationWorkflowStatusSchema>;

export const automationWorkflowRecordSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  projectId: z.string().nullable(),
  name: z.string().min(1).max(120),
  description: z.string().max(500),
  status: automationWorkflowStatusSchema,
  systemKey: z.string().nullable(),
  draftVersionId: z.string().nullable(),
  publishedVersionId: z.string().nullable(),
  sourcePackageDigest: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type AutomationWorkflowRecord = z.infer<typeof automationWorkflowRecordSchema>;

export const automationWorkflowVersionSchema = z.object({
  id: z.string().min(1),
  workflowId: z.string().min(1),
  version: z.number().int().positive(),
  status: z.enum(["draft", "published", "superseded"]),
  graph: automationWorkflowGraphSchema,
  validation: z.object({
    valid: z.boolean(),
    issues: z.array(z.object({
      code: z.string(),
      message: z.string(),
      nodeId: z.string().optional(),
      edgeId: z.string().optional(),
    })),
  }),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  publishedAt: z.string().nullable(),
});

export type AutomationWorkflowVersion = z.infer<typeof automationWorkflowVersionSchema>;

export type AutomationWorkflowVersionSummary = Pick<AutomationWorkflowVersion, "id" | "workflowId" | "version" | "status" | "validation" | "createdBy" | "createdAt" | "publishedAt"> & {
  changeNote: string | null;
  restoredFromVersionId: string | null;
};

export type AutomationWorkflowDetail = {
  workflow: AutomationWorkflowRecord;
  draft: AutomationWorkflowVersion | null;
  published: AutomationWorkflowVersion | null;
};

export type AutomationValidationIssue = {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
};

export type AutomationValidationResult = {
  valid: boolean;
  issues: AutomationValidationIssue[];
};

export type AutomationNodePortDefinition = {
  id: string;
  label: string;
  type: AutomationPortType;
  required?: boolean;
  multiple?: boolean;
  minConnections?: number;
  /** Runtime result exposed in run history, but not available as a graph handle. */
  connectable?: boolean;
};

export type AutomationNodeFieldDefinition = {
  id: string;
  label: string;
  description?: string;
  placeholder?: string;
  advanced?: boolean;
  kind: "text" | "textarea" | "number" | "boolean" | "select" | "value" | "json" | "schema" | "prompt" | "model" | "references";
  defaultValue?: unknown;
  options?: Array<{ value: string; label: string }>;
  runtimeBindable?: boolean;
  runtimeValueType?: AutomationRuntimeValueType;
  required?: boolean;
  min?: number;
  max?: number;
  secret?: boolean;
  modelCapability?: "assistant" | "image";
  visibleWhen?: { fieldId: string; values: unknown[] };
};

export type AutomationNodeHelp = {
  whenToUse: string;
  setup: string[];
  exampleFlow: {
    before: string;
    after: string;
    explanation: string;
  };
  tips?: string[];
  technicalNotes?: string[];
};

export type AutomationRuntimeValueType =
  | "string"
  | "number"
  | "boolean"
  | "json"
  | "tiktok-source"
  | "identity"
  | "visual-references"
  | "assistant-model"
  | "image-model"
  | "aspect-ratio"
  | "resolution";

export type AutomationNodeDefinition = {
  type: string;
  version: number;
  /** Stable user-facing node type shown consistently in the library, card, and inspector. */
  title: string;
  description: string;
  example?: string;
  category: "trigger" | "input" | "ai" | "logic" | "integration" | "generation" | "output";
  icon: "play" | "source" | "identity" | "references" | "choices" | "inbox" | "ai" | "transform" | "select-one" | "select-path" | "condition" | "limit" | "merge" | "workflow" | "repeat" | "http" | "validate" | "generate" | "canvas" | "finish";
  accent: "mint" | "amber" | "blue" | "rose" | "neutral";
  inputs: AutomationNodePortDefinition[];
  outputs: AutomationNodePortDefinition[];
  fields: AutomationNodeFieldDefinition[];
  help: AutomationNodeHelp;
  terminal?: boolean;
};

export type AutomationRunInputField = {
  key: string;
  nodeId: string;
  bindingId: string;
  label: string;
  required: boolean;
  valueType: AutomationRuntimeValueType;
  fieldKind: AutomationNodeFieldDefinition["kind"];
  modelCapability?: AutomationNodeFieldDefinition["modelCapability"];
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  selectionLimit?: number;
  value?: unknown;
};
