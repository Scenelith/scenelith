import { createHash } from "node:crypto";
import { z } from "zod";
import { automationNodeDefinition } from "./registry";
import { automationWorkflowGraphSchema, type AutomationWorkflowGraph } from "./types";
import { validateAutomationWorkflowGraph } from "./validation";

export const AUTOMATION_PACKAGE_FORMAT = "scenelith.automation" as const;
export const CURRENT_AUTOMATION_PACKAGE_VERSION = 1 as const;
export const MINIMUM_AUTOMATION_PACKAGE_SCENELITH_VERSION = "0.3.4" as const;

const semverSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/).max(80);
const packageNodeTypeSchema = z.object({
  type: z.string().min(1).max(120),
  version: z.number().int().positive().max(10_000),
}).strict();
const packageModelSchema = z.object({
  provider: z.enum(["openrouter", "kie"]),
  id: z.string().min(1).max(160),
  capability: z.enum(["assistant", "image", "video"]),
}).strict();
const packageCredentialSlotSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  label: z.string().min(1).max(120),
  kind: z.enum(["api-key", "bearer", "basic", "header"]),
  required: z.boolean(),
}).strict();
const packageSubworkflowSlotSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  label: z.string().min(1).max(120),
  required: z.boolean(),
}).strict();

export const automationPackageV1Schema = z.object({
  format: z.literal(AUTOMATION_PACKAGE_FORMAT),
  version: z.literal(CURRENT_AUTOMATION_PACKAGE_VERSION),
  minimumScenelithVersion: semverSchema,
  metadata: z.object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2_000).default(""),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  }).strict(),
  requirements: z.object({
    nodeTypes: z.array(packageNodeTypeSchema).min(1).max(500),
    providers: z.array(z.enum(["openrouter", "kie"])).max(20),
    capabilities: z.array(z.string().min(1).max(80)).max(80),
    models: z.array(packageModelSchema).max(200),
    credentialSlots: z.array(packageCredentialSlotSchema).max(100).default([]),
    subworkflowSlots: z.array(packageSubworkflowSlotSchema).max(100).default([]),
  }).strict(),
  graph: automationWorkflowGraphSchema,
  integrity: z.object({
    algorithm: z.literal("sha256"),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
}).strict();

export type AutomationPackageV1 = z.infer<typeof automationPackageV1Schema>;

export class AutomationPackageError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "AutomationPackageError";
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function packagePayload(value: Omit<AutomationPackageV1, "integrity">) {
  return canonicalJson(value);
}

export function automationPackageDigest(value: Omit<AutomationPackageV1, "integrity">) {
  return createHash("sha256").update(packagePayload(value)).digest("hex");
}

const embeddedToken = /(?:\bsk-(?:or-v1-)?[A-Za-z0-9_-]{16,}|\bBearer\s+[A-Za-z0-9._~+/-]{16,}|\bAKIA[A-Z0-9]{16}\b)/i;
const sensitiveKey = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization|secret[_-]?value)$/i;

export function assertAutomationPackageContainsNoSecrets(value: unknown, path = "package", seen = new Set<unknown>()) {
  if (typeof value === "string") {
    if (embeddedToken.test(value)) throw new AutomationPackageError(`${path} appears to contain a credential`, "EMBEDDED_SECRET");
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertAutomationPackageContainsNoSecrets(entry, `${path}[${index}]`, seen));
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (sensitiveKey.test(key) && entry !== undefined && entry !== null && entry !== "") {
      throw new AutomationPackageError(`${path}.${key} cannot contain a credential`, "EMBEDDED_SECRET");
    }
    assertAutomationPackageContainsNoSecrets(entry, `${path}.${key}`, seen);
  }
}

function portableGraph(source: AutomationWorkflowGraph) {
  const graph = structuredClone(source);
  for (const node of graph.nodes) {
    const definition = automationNodeDefinition(node.type, node.version);
    if (!definition) continue;
    for (const field of definition.fields) {
      if (field.secret) {
        delete node.config[field.id];
        delete node.bindings[field.id];
        continue;
      }
      if (field.runtimeValueType !== "tiktok-source" && field.runtimeValueType !== "identity") continue;
      const binding = node.bindings[field.id];
      delete node.config[field.id];
      node.bindings[field.id] = {
        mode: "ask-on-run",
        label: binding?.label || field.label,
        required: Boolean(field.required || (field.runtimeValueType === "identity" && node.config.optional === false)),
      };
    }
  }
  return automationWorkflowGraphSchema.parse(graph);
}

function requirementsForGraph(graph: AutomationWorkflowGraph): AutomationPackageV1["requirements"] {
  const nodeTypes = new Map<string, { type: string; version: number }>();
  const providers = new Set<"openrouter" | "kie">();
  const capabilities = new Set<string>();
  const models = new Map<string, AutomationPackageV1["requirements"]["models"][number]>();
  const credentialSlots = new Map<string, AutomationPackageV1["requirements"]["credentialSlots"][number]>();
  const subworkflowSlots = new Map<string, AutomationPackageV1["requirements"]["subworkflowSlots"][number]>();
  for (const node of graph.nodes) {
    nodeTypes.set(`${node.type}@${node.version}`, { type: node.type, version: node.version });
    const definition = automationNodeDefinition(node.type, node.version);
    for (const field of definition?.fields || []) {
      const value = node.bindings[field.id]?.mode === "fixed" && node.bindings[field.id].value !== undefined
        ? node.bindings[field.id].value
        : node.config[field.id] ?? field.defaultValue;
      if (field.kind === "model") {
        const provider = field.modelCapability === "assistant" ? "openrouter" : "kie";
        const capability = field.modelCapability || "image";
        providers.add(provider);
        capabilities.add(capability);
        if (typeof value === "string" && value) models.set(`${provider}:${value}`, { provider, id: value, capability });
      }
    }
    const credentialSlot = typeof node.config.credentialSlot === "string" ? node.config.credentialSlot : "";
    if (credentialSlot) credentialSlots.set(credentialSlot, {
      key: credentialSlot,
      label: String(node.config.credentialLabel || credentialSlot).slice(0, 120),
      kind: ["api-key", "bearer", "basic", "header"].includes(String(node.config.credentialKind || ""))
        ? String(node.config.credentialKind) as "api-key" | "bearer" | "basic" | "header"
        : "api-key",
      required: true,
    });
    const subworkflowSlot = typeof node.config.subworkflowSlot === "string" ? node.config.subworkflowSlot : "";
    if (subworkflowSlot) subworkflowSlots.set(subworkflowSlot, { key: subworkflowSlot, label: String(node.config.subworkflowLabel || subworkflowSlot).slice(0, 120), required: true });
  }
  return {
    nodeTypes: [...nodeTypes.values()].sort((left, right) => `${left.type}@${left.version}`.localeCompare(`${right.type}@${right.version}`)),
    providers: [...providers].sort(),
    capabilities: [...capabilities].sort(),
    models: [...models.values()].sort((left, right) => `${left.provider}:${left.id}`.localeCompare(`${right.provider}:${right.id}`)),
    credentialSlots: [...credentialSlots.values()].sort((left, right) => left.key.localeCompare(right.key)),
    subworkflowSlots: [...subworkflowSlots.values()].sort((left, right) => left.key.localeCompare(right.key)),
  };
}

export function createAutomationPackage(input: {
  name: string;
  description?: string;
  tags?: string[];
  graph: AutomationWorkflowGraph;
}): AutomationPackageV1 {
  const graph = portableGraph(input.graph);
  const payload: Omit<AutomationPackageV1, "integrity"> = {
    format: AUTOMATION_PACKAGE_FORMAT,
    version: CURRENT_AUTOMATION_PACKAGE_VERSION,
    minimumScenelithVersion: MINIMUM_AUTOMATION_PACKAGE_SCENELITH_VERSION,
    metadata: { name: input.name.trim().slice(0, 120), description: (input.description || "").slice(0, 2_000), tags: [...new Set(input.tags || [])].slice(0, 20) },
    requirements: requirementsForGraph(graph),
    graph,
  };
  assertAutomationPackageContainsNoSecrets(payload);
  return automationPackageV1Schema.parse({ ...payload, integrity: { algorithm: "sha256", digest: automationPackageDigest(payload) } });
}

export function parseAutomationPackage(value: unknown): AutomationPackageV1 {
  assertAutomationPackageContainsNoSecrets(value);
  const parsed = automationPackageV1Schema.safeParse(value);
  if (!parsed.success) throw new AutomationPackageError(parsed.error.issues.map((entry) => `${entry.path.join(".") || "package"}: ${entry.message}`).join("; "), "INVALID_PACKAGE");
  const { integrity, ...payload } = parsed.data;
  if (automationPackageDigest(payload) !== integrity.digest) throw new AutomationPackageError("Automation package integrity check failed", "PACKAGE_INTEGRITY");
  const missing = payload.requirements.nodeTypes.filter((entry) => !automationNodeDefinition(entry.type, entry.version));
  if (missing.length) throw new AutomationPackageError(`This Scenelith installation does not support ${missing.map((entry) => `${entry.type}@${entry.version}`).join(", ")}`, "UNSUPPORTED_NODE_TYPE");
  const actualRequirements = requirementsForGraph(payload.graph);
  if (canonicalJson(actualRequirements) !== canonicalJson(payload.requirements)) {
    throw new AutomationPackageError("Automation package requirements do not match its graph", "REQUIREMENTS_MISMATCH");
  }
  const validation = validateAutomationWorkflowGraph(payload.graph);
  // Packages may contain an intentionally unfinished draft, but structural
  // parse errors, unknown node contracts and hidden requirements are rejected
  // before anything is written to the database.
  if (validation.issues.some((entry) => ["UNKNOWN_NODE_TYPE", "INVALID_GRAPH", "SECRET_IN_WORKFLOW"].includes(entry.code))) {
    throw new AutomationPackageError("Automation package contains an unsupported graph contract", "INVALID_PACKAGE_GRAPH");
  }
  return parsed.data;
}
