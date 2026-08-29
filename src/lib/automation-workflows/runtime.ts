import { automationNodeDefinition, automationNodeInputPorts } from "./registry";
import { parseAutomationSlidePlanSet } from "./slide-plan-contract";
import { parseAutomationImageGenerationRequestBatch } from "./image-generation-request";
import { parseAutomationPortValue } from "./port-contracts";
import { automationWorkflowGraphSchema, DEFAULT_AUTOMATION_WORKFLOW_SETTINGS, type AutomationNode, type AutomationPortType, type AutomationWorkflowGraph, type AutomationWorkflowSettings } from "./types";
import { topologicalAutomationNodeIds, validateAutomationWorkflowGraph } from "./validation";

export type AutomationExecutionContext = {
  runId: string;
  workflowId?: string;
  userId: string;
  workspaceId: string;
  projectId: string;
  runtimeInputs: Record<string, unknown>;
  triggerPayload?: unknown;
  workerId?: string;
  runKind?: "production" | "test" | "replay" | "trigger" | "subworkflow" | "node-preview";
  deadlineAt?: string;
  executionDepth?: number;
  replayOfRunId?: string | null;
  credentialIds?: Record<string, string>;
  signal?: AbortSignal;
  policy?: AutomationWorkflowSettings;
  budget?: {
    reserve: (nodeId: string, requestedCredits: number) => Promise<string | null>;
    settle: (reservationId: string | null, actualCredits: number) => Promise<void>;
    release: (reservationId: string | null) => Promise<void>;
  };
  usage?: {
    reserveGeneratedAssets: (count: number, usageKey: string) => Promise<void>;
  };
  subworkflow?: {
    run: (input: { parentNodeId: string; parentAttempt: number; slotKey: string; payload: unknown; runtimeInputs?: Record<string, unknown>; itemIndex?: number }) => Promise<{ runId: string; output: unknown; warningCount: number }>;
  };
};

export type AutomationInputConnection = {
  sourceNodeId: string;
  sourceNodeName: string;
  sourcePort: string;
  sourceType?: AutomationPortType;
  targetPort: string;
  value: unknown;
};

export type AutomationNodeExecution = {
  node: AutomationNode;
  config: Record<string, unknown>;
  inputs: Record<string, unknown>;
  attempt: number;
  /** Monotonic persisted attempt for this node across bounded graph retries. */
  durableAttempt?: number;
  /** Zero for the first pass, then one-based for a Retry gate feedback pass. */
  retryIteration?: number;
  context: AutomationExecutionContext;
  outputsByNode: ReadonlyMap<string, Record<string, unknown>>;
  /** Provenance for values received through graph edges. Direct handler tests and
   * external handler adapters may omit it; the graph runtime always supplies it. */
  inputConnections?: Readonly<Record<string, AutomationInputConnection[]>>;
};

export type AutomationNodeHandler = (execution: AutomationNodeExecution) => Promise<Record<string, unknown>>;
export type AutomationNodeHandlers = Record<string, AutomationNodeHandler>;

export type AutomationRunInputSnapshotEntry = {
  nodeType: string;
  nodeVersion: number;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
};

export type AutomationRunInputSnapshot = Record<string, AutomationRunInputSnapshotEntry>;

export type AutomationExecutionObserver = {
  nodeStarted?: (node: AutomationNode, input: Record<string, unknown>, attempt: number) => Promise<void> | void;
  nodeCompleted?: (node: AutomationNode, output: Record<string, unknown>, attempt: number) => Promise<void> | void;
  nodeFailed?: (node: AutomationNode, error: unknown, attempt: number) => Promise<void> | void;
  nodeContinued?: (node: AutomationNode, output: Record<string, unknown>, attempt: number, reason: string) => Promise<void> | void;
  nodeSkipped?: (node: AutomationNode, reason: string, attempt: number) => Promise<void> | void;
};

function signalAbortError(signal?: AbortSignal) {
  const reason = signal?.reason;
  if (reason instanceof Error && typeof (reason as Error & { code?: unknown }).code === "string") return reason;
  return Object.assign(new Error("Automation cancelled"), { code: "RUN_CANCELLED", cause: reason });
}

function executionAbortError(context: AutomationExecutionContext) { return signalAbortError(context.signal); }

function assertExecutionWithinPolicy(context: AutomationExecutionContext) {
  if (context.signal?.aborted) throw executionAbortError(context);
  if (context.deadlineAt && Date.now() >= new Date(context.deadlineAt).getTime()) {
    throw Object.assign(new Error("Workflow exceeded its configured timeout"), { code: "WORKFLOW_TIMEOUT" });
  }
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal) {
  if (!signal) return await new Promise((resolve) => setTimeout(resolve, milliseconds));
  if (signal.aborted) throw signalAbortError(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, milliseconds);
    const onAbort = () => { clearTimeout(timer); reject(signalAbortError(signal)); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function validatePortValue(type: AutomationPortType, value: unknown, label: string, code = "NODE_OUTPUT_CONTRACT") {
  try {
    if (type === "slide-plan-set") parseAutomationSlidePlanSet(value, label);
    else if (type === "image-request-batch") parseAutomationImageGenerationRequestBatch(value);
    else parseAutomationPortValue(type, value);
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code });
  }
}

function validatedNodeInputs(node: AutomationNode, inputs: Record<string, unknown>) {
  for (const port of automationNodeInputPorts(node)) {
    const value = inputs[port.id];
    if (value === undefined) continue;
    if (port.multiple) {
      if (!Array.isArray(value)) throw Object.assign(new Error(`“${node.name}” input “${port.label}” must receive a list of connected values`), { code: "NODE_INPUT_CONTRACT" });
      value.forEach((entry, index) => validatePortValue(port.type, entry, `“${node.name}” input “${port.label}” item ${index + 1}`, "NODE_INPUT_CONTRACT"));
    } else validatePortValue(port.type, value, `“${node.name}” input “${port.label}”`, "NODE_INPUT_CONTRACT");
  }
  return inputs;
}

function validatedNodeOutput(node: AutomationNode, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error(`“${node.name}” returned an invalid output object`), { code: "NODE_OUTPUT_CONTRACT" });
  }
  const output = value as Record<string, unknown>;
  const definition = automationNodeDefinition(node.type, node.version);
  const allowed = new Set(definition?.outputs.map((port) => port.id) || []);
  const internalAllowed = new Set(["__usage", "__warnings", "__skipped", "__retryIteration", "__retryEpochs"]);
  const unknown = Object.keys(output).filter((key) => key.startsWith("__") ? !internalAllowed.has(key) : !allowed.has(key));
  if (unknown.length) {
    throw Object.assign(new Error(`“${node.name}” returned unavailable output ${unknown.join(", ")}`), { code: "NODE_OUTPUT_CONTRACT" });
  }
  if (output.__warnings !== undefined && (!Array.isArray(output.__warnings) || output.__warnings.some((warning) => typeof warning !== "string"))) {
    throw Object.assign(new Error(`“${node.name}” returned invalid warning metadata`), { code: "NODE_OUTPUT_CONTRACT" });
  }
  if (output.__skipped !== undefined && typeof output.__skipped !== "string") {
    throw Object.assign(new Error(`“${node.name}” returned invalid skipped-step metadata`), { code: "NODE_OUTPUT_CONTRACT" });
  }
  if (output.__usage !== undefined) {
    const usage = output.__usage;
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
      throw Object.assign(new Error(`“${node.name}” returned invalid usage metadata`), { code: "NODE_OUTPUT_CONTRACT" });
    }
    for (const key of ["chargedCredits", "costUsd"] as const) {
      const amount = (usage as Record<string, unknown>)[key];
      if (amount !== undefined && (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0)) {
        throw Object.assign(new Error(`“${node.name}” returned invalid ${key} usage metadata`), { code: "NODE_OUTPUT_CONTRACT" });
      }
    }
  }
  if (output.__retryIteration !== undefined) {
    if (node.type !== "logic.retry-gate" || typeof output.__retryIteration !== "number" || !Number.isSafeInteger(output.__retryIteration) || output.__retryIteration < 0) {
      throw Object.assign(new Error(`“${node.name}” returned invalid Retry gate metadata`), { code: "NODE_OUTPUT_CONTRACT" });
    }
  }
  outputRetryEpochs(output);
  const produced = [...allowed].some((key) => Object.prototype.hasOwnProperty.call(output, key) && output[key] !== undefined);
  if (!produced) throw Object.assign(new Error(`“${node.name}” produced no usable output`), { code: "NODE_OUTPUT_CONTRACT" });
  for (const port of definition?.outputs || []) {
    if (output[port.id] === undefined) continue;
    validatePortValue(port.type, output[port.id], `“${node.name}” output “${port.label}”`);
  }
  try {
    if (JSON.stringify(output).length > 5_000_000) throw new Error("too large");
  } catch {
    throw Object.assign(new Error(`“${node.name}” produced output that cannot be stored safely`), { code: "NODE_OUTPUT_CONTRACT" });
  }
  return output;
}

function resolvedNodeConfig(node: AutomationNode, runtimeInputs: Record<string, unknown>) {
  const definition = automationNodeDefinition(node.type, node.version);
  const config: Record<string, unknown> = {
    ...Object.fromEntries((definition?.fields || []).filter((field) => field.defaultValue !== undefined).map((field) => [field.id, structuredClone(field.defaultValue)])),
    ...structuredClone(node.config),
  };
  for (const [field, binding] of Object.entries(node.bindings)) {
    const key = `${node.id}.${field}`;
    if (binding.mode === "ask-on-run" && key in runtimeInputs) config[field] = runtimeInputs[key];
    else if (binding.mode === "fixed" && binding.value !== undefined) config[field] = binding.value;
  }
  return config;
}

function nodeAttemptLimit(node: AutomationNode, config: Record<string, unknown>) {
  if (node.type === "generation.image") return 1;
  const definition = automationNodeDefinition(node.type, node.version);
  if (!definition?.fields.some((field) => field.id === "maxAttempts")) return 1;
  const value = config.maxAttempts;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 8) {
    throw Object.assign(new Error(`“${node.name}” has an invalid retry-attempt setting`), { code: "NODE_CONFIGURATION_INVARIANT" });
  }
  return value;
}

function nodeFailureMode(node: AutomationNode, config: Record<string, unknown>) {
  const definition = automationNodeDefinition(node.type, node.version);
  const field = definition?.fields.find((candidate) => candidate.id === "failureMode");
  if (!field) return "stop";
  const value = config.failureMode;
  if (typeof value !== "string" || !field.options?.some((option) => option.value === value)) {
    throw Object.assign(new Error(`“${node.name}” has an invalid failure behavior`), { code: "NODE_CONFIGURATION_INVARIANT" });
  }
  return value;
}

function nodeInputState(
  graph: AutomationWorkflowGraph,
  node: AutomationNode,
  outputs: Map<string, Record<string, unknown>>,
  retryFeedbacks: ReadonlyMap<string, unknown> = new Map(),
) {
  const values: Record<string, unknown> = {};
  const connectionsByPort: Record<string, AutomationInputConnection[]> = {};
  const inputPorts = automationNodeInputPorts(node);
  const nodeById = new Map(graph.nodes.map((candidate) => [candidate.id, candidate]));
  for (const port of inputPorts) {
    const connections = graph.edges.filter((edge) => edge.target === node.id && edge.targetPort === port.id);
    const resolvedConnections = connections.flatMap((edge) => {
      const value = edge.role === "retry" ? retryFeedbacks.get(node.id) : outputs.get(edge.source)?.[edge.sourcePort];
      if (value === undefined) return [];
      const sourceNode = nodeById.get(edge.source);
      const sourceType = sourceNode ? automationNodeDefinition(sourceNode.type, sourceNode.version)?.outputs.find((candidate) => candidate.id === edge.sourcePort)?.type : undefined;
      return [{ sourceNodeId: edge.source, sourceNodeName: sourceNode?.name || edge.source, sourcePort: edge.sourcePort, sourceType, targetPort: edge.targetPort, value }];
    });
    connectionsByPort[port.id] = resolvedConnections;
    const connectedValues = resolvedConnections.map((connection) => connection.value);
    values[port.id] = port.multiple ? connectedValues : connectedValues[0];
  }
  return { values, connectionsByPort };
}

function outputRetryEpochs(output: Record<string, unknown> | undefined) {
  const value = output?.__retryEpochs;
  if (value === undefined) return {} as Record<string, number>;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("Saved retry metadata must be one object"), { code: "NODE_OUTPUT_CONTRACT" });
  }
  const epochs: Record<string, number> = {};
  for (const [gateId, epoch] of Object.entries(value as Record<string, unknown>)) {
    if (!gateId || typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0) {
      throw Object.assign(new Error("Saved retry metadata contains an invalid retry epoch"), { code: "NODE_OUTPUT_CONTRACT" });
    }
    epochs[gateId] = epoch;
  }
  return epochs;
}

function outputRetryIteration(nodeId: string, output: Record<string, unknown> | undefined) {
  const direct = output?.__retryIteration;
  if (direct !== undefined && (typeof direct !== "number" || !Number.isSafeInteger(direct) || direct < 0)) {
    throw Object.assign(new Error("Saved Retry gate output contains an invalid iteration"), { code: "NODE_OUTPUT_CONTRACT" });
  }
  const inherited = outputRetryEpochs(output)[nodeId];
  if (direct !== undefined && inherited !== undefined && direct !== inherited) {
    throw Object.assign(new Error("Saved Retry gate output has contradictory iteration metadata"), { code: "NODE_OUTPUT_CONTRACT" });
  }
  return direct ?? inherited ?? 0;
}

function inheritedRetryEpochs(inputConnections: Readonly<Record<string, AutomationInputConnection[]>>, outputs: ReadonlyMap<string, Record<string, unknown>>) {
  const epochs: Record<string, number> = {};
  for (const connection of Object.values(inputConnections).flat()) {
    for (const [gateId, epoch] of Object.entries(outputRetryEpochs(outputs.get(connection.sourceNodeId)))) {
      epochs[gateId] = Math.max(epochs[gateId] ?? 0, epoch);
    }
  }
  return epochs;
}

function forwardDescendants(graph: AutomationWorkflowGraph, startNodeId: string) {
  const descendants = new Set<string>();
  const pending = [startNodeId];
  while (pending.length) {
    const nodeId = pending.shift()!;
    if (descendants.has(nodeId)) continue;
    descendants.add(nodeId);
    pending.push(...graph.edges.filter((edge) => edge.role !== "retry" && edge.source === nodeId).map((edge) => edge.target));
  }
  return descendants;
}

function missingRequiredInput(node: AutomationNode, inputs: Record<string, unknown>, options: { nullIsMissing?: boolean } = {}) {
  return automationNodeInputPorts(node).find((port) => port.required && (
    inputs[port.id] === undefined
    || (options.nullIsMissing && inputs[port.id] === null)
    || (port.multiple && Array.isArray(inputs[port.id]) && !(inputs[port.id] as unknown[]).length)
  ));
}

export async function materializeAutomationRunInputSnapshot(input: {
  graph: AutomationWorkflowGraph;
  context: AutomationExecutionContext;
  handlers: AutomationNodeHandlers;
}) {
  const graph = automationWorkflowGraphSchema.parse(input.graph);
  const validation = validateAutomationWorkflowGraph(graph);
  if (!validation.valid) throw Object.assign(new Error(`Workflow is invalid: ${validation.issues.map((entry) => entry.message).join("; ")}`), { code: "WORKFLOW_INVALID" });
  const outputs = new Map<string, Record<string, unknown>>();
  const snapshot: AutomationRunInputSnapshot = {};
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const snapshotNodeIds = topologicalAutomationNodeIds(graph).filter((nodeId) => {
    const node = nodeById.get(nodeId)!;
    const category = automationNodeDefinition(node.type, node.version)?.category;
    return !node.disabled && (category === "trigger" || category === "input");
  });
  for (const nodeId of snapshotNodeIds) {
    const node = nodeById.get(nodeId)!;
    const definition = automationNodeDefinition(node.type, node.version);
    if (!definition) throw Object.assign(new Error(`No definition is installed for ${node.type}@${node.version}`), { code: "INPUT_SNAPSHOT_NODE_UNAVAILABLE" });
    const inputState = nodeInputState(graph, node, outputs);
    const missing = missingRequiredInput(node, inputState.values);
    if (missing) throw Object.assign(new Error(`Cannot snapshot “${node.name}”: required input “${missing.label}” produced no value`), { code: "INPUT_SNAPSHOT_INCOMPLETE" });
    const handler = input.handlers[`${node.type}@${node.version}`];
    if (!handler) throw Object.assign(new Error(`No runtime handler is installed for ${node.type}@${node.version}`), { code: "INPUT_SNAPSHOT_HANDLER_MISSING" });
    assertExecutionWithinPolicy(input.context);
    const nodeInput = validatedNodeInputs(node, inputState.values);
    const output = validatedNodeOutput(node, await handler({
      node,
      config: resolvedNodeConfig(node, input.context.runtimeInputs),
      inputs: structuredClone(nodeInput),
      attempt: 1,
      durableAttempt: 1,
      context: input.context,
      outputsByNode: outputs,
      inputConnections: inputState.connectionsByPort,
    }));
    assertExecutionWithinPolicy(input.context);
    outputs.set(node.id, output);
    snapshot[node.id] = {
      nodeType: node.type,
      nodeVersion: node.version,
      input: structuredClone(nodeInput),
      output: structuredClone(output),
    };
  }
  const serialized = JSON.stringify(snapshot);
  if (serialized.length > 20_000_000) throw Object.assign(new Error("Resolved workflow inputs exceed the 20 MB run snapshot limit"), { code: "INPUT_SNAPSHOT_TOO_LARGE" });
  return snapshot;
}

export function parseAutomationRunInputSnapshot(graphInput: AutomationWorkflowGraph, value: unknown) {
  const graph = automationWorkflowGraphSchema.parse(graphInput);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("Saved workflow input snapshot must be one object"), { code: "INPUT_SNAPSHOT_INVALID" });
  }
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const snapshot: AutomationRunInputSnapshot = {};
  for (const [nodeId, rawEntry] of Object.entries(value as Record<string, unknown>)) {
    const node = nodeById.get(nodeId);
    const definition = node && automationNodeDefinition(node.type, node.version);
    if (!node || !definition || !["trigger", "input"].includes(definition.category)) {
      throw Object.assign(new Error(`Saved input snapshot references unavailable input step ${nodeId}`), { code: "INPUT_SNAPSHOT_INVALID" });
    }
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) throw Object.assign(new Error(`Saved input snapshot for ${nodeId} is invalid`), { code: "INPUT_SNAPSHOT_INVALID" });
    const entry = rawEntry as Record<string, unknown>;
    if (entry.nodeType !== node.type || entry.nodeVersion !== node.version || !entry.input || typeof entry.input !== "object" || Array.isArray(entry.input)) {
      throw Object.assign(new Error(`Saved input snapshot does not match ${node.type}@${node.version}`), { code: "INPUT_SNAPSHOT_INVALID" });
    }
    const output = validatedNodeOutput(node, entry.output);
    const nodeInput = validatedNodeInputs(node, entry.input as Record<string, unknown>);
    snapshot[nodeId] = { nodeType: node.type, nodeVersion: node.version, input: nodeInput, output };
  }
  const expected = graph.nodes.filter((node) => {
    const category = automationNodeDefinition(node.type, node.version)?.category;
    return !node.disabled && (category === "trigger" || category === "input");
  }).map((node) => node.id);
  const missing = expected.filter((nodeId) => !snapshot[nodeId]);
  if (missing.length) throw Object.assign(new Error(`Saved input snapshot is missing steps: ${missing.join(", ")}`), { code: "INPUT_SNAPSHOT_INCOMPLETE" });
  return snapshot;
}

export async function executeAutomationNodePreview(input: {
  graph: AutomationWorkflowGraph;
  nodeId: string;
  nodeInputs: Record<string, unknown>;
  context: AutomationExecutionContext;
  handlers: AutomationNodeHandlers;
  observer?: AutomationExecutionObserver;
}) {
  const graph = automationWorkflowGraphSchema.parse(input.graph);
  const validation = validateAutomationWorkflowGraph(graph);
  if (!validation.valid) throw new Error(`Workflow is invalid: ${validation.issues.map((entry) => entry.message).join("; ")}`);
  const node = graph.nodes.find((candidate) => candidate.id === input.nodeId && !candidate.disabled);
  if (!node) throw Object.assign(new Error("Preview step is unavailable in this workflow version"), { code: "PREVIEW_NODE_MISSING" });
  const definition = automationNodeDefinition(node.type, node.version);
  if (!definition) throw Object.assign(new Error(`No definition is installed for ${node.type}@${node.version}`), { code: "PREVIEW_NODE_UNAVAILABLE" });
  if (definition.category === "trigger") throw Object.assign(new Error("Trigger steps receive events and cannot be executed as a preview"), { code: "PREVIEW_TRIGGER_UNSUPPORTED" });
  const allowedInputs = new Set(automationNodeInputPorts(node).map((port) => port.id));
  const unknownInputs = Object.keys(input.nodeInputs).filter((key) => !allowedInputs.has(key));
  if (unknownInputs.length) throw Object.assign(new Error(`Fixture contains unavailable input ports: ${unknownInputs.join(", ")}`), { code: "PREVIEW_INPUT_INVALID" });
  const missing = missingRequiredInput(node, input.nodeInputs, { nullIsMissing: true });
  if (missing) throw Object.assign(new Error(`Fixture must provide “${missing.label}”`), { code: "PREVIEW_INPUT_MISSING" });
  const handler = input.handlers[`${node.type}@${node.version}`];
  if (!handler) throw Object.assign(new Error(`No runtime handler is installed for ${node.type}@${node.version}`), { code: "PREVIEW_HANDLER_MISSING" });
  assertExecutionWithinPolicy(input.context);
  validatedNodeInputs(node, input.nodeInputs);
  await input.observer?.nodeStarted?.(node, input.nodeInputs, 1);
  try {
    const output = validatedNodeOutput(node, await handler({
      node,
      config: resolvedNodeConfig(node, input.context.runtimeInputs),
      inputs: structuredClone(input.nodeInputs),
      attempt: 1,
      context: { ...input.context, runKind: "node-preview" },
      outputsByNode: new Map(),
      inputConnections: {},
    }));
    assertExecutionWithinPolicy(input.context);
    await input.observer?.nodeCompleted?.(node, output, 1);
    return { node, output, warnings: Array.isArray(output.__warnings) ? output.__warnings.map(String) : [] };
  } catch (error) {
    const failure = input.context.signal?.aborted ? executionAbortError(input.context) : error;
    await input.observer?.nodeFailed?.(node, failure, 1);
    throw failure;
  }
}

export async function executeAutomationGraph(input: {
  graph: AutomationWorkflowGraph;
  context: AutomationExecutionContext;
  handlers: AutomationNodeHandlers;
  observer?: AutomationExecutionObserver;
  initialOutputs?: ReadonlyMap<string, Record<string, unknown>>;
}) {
  const graph = automationWorkflowGraphSchema.parse(input.graph);
  const validation = validateAutomationWorkflowGraph(graph);
  if (!validation.valid) throw new Error(`Workflow is invalid: ${validation.issues.map((entry) => entry.message).join("; ")}`);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const outputs = new Map<string, Record<string, unknown>>(input.initialOutputs || []);
  for (const [nodeId, output] of outputs) {
    const node = nodeById.get(nodeId);
    if (!node) throw Object.assign(new Error(`Saved output references unavailable step ${nodeId}`), { code: "NODE_OUTPUT_CONTRACT" });
    validatedNodeOutput(node, output);
  }
  const retryIterations = new Map<string, number>();
  for (const node of graph.nodes.filter((candidate) => candidate.type === "logic.retry-gate")) {
    const output = outputs.get(node.id);
    const iteration = outputRetryIteration(node.id, output);
    retryIterations.set(node.id, iteration);
  }
  // A worker may resume after a retry gate has already consumed feedback. Any
  // downstream output from an older retry epoch is stale and must be executed
  // again instead of being mistaken for the current pass.
  for (const [nodeId, output] of [...outputs]) {
    const epochs = outputRetryEpochs(output);
    if ([...retryIterations].some(([gateId, epoch]) => epochs[gateId] !== undefined && epochs[gateId] < epoch)) outputs.delete(nodeId);
  }
  const skipped = new Set<string>();
  const warnings: Array<{ nodeId: string; message: string }> = [];
  const observerAttempts = new Map<string, number>();
  const retryFeedbacks = new Map<string, unknown>();
  let nodeExecutions = 0;
  const policy = { ...DEFAULT_AUTOMATION_WORKFLOW_SETTINGS, ...(graph.settings || {}), ...(input.context.policy || {}) };
  const executionContext = { ...input.context, policy };
  const maximumExecutions = policy.maxNodeExecutions;
  const orderedNodeIds = topologicalAutomationNodeIds(graph);
  while (true) {
    for (const nodeId of orderedNodeIds) {
      const node = nodeById.get(nodeId)!;
      if (outputs.has(node.id)) continue;
      const inputState = nodeInputState(graph, node, outputs, retryFeedbacks);
      const inputs = inputState.values;
      const missing = missingRequiredInput(node, inputs);
      if (missing) {
        skipped.add(node.id);
        const observerAttempt = (observerAttempts.get(node.id) || 0) + 1;
        observerAttempts.set(node.id, observerAttempt);
        await input.observer?.nodeSkipped?.(node, `Required input “${missing.label}” produced no value`, observerAttempt);
        continue;
      }
      validatedNodeInputs(node, inputs);
      skipped.delete(node.id);
      const handler = input.handlers[`${node.type}@${node.version}`];
      if (!handler) throw new Error(`No runtime handler is installed for ${node.type}@${node.version}`);
      assertExecutionWithinPolicy(executionContext);
      nodeExecutions += 1;
      if (nodeExecutions > maximumExecutions) throw Object.assign(new Error(`Workflow exceeded its ${maximumExecutions} step execution limit`), { code: "NODE_EXECUTION_LIMIT" });
      const config = resolvedNodeConfig(node, input.context.runtimeInputs);
      // Generation owns per-item retries and durable artifacts internally. An
      // outer node retry would multiply provider attempts for the same failed
      // slide; all other nodes use the single registry-defined value exactly.
      const maxAttempts = nodeAttemptLimit(node, config);
      let completed = false;
      let latestError: unknown;
      let latestObserverAttempt = observerAttempts.get(node.id) || 0;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const observerAttempt = (observerAttempts.get(node.id) || 0) + 1;
        observerAttempts.set(node.id, observerAttempt);
        latestObserverAttempt = observerAttempt;
        await input.observer?.nodeStarted?.(node, inputs, observerAttempt);
        try {
          const output = validatedNodeOutput(node, await handler({
            node,
            config,
            inputs,
            attempt,
            durableAttempt: observerAttempt,
            retryIteration: node.type === "logic.retry-gate" ? retryIterations.get(node.id) || 0 : undefined,
            context: executionContext,
            outputsByNode: outputs,
            inputConnections: inputState.connectionsByPort,
          }));
          const epochs = inheritedRetryEpochs(inputState.connectionsByPort, outputs);
          if (node.type === "logic.retry-gate") epochs[node.id] = retryIterations.get(node.id) || 0;
          if (Object.keys(epochs).length) output.__retryEpochs = epochs;
          assertExecutionWithinPolicy(executionContext);
          outputs.set(node.id, output);
          const outputWarnings = Array.isArray(output.__warnings) ? output.__warnings.map(String) : [];
          const assetFailures = output.assets && typeof output.assets === "object" && Array.isArray((output.assets as { failures?: unknown }).failures)
            ? ((output.assets as { failures: unknown[] }).failures).map((failure) => typeof failure === "object" && failure && "error" in failure ? String((failure as { error: unknown }).error) : String(failure))
            : [];
          warnings.push(...[...outputWarnings, ...assetFailures].map((message) => ({ nodeId: node.id, message })));
          await input.observer?.nodeCompleted?.(node, output, observerAttempt);
          completed = true;
          break;
        } catch (error) {
          const failure = executionContext.signal?.aborted ? executionAbortError(executionContext) : error;
          latestError = failure;
          await input.observer?.nodeFailed?.(node, failure, observerAttempt);
          if (executionContext.signal?.aborted) throw failure;
          if ((failure as { automationRetryable?: unknown })?.automationRetryable === false) break;
          if (attempt < maxAttempts) await abortableDelay(Math.min(8_000, 800 * 2 ** (attempt - 1)), executionContext.signal);
        }
      }
      if (!completed) {
        const failureMode = nodeFailureMode(node, config);
        let continuedOutput: Record<string, unknown> | null = null;
        if (failureMode === "continue-empty") {
          const emptyPort = automationNodeDefinition(node.type, node.version)?.outputs.find((port) => port.type !== "error");
          if (!emptyPort) throw latestError;
          continuedOutput = {
            [emptyPort.id]: null,
            __warnings: [latestError instanceof Error ? latestError.message : String(latestError)],
          };
        }
        else if (failureMode === "error-output") {
          const failure = latestError as { message?: unknown; code?: unknown; safeResponse?: unknown } | null;
          continuedOutput = {
            error: {
              message: latestError instanceof Error ? latestError.message : String(latestError),
              nodeId: node.id,
              ...(failure?.code ? { code: String(failure.code) } : {}),
              ...(failure?.safeResponse !== undefined ? { response: failure.safeResponse } : {}),
            },
          };
        }
        else throw latestError;
        const output = validatedNodeOutput(node, continuedOutput);
        const epochs = inheritedRetryEpochs(inputState.connectionsByPort, outputs);
        if (Object.keys(epochs).length) output.__retryEpochs = epochs;
        outputs.set(node.id, output);
        if (failureMode === "continue-empty") {
          warnings.push({ nodeId: node.id, message: latestError instanceof Error ? latestError.message : String(latestError) });
        }
        await input.observer?.nodeContinued?.(node, output, latestObserverAttempt, failureMode);
      }
    }

    const pendingRetry = graph.edges.find((edge) => {
      if (edge.role !== "retry") return false;
      const sourceOutput = outputs.get(edge.source);
      if (sourceOutput?.[edge.sourcePort] === undefined) return false;
      const sourceEpoch = outputRetryEpochs(sourceOutput)[edge.target] ?? 0;
      return sourceEpoch >= (retryIterations.get(edge.target) || 0);
    });
    if (!pendingRetry) break;
    const sourceOutput = outputs.get(pendingRetry.source)!;
    const nextIteration = (retryIterations.get(pendingRetry.target) || 0) + 1;
    retryFeedbacks.set(pendingRetry.target, structuredClone(sourceOutput[pendingRetry.sourcePort]));
    retryIterations.set(pendingRetry.target, nextIteration);
    for (const nodeId of forwardDescendants(graph, pendingRetry.target)) {
      outputs.delete(nodeId);
      skipped.delete(nodeId);
    }
  }
  const terminalNodeIds = graph.nodes
    .filter((node) => !node.disabled && automationNodeDefinition(node.type, node.version)?.terminal)
    .map((node) => node.id);
  const completedTerminalNodeIds = terminalNodeIds.filter((nodeId) => outputs.has(nodeId));
  if (!completedTerminalNodeIds.length) {
    throw Object.assign(new Error("Workflow finished without producing any final output. Check condition and error branches."), { code: "NO_TERMINAL_OUTPUT" });
  }
  return { outputs, skipped, terminalNodeIds, completedTerminalNodeIds, warnings, nodeExecutions };
}
