import { automationNodeDefinition, automationNodeInputPorts } from "./registry";
import { DEFAULT_AUTOMATION_WORKFLOW_SETTINGS, type AutomationNode, type AutomationWorkflowGraph, type AutomationWorkflowSettings } from "./types";
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
  targetPort: string;
  value: unknown;
};

export type AutomationNodeExecution = {
  node: AutomationNode;
  config: Record<string, unknown>;
  inputs: Record<string, unknown>;
  attempt: number;
  context: AutomationExecutionContext;
  outputsByNode: ReadonlyMap<string, Record<string, unknown>>;
  /** Provenance for values received through graph edges. Direct handler tests and
   * external handler adapters may omit it; the graph runtime always supplies it. */
  inputConnections?: Readonly<Record<string, AutomationInputConnection[]>>;
};

export type AutomationNodeHandler = (execution: AutomationNodeExecution) => Promise<Record<string, unknown>>;
export type AutomationNodeHandlers = Record<string, AutomationNodeHandler>;

export type AutomationExecutionObserver = {
  nodeStarted?: (node: AutomationNode, input: Record<string, unknown>, attempt: number) => Promise<void> | void;
  nodeCompleted?: (node: AutomationNode, output: Record<string, unknown>, attempt: number) => Promise<void> | void;
  nodeFailed?: (node: AutomationNode, error: unknown, attempt: number) => Promise<void> | void;
  nodeContinued?: (node: AutomationNode, output: Record<string, unknown>, attempt: number, reason: string) => Promise<void> | void;
  nodeSkipped?: (node: AutomationNode, reason: string) => Promise<void> | void;
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

function validatedNodeOutput(node: AutomationNode, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error(`“${node.name}” returned an invalid output object`), { code: "NODE_OUTPUT_CONTRACT" });
  }
  const output = value as Record<string, unknown>;
  const definition = automationNodeDefinition(node.type, node.version);
  const allowed = new Set(definition?.outputs.map((port) => port.id) || []);
  const unknown = Object.keys(output).filter((key) => !key.startsWith("__") && !allowed.has(key));
  if (unknown.length) {
    throw Object.assign(new Error(`“${node.name}” returned unavailable output ${unknown.join(", ")}`), { code: "NODE_OUTPUT_CONTRACT" });
  }
  const produced = [...allowed].some((key) => Object.prototype.hasOwnProperty.call(output, key) && output[key] !== undefined);
  if (!produced) throw Object.assign(new Error(`“${node.name}” produced no usable output`), { code: "NODE_OUTPUT_CONTRACT" });
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

function nodeInputState(graph: AutomationWorkflowGraph, node: AutomationNode, outputs: Map<string, Record<string, unknown>>) {
  const values: Record<string, unknown> = {};
  const connectionsByPort: Record<string, AutomationInputConnection[]> = {};
  const inputPorts = automationNodeInputPorts(node);
  const nodeById = new Map(graph.nodes.map((candidate) => [candidate.id, candidate]));
  for (const port of inputPorts) {
    const connections = graph.edges.filter((edge) => edge.target === node.id && edge.targetPort === port.id);
    const resolvedConnections = connections.flatMap((edge) => {
      const value = outputs.get(edge.source)?.[edge.sourcePort];
      if (value === undefined) return [];
      return [{ sourceNodeId: edge.source, sourceNodeName: nodeById.get(edge.source)?.name || edge.source, sourcePort: edge.sourcePort, targetPort: edge.targetPort, value }];
    });
    connectionsByPort[port.id] = resolvedConnections;
    const connectedValues = resolvedConnections.map((connection) => connection.value);
    values[port.id] = port.multiple ? connectedValues : connectedValues[0];
  }
  return { values, connectionsByPort };
}

function missingRequiredInput(node: AutomationNode, inputs: Record<string, unknown>, options: { nullIsMissing?: boolean } = {}) {
  return automationNodeInputPorts(node).find((port) => port.required && (
    inputs[port.id] === undefined
    || (options.nullIsMissing && inputs[port.id] === null)
    || (port.multiple && Array.isArray(inputs[port.id]) && !(inputs[port.id] as unknown[]).length)
  ));
}

export async function executeAutomationNodePreview(input: {
  graph: AutomationWorkflowGraph;
  nodeId: string;
  nodeInputs: Record<string, unknown>;
  context: AutomationExecutionContext;
  handlers: AutomationNodeHandlers;
  observer?: AutomationExecutionObserver;
}) {
  const validation = validateAutomationWorkflowGraph(input.graph);
  if (!validation.valid) throw new Error(`Workflow is invalid: ${validation.issues.map((entry) => entry.message).join("; ")}`);
  const node = input.graph.nodes.find((candidate) => candidate.id === input.nodeId && !candidate.disabled);
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
  const validation = validateAutomationWorkflowGraph(input.graph);
  if (!validation.valid) throw new Error(`Workflow is invalid: ${validation.issues.map((entry) => entry.message).join("; ")}`);
  const nodeById = new Map(input.graph.nodes.map((node) => [node.id, node]));
  const outputs = new Map<string, Record<string, unknown>>(input.initialOutputs || []);
  for (const [nodeId, output] of outputs) {
    const node = nodeById.get(nodeId);
    if (!node) throw Object.assign(new Error(`Saved output references unavailable step ${nodeId}`), { code: "NODE_OUTPUT_CONTRACT" });
    validatedNodeOutput(node, output);
  }
  const skipped = new Set<string>();
  const warnings: Array<{ nodeId: string; message: string }> = [];
  let nodeExecutions = 0;
  const policy = { ...DEFAULT_AUTOMATION_WORKFLOW_SETTINGS, ...(input.graph.settings || {}), ...(input.context.policy || {}) };
  const executionContext = { ...input.context, policy };
  const maximumExecutions = policy.maxNodeExecutions;
  for (const nodeId of topologicalAutomationNodeIds(input.graph)) {
    const node = nodeById.get(nodeId)!;
    if (outputs.has(node.id)) continue;
    const inputState = nodeInputState(input.graph, node, outputs);
    const inputs = inputState.values;
    const missing = missingRequiredInput(node, inputs);
    if (missing) {
      skipped.add(node.id);
      await input.observer?.nodeSkipped?.(node, `Required input “${missing.label}” produced no value`);
      continue;
    }
    const handler = input.handlers[`${node.type}@${node.version}`];
    if (!handler) throw new Error(`No runtime handler is installed for ${node.type}@${node.version}`);
    assertExecutionWithinPolicy(executionContext);
    nodeExecutions += 1;
    if (nodeExecutions > maximumExecutions) throw Object.assign(new Error(`Workflow exceeded its ${maximumExecutions} step execution limit`), { code: "NODE_EXECUTION_LIMIT" });
    const config = resolvedNodeConfig(node, input.context.runtimeInputs);
    // Generation owns per-item retries and durable artifacts internally. An
    // outer node retry would multiply provider attempts for the same failed
    // slide; all other nodes keep their explicit node-level retry policy.
    const maxAttempts = node.type === "generation.image" ? 1 : Math.min(8, Math.max(1, Number(config.maxAttempts || 1)));
    let completed = false;
    let latestError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await input.observer?.nodeStarted?.(node, inputs, attempt);
      try {
        const output = validatedNodeOutput(node, await handler({
          node,
          config,
          inputs,
          attempt,
          context: executionContext,
          outputsByNode: outputs,
          inputConnections: inputState.connectionsByPort,
        }));
        assertExecutionWithinPolicy(executionContext);
        outputs.set(node.id, output);
        const outputWarnings = Array.isArray(output.__warnings) ? output.__warnings.map(String) : [];
        const assetFailures = output.assets && typeof output.assets === "object" && Array.isArray((output.assets as { failures?: unknown }).failures)
          ? ((output.assets as { failures: unknown[] }).failures).map((failure) => typeof failure === "object" && failure && "error" in failure ? String((failure as { error: unknown }).error) : String(failure))
          : [];
        warnings.push(...[...outputWarnings, ...assetFailures].map((message) => ({ nodeId: node.id, message })));
        await input.observer?.nodeCompleted?.(node, output, attempt);
        completed = true;
        break;
      } catch (error) {
        const failure = executionContext.signal?.aborted ? executionAbortError(executionContext) : error;
        latestError = failure;
        await input.observer?.nodeFailed?.(node, failure, attempt);
        if (executionContext.signal?.aborted) throw failure;
        if ((failure as { automationRetryable?: unknown })?.automationRetryable === false) break;
        if (attempt < maxAttempts) await abortableDelay(Math.min(8_000, 800 * 2 ** (attempt - 1)), executionContext.signal);
      }
    }
    if (!completed) {
      const failureMode = String(config.failureMode || "stop");
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
      outputs.set(node.id, output);
      if (failureMode === "continue-empty") {
        warnings.push({ nodeId: node.id, message: latestError instanceof Error ? latestError.message : String(latestError) });
      }
      await input.observer?.nodeContinued?.(node, output, maxAttempts, failureMode);
    }
  }
  const terminalNodeIds = input.graph.nodes
    .filter((node) => !node.disabled && automationNodeDefinition(node.type, node.version)?.terminal)
    .map((node) => node.id);
  const completedTerminalNodeIds = terminalNodeIds.filter((nodeId) => outputs.has(nodeId));
  if (!completedTerminalNodeIds.length) {
    throw Object.assign(new Error("Workflow finished without producing any final output. Check condition and error branches."), { code: "NO_TERMINAL_OUTPUT" });
  }
  return { outputs, skipped, terminalNodeIds, completedTerminalNodeIds, warnings, nodeExecutions };
}
