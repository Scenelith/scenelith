import { automationMergeInputs, automationNodeDefinition, automationNodeInputPorts, automationPortTypesCompatible } from "./registry";
import { automationJsonSchemaDefinitionIssues } from "./json-schema";
import { automationCreativeControlIssues, automationCreativeRequirementOptionIssues } from "./creative-direction-contract";
import { automationTemplateIssues, automationTemplateStrings } from "./template-contract";
import { automationValuePathIssues } from "./value-path";
import {
  automationWorkflowGraphSchema,
  type AutomationNode,
  type AutomationNodeFieldDefinition,
  type AutomationRunInputField,
  type AutomationValidationIssue,
  type AutomationValidationResult,
  type AutomationWorkflowGraph,
} from "./types";

function issue(code: string, message: string, location: { nodeId?: string; edgeId?: string } = {}): AutomationValidationIssue {
  return { code, message, ...location };
}

function emptySetting(value: unknown) {
  return value === undefined || value === null || (typeof value === "string" && !value.trim()) || (Array.isArray(value) && value.length === 0);
}

const embeddedCredential = /(?:\bsk-(?:or-v1-)?[A-Za-z0-9_-]{16,}|\bBearer\s+[A-Za-z0-9._~+/-]{16,}|\bAKIA[A-Z0-9]{16}\b)/i;
const sensitiveConfigKey = /^(?:authorization|proxy-authorization|cookie|(?:x[_-]?)?api[_-]?key|(?:x[_-]?)?auth[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret)$/i;

function containsStoredCredential(value: unknown, inspectKeys: boolean, seen = new Set<unknown>()): boolean {
  if (typeof value === "string") return embeddedCredential.test(value);
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => containsStoredCredential(entry, inspectKeys, seen));
  return Object.entries(value as Record<string, unknown>).some(([key, entry]) =>
    (inspectKeys && sensitiveConfigKey.test(key) && !emptySetting(entry)) || containsStoredCredential(entry, inspectKeys, seen));
}

function runtimeValueType(field: AutomationNodeFieldDefinition): AutomationRunInputField["valueType"] {
  if (field.runtimeValueType) return field.runtimeValueType;
  if (field.kind === "boolean") return "boolean";
  if (field.kind === "number") return "number";
  if (field.kind === "json") return "json";
  if (field.kind === "model") return field.modelCapability === "image" ? "image-model" : "assistant-model";
  return "string";
}

export function validateAutomationConnection(
  graph: AutomationWorkflowGraph,
  connection: Pick<AutomationWorkflowGraph["edges"][number], "source" | "sourcePort" | "target" | "targetPort" | "role"> & { id?: string },
): AutomationValidationResult {
  const issues: AutomationValidationIssue[] = [];
  const source = graph.nodes.find((node) => node.id === connection.source);
  const target = graph.nodes.find((node) => node.id === connection.target);
  if (!source || !target) return { valid: false, issues: [issue("MISSING_EDGE_NODE", "A connection points to a node that no longer exists.")] };
  if (source.id === target.id) issues.push(issue("SELF_CONNECTION", "A step cannot connect back to itself.", { nodeId: source.id }));
  if (source.disabled || target.disabled) issues.push(issue("CONNECTED_DISABLED_NODE", "Enable both steps before connecting them."));
  const sourcePort = automationNodeDefinition(source.type, source.version)?.outputs.find((port) => port.id === connection.sourcePort);
  const sourceDefinition = automationNodeDefinition(source.type, source.version);
  const targetPort = automationNodeInputPorts(target).find((port) => port.id === connection.targetPort);
  if (sourceDefinition?.terminal) issues.push(issue("TERMINAL_CONTINUES", `“${source.name}” is a final step and cannot lead to another step.`, { nodeId: source.id }));
  if (!sourcePort) issues.push(issue("UNKNOWN_SOURCE_PORT", `“${source.name}” has no output named “${connection.sourcePort}”.`, { nodeId: source.id }));
  if (sourcePort?.connectable === false) issues.push(issue("INTERNAL_OUTPUT_CONNECTED", `“${sourcePort.label}” is an internal run receipt and cannot connect to another step.`, { nodeId: source.id }));
  if (!targetPort) issues.push(issue("UNKNOWN_TARGET_PORT", `“${target.name}” has no input named “${connection.targetPort}”.`, { nodeId: target.id }));
  if (sourcePort && targetPort && !automationPortTypesCompatible(sourcePort.type, targetPort.type)) {
    issues.push(issue("INCOMPATIBLE_PORTS", `${sourcePort.label} (${sourcePort.type}) cannot connect to ${targetPort.label} (${targetPort.type}).`));
  }
  const role = connection.role;
  if (!role) issues.push(issue("CONNECTION_ROLE_REQUIRED", "Choose whether this connection is a main route, supporting data, an error route or a Retry route."));
  if (sourcePort?.type === "error" && role !== "error") issues.push(issue("ERROR_ROUTE_ROLE", "An error output must use an Error recovery route."));
  if (sourcePort?.type !== "error" && role === "error") issues.push(issue("ERROR_ROUTE_ROLE", "Only an error output can create an Error recovery route."));
  const isRetryTarget = target.type === "logic.retry-gate" && connection.targetPort === "feedback";
  if (role === "retry" && !isRetryTarget) issues.push(issue("RETRY_ROUTE_TARGET", "A Retry route must return to the Retry feedback input of a Retry gate."));
  if (isRetryTarget && role !== "retry") issues.push(issue("RETRY_ROUTE_ROLE", "Retry feedback accepts only a bounded Retry route."));
  if (role === "retry" && sourcePort?.type === "error") issues.push(issue("RETRY_ROUTE_VALUE", "Repair the error first, then return the corrected value through the Retry route."));
  const otherEdges = graph.edges.filter((edge) => !connection.id || edge.id !== connection.id);
  if (otherEdges.some((edge) => edge.source === connection.source && edge.sourcePort === connection.sourcePort && edge.target === connection.target && edge.targetPort === connection.targetPort)) {
    issues.push(issue("DUPLICATE_CONNECTION", "These two ports are already connected."));
  }
  if (targetPort && !targetPort.multiple && otherEdges.some((edge) => edge.target === connection.target && edge.targetPort === connection.targetPort)) {
    issues.push(issue("TOO_MANY_INPUTS", `“${target.name}” accepts only one ${targetPort.label} connection.`, { nodeId: target.id }));
  }
  if (source.id !== target.id) {
    const outgoing = new Map<string, string[]>();
    for (const edge of otherEdges.filter((edge) => edge.role !== "retry")) outgoing.set(edge.source, [...(outgoing.get(edge.source) || []), edge.target]);
    const pending = [target.id];
    const visited = new Set<string>();
    while (pending.length) {
      const nodeId = pending.shift()!;
      if (nodeId === source.id && role !== "retry") {
        issues.push(issue("UNBOUNDED_CYCLE", "This connection would create a cycle. Use a bounded batch step instead."));
        break;
      }
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      pending.push(...(outgoing.get(nodeId) || []));
    }
  }
  return { valid: issues.length === 0, issues };
}

export function validateAutomationWorkflowGraph(value: unknown): AutomationValidationResult {
  const parsed = automationWorkflowGraphSchema.safeParse(value);
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map((entry) => issue("INVALID_GRAPH", `${entry.path.join(".") || "workflow"}: ${entry.message}`)),
    };
  }

  const graph = parsed.data;
  const issues: AutomationValidationIssue[] = [];
  const nodeById = new Map<string, AutomationNode>();
  const edgeIds = new Set<string>();
  const connectionKeys = new Set<string>();
  const incomingByNode = new Map<string, typeof graph.edges>();
  const outgoingByNode = new Map<string, typeof graph.edges>();
  const deploymentSlots = new Map<string, { type: "credential" | "subworkflow"; kind?: string; nodeId: string }>();

  for (const node of graph.nodes) {
    if (nodeById.has(node.id)) issues.push(issue("DUPLICATE_NODE_ID", `Node id “${node.id}” is used more than once.`, { nodeId: node.id }));
    nodeById.set(node.id, node);
    if (!automationNodeDefinition(node.type, node.version)) {
      issues.push(issue("UNKNOWN_NODE_TYPE", `“${node.name}” uses unavailable node type ${node.type}@${node.version}.`, { nodeId: node.id }));
    }
  }

  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) issues.push(issue("DUPLICATE_EDGE_ID", `Connection id “${edge.id}” is used more than once.`, { edgeId: edge.id }));
    edgeIds.add(edge.id);
    const connectionKey = `${edge.source}\u0000${edge.sourcePort}\u0000${edge.target}\u0000${edge.targetPort}`;
    if (connectionKeys.has(connectionKey)) issues.push(issue("DUPLICATE_CONNECTION", "The same two ports are connected more than once.", { edgeId: edge.id }));
    connectionKeys.add(connectionKey);
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) {
      issues.push(issue("MISSING_EDGE_NODE", "A connection points to a node that no longer exists.", { edgeId: edge.id }));
      continue;
    }
    if (source.id === target.id) issues.push(issue("SELF_CONNECTION", `“${source.name}” cannot connect back to itself.`, { edgeId: edge.id, nodeId: source.id }));
    if (source.disabled || target.disabled) {
      issues.push(issue("CONNECTED_DISABLED_NODE", "Disabled nodes must be bypassed or disconnected before going live.", { edgeId: edge.id }));
      continue;
    }
    const sourceDefinition = automationNodeDefinition(source.type, source.version);
    const sourcePort = sourceDefinition?.outputs.find((port) => port.id === edge.sourcePort);
    const targetPort = automationNodeInputPorts(target).find((port) => port.id === edge.targetPort);
    if (!sourcePort) issues.push(issue("UNKNOWN_SOURCE_PORT", `“${source.name}” has no output named “${edge.sourcePort}”.`, { edgeId: edge.id, nodeId: source.id }));
    if (sourcePort?.connectable === false) issues.push(issue("INTERNAL_OUTPUT_CONNECTED", `“${sourcePort.label}” is an internal run receipt and cannot connect to another step.`, { edgeId: edge.id, nodeId: source.id }));
    if (!targetPort) issues.push(issue("UNKNOWN_TARGET_PORT", `“${target.name}” has no input named “${edge.targetPort}”.`, { edgeId: edge.id, nodeId: target.id }));
    if (sourcePort && targetPort && !automationPortTypesCompatible(sourcePort.type, targetPort.type)) {
      issues.push(issue("INCOMPATIBLE_PORTS", `${sourcePort.label} (${sourcePort.type}) cannot connect to ${targetPort.label} (${targetPort.type}).`, { edgeId: edge.id }));
    }
    const role = edge.role;
    if (sourcePort?.type === "error" && role !== "error") issues.push(issue("ERROR_ROUTE_ROLE", `“${sourcePort.label}” must use an Error recovery route.`, { edgeId: edge.id, nodeId: source.id }));
    if (sourcePort?.type !== "error" && role === "error") issues.push(issue("ERROR_ROUTE_ROLE", `“${sourcePort?.label || edge.sourcePort}” is normal data and cannot use an Error recovery route.`, { edgeId: edge.id, nodeId: source.id }));
    const isRetryTarget = target.type === "logic.retry-gate" && edge.targetPort === "feedback";
    if (role === "retry" && !isRetryTarget) issues.push(issue("RETRY_ROUTE_TARGET", "A Retry route must return to the Retry feedback input of a Retry gate.", { edgeId: edge.id }));
    if (isRetryTarget && role !== "retry") issues.push(issue("RETRY_ROUTE_ROLE", `“${target.name}” accepts feedback only through a bounded Retry route.`, { edgeId: edge.id, nodeId: target.id }));
    if (role === "retry" && sourcePort?.type === "error") issues.push(issue("RETRY_ROUTE_VALUE", "Repair the error first, then return the corrected value through the Retry route.", { edgeId: edge.id, nodeId: source.id }));
    const incoming = incomingByNode.get(target.id) || [];
    incoming.push(edge);
    incomingByNode.set(target.id, incoming);
    const outgoing = outgoingByNode.get(source.id) || [];
    outgoing.push(edge);
    outgoingByNode.set(source.id, outgoing);
  }

  for (const node of graph.nodes.filter((item) => !item.disabled)) {
    const definition = automationNodeDefinition(node.type, node.version);
    if (!definition) continue;
    const fieldsById = new Map(definition.fields.map((field) => [field.id, field]));
    for (const configKey of Object.keys(node.config)) {
      if (!fieldsById.has(configKey)) issues.push(issue("UNKNOWN_NODE_SETTING", `“${node.name}” has an unsupported setting named “${configKey}”.`, { nodeId: node.id }));
    }
    for (const [bindingId, binding] of Object.entries(node.bindings)) {
      const field = fieldsById.get(bindingId);
      if (!field) {
        issues.push(issue("UNKNOWN_NODE_BINDING", `“${node.name}” has a run binding for an unavailable setting named “${bindingId}”.`, { nodeId: node.id }));
        continue;
      }
      if (!field.runtimeBindable) {
        issues.push(issue("SETTING_NOT_RUNTIME_BINDABLE", `“${field.label}” does not support a separate run binding. Store it only in the step settings.`, { nodeId: node.id }));
      }
      if (binding.mode === "ask-on-run" && field.required && !binding.required) {
        issues.push(issue("REQUIRED_BINDING_OPTIONAL", `“${field.label}” is required by “${node.name}” and cannot be optional at run time.`, { nodeId: node.id }));
      }
    }
    for (const field of definition.fields) {
      const binding = node.bindings[field.id];
      const askedAtRun = binding?.mode === "ask-on-run";
      const value = binding?.mode === "fixed" && binding.value !== undefined
        ? binding.value
        : node.config[field.id] ?? field.defaultValue;
      if (field.required && !askedAtRun && emptySetting(value)) {
        issues.push(issue("MISSING_REQUIRED_SETTING", `“${node.name}” needs ${field.label}. Set it here or enable Ask on run.`, { nodeId: node.id }));
        continue;
      }
      if (field.secret && !emptySetting(value)) {
        issues.push(issue("SECRET_IN_WORKFLOW", `“${field.label}” cannot be stored inside a workflow. Use operator-managed credentials.`, { nodeId: node.id }));
        continue;
      }
      if (emptySetting(value)) continue;
      if (field.kind === "boolean" && typeof value !== "boolean") issues.push(issue("INVALID_SETTING_TYPE", `“${field.label}” must be enabled or disabled.`, { nodeId: node.id }));
      if (["text", "textarea", "prompt", "select", "model"].includes(field.kind) && typeof value !== "string") {
        issues.push(issue("INVALID_SETTING_TYPE", `“${field.label}” must be text.`, { nodeId: node.id }));
      }
      if (field.kind === "number") {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) issues.push(issue("INVALID_SETTING_TYPE", `“${field.label}” must be a number.`, { nodeId: node.id }));
        else if ((field.min !== undefined && numeric < field.min) || (field.max !== undefined && numeric > field.max)) {
          issues.push(issue("SETTING_OUT_OF_RANGE", `“${field.label}” must be between ${field.min ?? "−∞"} and ${field.max ?? "∞"}.`, { nodeId: node.id }));
        }
      }
      if ((field.kind === "json" || field.kind === "schema") && (typeof value !== "object" || value === null)) issues.push(issue("INVALID_SETTING_TYPE", `“${field.label}” must be valid JSON.`, { nodeId: node.id }));
      if (field.kind === "references") {
        const ids = Array.isArray(value) ? value.map((entry) => typeof entry === "string" ? entry.trim() : "") : [];
        if (!Array.isArray(value) || ids.some((id) => !id)) issues.push(issue("INVALID_SETTING_TYPE", `“${field.label}” must contain valid image references.`, { nodeId: node.id }));
        else if (new Set(ids).size !== ids.length) issues.push(issue("DUPLICATE_REFERENCE", `“${field.label}” contains the same image more than once.`, { nodeId: node.id }));
        else if (field.max !== undefined && ids.length > field.max) issues.push(issue("TOO_MANY_REFERENCES", `“${field.label}” can contain at most ${field.max} images.`, { nodeId: node.id }));
      }
      if (field.options?.length && !field.options.some((option) => option.value === String(value))) {
        issues.push(issue("INVALID_SETTING_OPTION", `“${field.label}” has an unsupported value.`, { nodeId: node.id }));
      }
      if (field.readOnly && field.defaultValue !== undefined && JSON.stringify(value) !== JSON.stringify(field.defaultValue)) {
        issues.push(issue("IMMUTABLE_NODE_SETTING", `“${field.label}” is a built-in contract and cannot be changed.`, { nodeId: node.id }));
      }
      if (field.kind === "creative-controls") {
        for (const message of automationCreativeControlIssues(value).slice(0, 24)) {
          issues.push(issue("INVALID_CREATIVE_CONTROL", `“${node.name}”: ${message}.`, { nodeId: node.id }));
        }
      }
      if (node.type === "logic.prepare-creative-direction" && field.id === "requirementCategories") {
        for (const message of automationCreativeRequirementOptionIssues(value, "Requirement categories").slice(0, 24)) {
          issues.push(issue("INVALID_CREATIVE_TAXONOMY", `“${node.name}”: ${message}.`, { nodeId: node.id }));
        }
      }
      if (node.type === "logic.prepare-creative-direction" && field.id === "requirementPlacements") {
        for (const message of automationCreativeRequirementOptionIssues(value, "Requirement placements").slice(0, 24)) {
          issues.push(issue("INVALID_CREATIVE_TAXONOMY", `“${node.name}”: ${message}.`, { nodeId: node.id }));
        }
      }
    }
    const effectiveSetting = (fieldId: string) => node.bindings[fieldId]?.mode === "fixed" && node.bindings[fieldId].value !== undefined
      ? node.bindings[fieldId].value
      : node.config[fieldId] ?? definition.fields.find((field) => field.id === fieldId)?.defaultValue;
    const validatePathSetting = (fieldId: string, allowEmpty: boolean) => {
      const value = effectiveSetting(fieldId);
      if (typeof value !== "string") return;
      for (const message of automationValuePathIssues(value, { allowEmpty })) {
        issues.push(issue("INVALID_VALUE_PATH", `“${node.name}” ${definition.fields.find((field) => field.id === fieldId)?.label || fieldId}: ${message}.`, { nodeId: node.id }));
      }
    };
    const validateTemplates = (fieldId: string, value: unknown, roots: readonly string[]) => {
      for (const template of automationTemplateStrings(value)) {
        for (const message of automationTemplateIssues(template, new Set(roots))) {
          issues.push(issue("INVALID_TEMPLATE", `“${node.name}” ${definition.fields.find((field) => field.id === fieldId)?.label || fieldId} ${message}.`, { nodeId: node.id }));
        }
      }
    };
    if (node.type === "input.workflow-data") validatePathSetting("payloadPath", true);
    if (node.type === "input.tiktok-source" && node.version >= 2
      && effectiveSetting("captionMode") === "replacement"
      && node.bindings.caption?.mode !== "ask-on-run"
      && !String(effectiveSetting("caption") || "").trim()) {
      issues.push(issue("MISSING_REPLACEMENT_CAPTION", `“${node.name}” needs replacement caption text or a different Caption mode.`, { nodeId: node.id }));
    }
    if (node.type === "logic.select-path") validatePathSetting("path", false);
    if (node.type === "logic.retry-gate") validatePathSetting("feedbackPath", true);
    if (node.type === "logic.condition") validatePathSetting("path", true);
    if (node.type === "logic.prepare-creative-direction") {
      validatePathSetting("briefPath", false);
      validatePathSetting("policyPath", false);
      if (node.version >= 3) validatePathSetting("resultPath", false);
    }
    if (node.type === "ai.structured-task") {
      validateTemplates("userPrompt", effectiveSetting("userPrompt"), ["primary", "context", "identity", "connected", "run", "trigger"]);
      validateTemplates("systemPrompt", effectiveSetting("systemPrompt"), []);
    }
    if (node.type === "ai.interpret-creative-direction") {
      validateTemplates("taskInstructions", effectiveSetting("taskInstructions"), ["primary", "connected", "run", "trigger"]);
      validateTemplates("systemInstructions", effectiveSetting("systemInstructions"), []);
    }
    if (node.type === "logic.transform") validateTemplates("template", effectiveSetting("template"), ["data", "inputs", "byNode", "byNodePort", "sources", "run", "trigger"]);
    if (node.type === "integration.http-request") {
      validateTemplates("url", effectiveSetting("url"), ["data", "run", "trigger"]);
      validateTemplates("headers", effectiveSetting("headers"), ["data", "run", "trigger"]);
      validateTemplates("body", effectiveSetting("body"), ["data", "run", "trigger"]);
    }
    if (node.type === "output.finish") validateTemplates("message", effectiveSetting("message"), ["data", "run", "trigger"]);
    if (node.type === "logic.merge") {
      const rawInputs = effectiveSetting("inputs");
      const inputs = automationMergeInputs({ ...node, config: { ...node.config, inputs: rawInputs } });
      if (!Array.isArray(rawInputs) || inputs.length < 2) {
        issues.push(issue("MERGE_INPUT_COUNT", `“${node.name}” needs at least two named inputs. Add one socket for every path the merge must wait for.`, { nodeId: node.id }));
      } else if (rawInputs.length > 24) {
        issues.push(issue("MERGE_INPUT_COUNT", `“${node.name}” can have at most 24 named inputs.`, { nodeId: node.id }));
      }
      if (Array.isArray(rawInputs) && inputs.length !== rawInputs.length) {
        issues.push(issue("INVALID_MERGE_INPUT", `“${node.name}” has an incomplete input. Every Merge input needs a stable id and name.`, { nodeId: node.id }));
      }
      const ids = new Set<string>();
      const names = new Set<string>();
      for (const input of inputs) {
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(input.id)) issues.push(issue("INVALID_MERGE_INPUT", `“${node.name}” has an invalid input id “${input.id}”.`, { nodeId: node.id }));
        if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(input.name)) issues.push(issue("INVALID_MERGE_INPUT", `“${node.name}” input “${input.name}” must start with a letter or underscore and use only letters, numbers, underscores or hyphens.`, { nodeId: node.id }));
        if (ids.has(input.id)) issues.push(issue("DUPLICATE_MERGE_INPUT", `“${node.name}” uses input id “${input.id}” more than once.`, { nodeId: node.id }));
        if (names.has(input.name)) issues.push(issue("DUPLICATE_MERGE_INPUT", `“${node.name}” uses input name “${input.name}” more than once.`, { nodeId: node.id }));
        ids.add(input.id); names.add(input.name);
      }
    }
    if (node.type === "logic.condition") {
      const operator = effectiveSetting("operator");
      const comparison = effectiveSetting("compareValue");
      if (["contains", "greater-than", "less-than"].includes(String(operator))
        && (comparison === undefined || comparison === null || comparison === "")) {
        issues.push(issue("MISSING_CONDITION_COMPARISON", `“${node.name}” needs a comparison value for this rule.`, { nodeId: node.id }));
      }
      if (["greater-than", "less-than"].includes(String(operator)) && comparison !== undefined && comparison !== null && comparison !== "" && !Number.isFinite(Number(comparison))) {
        issues.push(issue("INVALID_CONDITION_COMPARISON", `“${node.name}” needs a numeric comparison value for this rule.`, { nodeId: node.id }));
      }
    }
    if (node.type === "ai.structured-task") {
      const effective = (fieldId: string) => node.bindings[fieldId]?.mode === "fixed" && node.bindings[fieldId].value !== undefined
        ? node.bindings[fieldId].value
        : node.config[fieldId] ?? definition.fields.find((field) => field.id === fieldId)?.defaultValue;
      const structured = effective("outputMode") === "structured";
      if (structured) {
        const schema = effective("responseSchema");
        const schemaIssues = automationJsonSchemaDefinitionIssues(schema, "Response schema", true);
        for (const message of schemaIssues.slice(0, 12)) issues.push(issue("INVALID_RESPONSE_SCHEMA", `“${node.name}”: ${message}.`, { nodeId: node.id }));
        const properties = schema && typeof schema === "object" && !Array.isArray(schema)
          ? (schema as { properties?: unknown }).properties
          : null;
        if (!properties || typeof properties !== "object" || Array.isArray(properties) || !Object.keys(properties as Record<string, unknown>).length) {
          issues.push(issue("EMPTY_RESPONSE_SCHEMA", `“${node.name}” must define at least one answer field in Defined data fields mode.`, { nodeId: node.id }));
        }
      }
      if (/{{[\s\S]*?}}/.test(String(effective("systemPrompt") || ""))) {
        issues.push(issue("VARIABLE_IN_PERMANENT_INSTRUCTIONS", `“${node.name}” cannot use workflow variables in Permanent instructions. Put variables in What should the AI do? instead.`, { nodeId: node.id }));
      }
    }
    if (node.type === "integration.http-request") {
      const rawUrl = String(effectiveSetting("url") || "").trim();
      if (rawUrl && !rawUrl.includes("{{")) {
        try {
          const url = new URL(rawUrl);
          if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error("unsafe");
        } catch {
          issues.push(issue("INVALID_HTTP_URL", `“${node.name}” needs a complete public HTTP or HTTPS address without credentials in the URL.`, { nodeId: node.id }));
        }
      }
      const headers = effectiveSetting("headers");
      if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
        issues.push(issue("INVALID_HTTP_HEADERS", `“${node.name}” needs Extra request headers to be one JSON object.`, { nodeId: node.id }));
      } else {
        const method = String(effectiveSetting("method") || "GET");
        const attempts = Number(effectiveSetting("maxAttempts") ?? 1);
        const idempotencyHeader = Object.entries(headers as Record<string, unknown>)
          .find(([key]) => key.toLowerCase() === "idempotency-key");
        if (!["GET", "HEAD"].includes(method) && attempts > 1 && (!idempotencyHeader || !String(idempotencyHeader[1] ?? "").trim())) {
          issues.push(issue("HTTP_RETRY_NOT_IDEMPOTENT", `“${node.name}” may retry ${method} only when Extra request headers contains a non-empty Idempotency-Key.`, { nodeId: node.id }));
        }
      }
    }
    if (node.type === "logic.run-subworkflow" || node.type === "logic.map-subworkflow") {
      const childInputs = effectiveSetting("childInputs");
      if (!childInputs || typeof childInputs !== "object" || Array.isArray(childInputs)) {
        issues.push(issue("INVALID_SUBWORKFLOW_INPUTS", `“${node.name}” needs Extra fixed information to be one JSON object.`, { nodeId: node.id }));
      }
    }
    if (containsStoredCredential(node.config, node.type === "integration.http-request")) {
      issues.push(issue("SECRET_IN_WORKFLOW", `“${node.name}” appears to contain a stored credential. Move it to a deployment credential slot.`, { nodeId: node.id }));
    }
    const credentialSlot = String(effectiveSetting("credentialSlot") || "").trim();
    const subworkflowSlot = String(effectiveSetting("subworkflowSlot") || "").trim();
    for (const slot of [credentialSlot, subworkflowSlot].filter(Boolean)) {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(slot)) {
        issues.push(issue("INVALID_DEPLOYMENT_SLOT", `“${node.name}” uses invalid deployment slot “${slot}”. Use lowercase letters, numbers and hyphens.`, { nodeId: node.id }));
      }
    }
    if (credentialSlot) {
      const kind = String(effectiveSetting("credentialKind") || "api-key");
      const current = deploymentSlots.get(credentialSlot);
      if (current?.type === "subworkflow") {
        issues.push(issue("DEPLOYMENT_SLOT_TYPE_CONFLICT", `Deployment slot “${credentialSlot}” cannot be both a credential and a workflow.`, { nodeId: node.id }));
      } else if (current?.kind && current.kind !== kind) {
        issues.push(issue("CREDENTIAL_SLOT_KIND_CONFLICT", `Credential slot “${credentialSlot}” cannot require both ${current.kind} and ${kind}.`, { nodeId: node.id }));
      } else if (!current) deploymentSlots.set(credentialSlot, { type: "credential", kind, nodeId: node.id });
    }
    if (subworkflowSlot) {
      const current = deploymentSlots.get(subworkflowSlot);
      if (current?.type === "credential") {
        issues.push(issue("DEPLOYMENT_SLOT_TYPE_CONFLICT", `Deployment slot “${subworkflowSlot}” cannot be both a workflow and a credential.`, { nodeId: node.id }));
      } else if (!current) deploymentSlots.set(subworkflowSlot, { type: "subworkflow", nodeId: node.id });
    }
    const incoming = incomingByNode.get(node.id) || [];
    if (definition.category !== "trigger" && incoming.length && !incoming.some((edge) => !["data", "retry"].includes(edge.role))) {
      issues.push(issue(
        "MISSING_FLOW_ROUTE",
        `“${node.name}” is connected only as supporting data. Mark one incoming connection as Main execution route so the step remains visible and runnable.`,
        { nodeId: node.id },
      ));
    }
    for (const port of automationNodeInputPorts(node)) {
      const connected = incoming.filter((edge) => edge.targetPort === port.id);
      const minimum = Math.max(port.required ? 1 : 0, port.minConnections || 0);
      if (connected.length < minimum) issues.push(issue("MISSING_REQUIRED_INPUT", `“${node.name}” needs at least ${minimum} ${port.label} connection${minimum === 1 ? "" : "s"}.`, { nodeId: node.id }));
      if (!port.multiple && connected.length > 1) {
        issues.push(issue("TOO_MANY_INPUTS", `“${node.name}” accepts only one ${port.label} connection.`, { nodeId: node.id }));
      }
    }
    const outgoing = outgoingByNode.get(node.id) || [];
    for (const port of definition.outputs.filter((output) => output.required)) {
      if (!outgoing.some((edge) => edge.sourcePort === port.id)) issues.push(issue("MISSING_REQUIRED_OUTPUT", `“${node.name}” needs a connection from ${port.label}.`, { nodeId: node.id }));
    }
    const failureField = definition.fields.find((field) => field.id === "failureMode");
    const failureBinding = node.bindings.failureMode;
    const failureMode = failureBinding?.mode === "fixed" && failureBinding.value !== undefined
      ? failureBinding.value
      : node.config.failureMode ?? failureField?.defaultValue;
    const errorPort = definition.outputs.find((output) => output.type === "error");
    const errorConnections = errorPort ? outgoing.filter((edge) => edge.sourcePort === errorPort.id) : [];
    if (failureField && errorConnections.length && failureMode !== "error-output") {
      issues.push(issue("DORMANT_ERROR_OUTPUT", `“${node.name}” has an error branch, but its failure behavior is not set to Use error output.`, { nodeId: node.id }));
    }
    if (failureField && failureMode === "error-output" && errorPort && !errorConnections.length) {
      issues.push(issue("MISSING_ERROR_HANDLER", `“${node.name}” is configured to use its error output, but that output is not connected.`, { nodeId: node.id }));
    }
    if (definition.terminal && outgoing.length) issues.push(issue("TERMINAL_CONTINUES", `“${node.name}” is a final step and cannot lead to another step.`, { nodeId: node.id }));
    if (!definition.terminal && !(outgoingByNode.get(node.id) || []).length) {
      issues.push(issue("DEAD_END", `“${node.name}” does not lead to another step.`, { nodeId: node.id }));
    }
  }

  const triggers = graph.nodes.filter((node) => !node.disabled && automationNodeDefinition(node.type, node.version)?.category === "trigger");
  const terminals = graph.nodes.filter((node) => !node.disabled && automationNodeDefinition(node.type, node.version)?.terminal);
  if (triggers.length !== 1) issues.push(issue("TRIGGER_COUNT", `A live workflow needs exactly one trigger; found ${triggers.length}.`));
  if (!terminals.length) issues.push(issue("MISSING_TERMINAL", "A live workflow needs at least one output step."));

  const groupIds = new Set<string>();
  const groupedNodeIds = new Set<string>();
  for (const group of graph.groups) {
    if (groupIds.has(group.id)) issues.push(issue("DUPLICATE_GROUP_ID", `Group id “${group.id}” is used more than once.`));
    groupIds.add(group.id);
    for (const nodeId of group.nodeIds) {
      if (!nodeById.has(nodeId)) issues.push(issue("MISSING_GROUP_NODE", `“${group.name}” contains a node that no longer exists: ${nodeId}.`));
      if (groupedNodeIds.has(nodeId)) issues.push(issue("NODE_IN_MULTIPLE_GROUPS", `Node “${nodeId}” belongs to more than one group.`, { nodeId }));
      groupedNodeIds.add(nodeId);
      if (nodeById.get(nodeId)?.groupId !== group.id) issues.push(issue("GROUP_MEMBERSHIP_MISMATCH", `Node “${nodeId}” and group “${group.name}” disagree about membership.`, { nodeId }));
    }
  }
  for (const node of graph.nodes) {
    if (node.groupId && !groupIds.has(node.groupId)) issues.push(issue("MISSING_GROUP", `“${node.name}” references a group that does not exist.`, { nodeId: node.id }));
    if (node.groupId && !groupedNodeIds.has(node.id)) issues.push(issue("GROUP_MEMBERSHIP_MISMATCH", `“${node.name}” is not listed by its group.`, { nodeId: node.id }));
  }

  const activeNodes = graph.nodes.filter((node) => !node.disabled);
  const indegree = new Map(activeNodes.map((node) => [node.id, 0]));
  for (const edge of graph.edges.filter((item) => item.role !== "retry")) {
    if (indegree.has(edge.source) && indegree.has(edge.target)) indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1);
  }
  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([nodeId]) => nodeId);
  const ordered: string[] = [];
  while (queue.length) {
    const nodeId = queue.shift()!;
    ordered.push(nodeId);
    for (const edge of (outgoingByNode.get(nodeId) || []).filter((item) => item.role !== "retry")) {
      if (!indegree.has(edge.target)) continue;
      const next = (indegree.get(edge.target) || 0) - 1;
      indegree.set(edge.target, next);
      if (next === 0) queue.push(edge.target);
    }
  }
  if (ordered.length !== activeNodes.length) issues.push(issue("UNBOUNDED_CYCLE", "The workflow contains an unbounded cycle. Return corrected data only through a bounded Retry gate."));

  const forwardEdges = graph.edges.filter((edge) => edge.role !== "retry");
  for (const retryEdge of graph.edges.filter((edge) => edge.role === "retry")) {
    const gate = nodeById.get(retryEdge.target);
    const source = nodeById.get(retryEdge.source);
    if (!gate || !source || gate.type !== "logic.retry-gate" || retryEdge.targetPort !== "feedback") continue;
    const reachable = new Set<string>();
    const pending = [gate.id];
    while (pending.length) {
      const current = pending.shift()!;
      if (reachable.has(current)) continue;
      reachable.add(current);
      pending.push(...forwardEdges.filter((edge) => edge.source === current).map((edge) => edge.target));
    }
    if (!reachable.has(source.id)) {
      issues.push(issue("RETRY_ROUTE_DIRECTION", `“${source.name}” is not downstream of “${gate.name}”; a Retry route must return a checked and repaired value to its own gate.`, { edgeId: retryEdge.id }));
      continue;
    }
    const ancestors = new Set<string>();
    const backwards = [source.id];
    while (backwards.length) {
      const current = backwards.shift()!;
      if (ancestors.has(current)) continue;
      ancestors.add(current);
      backwards.push(...forwardEdges.filter((edge) => edge.target === current).map((edge) => edge.source));
    }
    for (const nodeId of [...reachable].filter((id) => ancestors.has(id))) {
      const loopNode = nodeById.get(nodeId);
      const definition = loopNode && automationNodeDefinition(loopNode.type, loopNode.version);
      if (loopNode && loopNode.id !== gate.id && !definition?.retrySafe) {
        issues.push(issue("UNSAFE_RETRY_BODY", `“${loopNode.name}” cannot run inside a Retry path. Keep generation, external services, child workflows and final outputs after the successful check.`, { nodeId: loopNode.id, edgeId: retryEdge.id }));
      }
    }
  }

  if (triggers.length === 1) {
    const reachable = new Set<string>();
    const pending = [triggers[0].id];
    while (pending.length) {
      const nodeId = pending.shift()!;
      if (reachable.has(nodeId)) continue;
      reachable.add(nodeId);
      for (const edge of outgoingByNode.get(nodeId) || []) pending.push(edge.target);
    }
    for (const node of activeNodes) {
      if (!reachable.has(node.id)) issues.push(issue("UNREACHABLE_NODE", `“${node.name}” cannot be reached from the trigger.`, { nodeId: node.id }));
    }
  }

  return { valid: issues.length === 0, issues };
}

export function automationRunInputFields(graph: AutomationWorkflowGraph): AutomationRunInputField[] {
  const fields: AutomationRunInputField[] = [];
  for (const node of graph.nodes) {
    const definition = automationNodeDefinition(node.type, node.version);
    if (!definition || node.disabled) continue;
    for (const [bindingId, binding] of Object.entries(node.bindings)) {
      if (binding.mode !== "ask-on-run") continue;
      const field = definition.fields.find((item) => item.id === bindingId);
      fields.push({
        key: `${node.id}.${bindingId}`,
        nodeId: node.id,
        bindingId,
        label: binding.label || field?.label || bindingId,
        required: Boolean(field?.required || binding.required),
        valueType: runtimeValueType(field || { id: bindingId, label: bindingId, kind: "text" }),
        fieldKind: field?.kind || "text",
        modelCapability: field?.modelCapability,
        options: field?.options,
        min: field?.min,
        max: field?.max,
        selectionLimit: field?.kind === "references"
          ? Math.min(field.max ?? 32, Math.max(1, Number(node.config.maxItems ?? field.max ?? 32)))
          : undefined,
        value: binding.value ?? node.config[bindingId] ?? field?.defaultValue,
      });
    }
  }
  return fields;
}

export function validateAutomationRunInputs(graph: AutomationWorkflowGraph, values: Record<string, unknown>): AutomationValidationResult {
  const fields = automationRunInputFields(graph);
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const issues: AutomationValidationIssue[] = [];
  try {
    if (JSON.stringify(values).length > 512_000) issues.push(issue("RUN_INPUTS_TOO_LARGE", "Run inputs are larger than the 512 KB safety limit."));
  } catch {
    issues.push(issue("INVALID_RUN_INPUT", "Run inputs must be serializable."));
  }
  for (const key of Object.keys(values)) {
    if (!byKey.has(key)) issues.push(issue("UNEXPECTED_RUN_INPUT", `Run input “${key}” is not used by this live workflow.`));
  }
  for (const field of fields) {
    const value = values[field.key];
    if (emptySetting(value)) {
      if (field.required) issues.push(issue("MISSING_RUN_INPUT", `Complete ${field.label}.`, { nodeId: field.nodeId }));
      continue;
    }
    if (field.valueType === "boolean" && typeof value !== "boolean") issues.push(issue("INVALID_RUN_INPUT", `${field.label} must be enabled or disabled.`, { nodeId: field.nodeId }));
    if (field.valueType === "number") {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) issues.push(issue("INVALID_RUN_INPUT", `${field.label} must be a number.`, { nodeId: field.nodeId }));
      else if ((field.min !== undefined && numeric < field.min) || (field.max !== undefined && numeric > field.max)) {
        issues.push(issue("INVALID_RUN_INPUT", `${field.label} must be between ${field.min ?? "−∞"} and ${field.max ?? "∞"}.`, { nodeId: field.nodeId }));
      }
    }
    if (field.valueType === "json" && (typeof value !== "object" || value === null)) issues.push(issue("INVALID_RUN_INPUT", `${field.label} must be valid JSON.`, { nodeId: field.nodeId }));
    if (field.valueType === "visual-references") {
      const ids = Array.isArray(value) ? value.map((entry) => typeof entry === "string" ? entry.trim() : "") : [];
      if (!Array.isArray(value) || ids.some((id) => !id)) issues.push(issue("INVALID_RUN_INPUT", `${field.label} must contain valid image references.`, { nodeId: field.nodeId }));
      else if (new Set(ids).size !== ids.length) issues.push(issue("INVALID_RUN_INPUT", `${field.label} contains the same image more than once.`, { nodeId: field.nodeId }));
      else if (field.selectionLimit !== undefined && ids.length > field.selectionLimit) issues.push(issue("INVALID_RUN_INPUT", `${field.label} can contain at most ${field.selectionLimit} images.`, { nodeId: field.nodeId }));
    }
    if (["string", "tiktok-source", "identity", "assistant-model", "image-model", "aspect-ratio", "resolution"].includes(field.valueType) && typeof value !== "string") {
      issues.push(issue("INVALID_RUN_INPUT", `${field.label} must be text.`, { nodeId: field.nodeId }));
    }
    if (field.options?.length && !field.options.some((option) => option.value === String(value))) {
      issues.push(issue("INVALID_RUN_INPUT", `${field.label} has an unsupported value.`, { nodeId: field.nodeId }));
    }
  }
  return { valid: issues.length === 0, issues };
}

export function topologicalAutomationNodeIds(graph: AutomationWorkflowGraph) {
  const active = graph.nodes.filter((node) => !node.disabled);
  const indegree = new Map(active.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges.filter((item) => item.role !== "retry")) {
    if (!indegree.has(edge.source) || !indegree.has(edge.target)) continue;
    indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) || []), edge.target]);
  }
  const queue = [...indegree.entries()].filter(([, count]) => count === 0).map(([id]) => id);
  const ordered: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    ordered.push(id);
    for (const target of outgoing.get(id) || []) {
      const count = (indegree.get(target) || 0) - 1;
      indegree.set(target, count);
      if (count === 0) queue.push(target);
    }
  }
  return ordered;
}
