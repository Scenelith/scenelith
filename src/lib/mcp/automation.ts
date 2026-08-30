import {
  automationNodeDefinition,
  automationNodeCategoryDefinitions,
  automationNodeDefinitions,
  automationNodeInputPorts,
} from "@/lib/automation-workflows/registry";
import {
  DEFAULT_AUTOMATION_WORKFLOW_SETTINGS,
  automationEdgeRoles,
  automationPortTypes,
  automationWorkflowGraphSchema,
  type AutomationBinding,
  type AutomationNode,
  type AutomationNodeDefinition,
  type AutomationWorkflowGraph,
} from "@/lib/automation-workflows/types";
import {
  automationRunInputFields,
  topologicalAutomationNodeIds,
  validateAutomationConnection,
  validateAutomationWorkflowGraph,
} from "@/lib/automation-workflows/validation";

type AutomationCatalogOptions = {
  category?: AutomationNodeDefinition["category"];
  nodeType?: string;
  version?: number;
  includeHelp?: boolean;
};

const templateVariables: Record<string, Record<string, readonly string[]>> = {
  "ai.structured-task": {
    userPrompt: ["primary", "context", "identity", "connected", "run", "trigger"],
    systemPrompt: [],
  },
  "ai.interpret-creative-direction": {
    taskInstructions: ["primary", "connected", "run", "trigger"],
    systemInstructions: [],
  },
  "logic.transform": {
    template: ["data", "inputs", "byNode", "byNodePort", "sources", "run", "trigger"],
  },
  "integration.http-request": {
    url: ["data", "run", "trigger"],
    headers: ["data", "run", "trigger"],
    body: ["data", "run", "trigger"],
  },
  "output.finish": {
    message: ["data", "run", "trigger"],
  },
};

const valuePathFields: Record<string, readonly string[]> = {
  "input.workflow-data": ["payloadPath"],
  "logic.select-path": ["path"],
  "logic.retry-gate": ["feedbackPath"],
  "logic.condition": ["path"],
  "logic.prepare-creative-direction": ["briefPath", "policyPath", "resultPath"],
};

function latestDefinition(type: string) {
  return automationNodeDefinitions().find((definition) => definition.type === type);
}

function definitionFor(options: Pick<AutomationCatalogOptions, "nodeType" | "version">) {
  if (!options.nodeType) return undefined;
  return options.version === undefined
    ? latestDefinition(options.nodeType)
    : automationNodeDefinition(options.nodeType, options.version);
}

function defaultConfig(definition: AutomationNodeDefinition) {
  return Object.fromEntries(definition.fields
    .filter((field) => field.defaultValue !== undefined)
    .map((field) => [field.id, structuredClone(field.defaultValue)]));
}

function defaultBindings(definition: AutomationNodeDefinition) {
  return Object.fromEntries(definition.fields
    .filter((field) => field.runtimeBindable && field.defaultRunInput)
    .map((field) => [field.id, {
      mode: "ask-on-run" as const,
      label: field.label,
      required: Boolean(field.required),
    }]));
}

export function createAutomationNodeTemplate(input: {
  type: string;
  version?: number;
  id: string;
  name?: string;
  description?: string;
  position: { x: number; y: number };
  groupId?: string | null;
  config?: Record<string, unknown>;
  bindings?: Record<string, AutomationBinding>;
  disabled?: boolean;
}): AutomationNode {
  const definition = input.version === undefined
    ? latestDefinition(input.type)
    : automationNodeDefinition(input.type, input.version);
  if (!definition) {
    throw Object.assign(new Error(`Automation node ${input.type}${input.version ? `@${input.version}` : ""} is unavailable`), {
      code: "AUTOMATION_NODE_NOT_FOUND",
      status: 404,
    });
  }
  return {
    id: input.id,
    type: definition.type,
    version: definition.version,
    name: input.name?.trim() || definition.title,
    description: input.description?.trim() || "",
    position: input.position,
    groupId: input.groupId ?? null,
    config: { ...defaultConfig(definition), ...structuredClone(input.config || {}) },
    bindings: { ...defaultBindings(definition), ...structuredClone(input.bindings || {}) },
    disabled: input.disabled ?? false,
  };
}

function nodeCapability(definition: AutomationNodeDefinition, includeHelp: boolean) {
  const config = defaultConfig(definition);
  const node = createAutomationNodeTemplate({
    id: "replace-with-stable-node-id",
    type: definition.type,
    version: definition.version,
    position: { x: 0, y: 0 },
  });
  const variableFields = templateVariables[definition.type] || {};
  const pathFields = new Set(valuePathFields[definition.type] || []);
  return {
    type: definition.type,
    version: definition.version,
    title: definition.title,
    description: definition.description,
    example: definition.example,
    category: definition.category,
    terminal: Boolean(definition.terminal),
    retry_safe: Boolean(definition.retrySafe),
    inputs: automationNodeInputPorts(node),
    outputs: definition.outputs,
    fields: definition.fields.map((field) => ({
      ...field,
      run_input_sidebar: field.runtimeBindable ? {
        supported: true,
        modes: [
          "fixed",
          ...(!field.required && !field.requiredWhenVisible ? ["optional"] : []),
          "required",
        ],
        key: `replace-with-stable-node-id.${field.id}`,
        appears_in_run_inputs_when: "mode is optional or required",
        default_enabled: Boolean(field.defaultRunInput),
      } : { supported: false },
      ...(Object.prototype.hasOwnProperty.call(variableFields, field.id)
        ? {
          template_syntax: "{{ root.path }}",
          allowed_variable_roots: variableFields[field.id],
          variables_forbidden: variableFields[field.id].length === 0,
        }
        : {}),
      ...(pathFields.has(field.id)
        ? { value_path_syntax: "dot.path.without.brackets" }
        : {}),
    })),
    dynamic_ports: definition.type === "logic.merge"
      ? "The config.inputs array defines 2-24 stable input sockets. Each item needs a lowercase-hyphen id and a unique readable name."
      : null,
    default_config: config,
    default_bindings: node.bindings,
    node_template: node,
    ...(includeHelp ? { help: definition.help } : {}),
  };
}

export const SCENELITH_AUTOMATION_GUIDE = `# Scenelith Automation agent guide

## Read before editing

Call \`get_automation_capabilities\` before choosing a node, setting, port, edge role, prompt variable, or run binding. Pass \`canvas_id\` when configuring model fields so the response also contains the live Assistant/Image model catalogue and dependent ratio/resolution options used by that canvas. The response is generated from the same versioned registry used by the editor, validator, and worker. Call \`validate_automation_connection\` before adding an edge and \`validate_automation_workflow\` before every save or publish.

## Workflow lifecycle

1. Read or create a workflow and keep its current \`draft.id\`.
2. Build nodes from the exact \`node_template\` returned for their type and version.
3. Configure fixed values in \`config\`. Use \`set_automation_run_input\` for a runtime-bindable field: \`optional\` or \`required\` makes it appear immediately in the left RUN INPUTS sidebar with key \`node-id.field-id\`; \`fixed\` removes it from that sidebar and keeps the current value in the step.
4. Connect exact output and input port IDs. Use \`flow\` for the readable execution route, \`data\` for supporting information, \`error\` only from an error output, and \`retry\` only into Retry gate feedback.
5. Validate, save with \`base_draft_version_id\`, validate the saved draft again, then publish.
6. Read the published run-input contract, run with explicit inputs, and poll the immutable run until it reaches a terminal state. For automatic starts, inspect \`list_automation_trigger_deliveries\`; diagnose a failed run or delivery before using \`replay_automation_trigger_delivery\`, which accepts dead-letter deliveries only.

## Variables and prompts

Use only the roots reported on the exact field. Variable syntax is \`{{ root.path }}\`. Permanent/system instructions deliberately accept no variables. Value-path settings use plain dot paths, not templates or bracket syntax. Connected values are already supplied to nodes; prompts should state the task and use a variable only when the exact placement matters.

## Safety and errors

Credentials never belong in workflow config, prompts, URLs, headers, or exported graphs. HTTP credentials and child workflows use operator-managed deployment slots. A draft may be saved while incomplete, but publishing and running require a valid graph and valid deployment bindings. Never suppress a validation code: fix the exact node or edge identified, validate again, then continue. Production runs use published immutable versions; test runs may use the current draft. A dead-letter replay keeps the original immutable version, payload, runtime inputs, deployment snapshot, and admission policy; it never silently upgrades to the latest draft.
`;

export function getAutomationCapabilities(options: AutomationCatalogOptions = {}) {
  if (options.version !== undefined && !options.nodeType) {
    throw Object.assign(new Error("node_type is required when version is provided"), { code: "NODE_TYPE_REQUIRED", status: 400 });
  }
  const exact = definitionFor(options);
  if (options.nodeType && !exact) {
    throw Object.assign(new Error(`Automation node ${options.nodeType}${options.version ? `@${options.version}` : ""} is unavailable`), {
      code: "AUTOMATION_NODE_NOT_FOUND",
      status: 404,
    });
  }
  const definitions = exact
    ? [exact]
    : automationNodeDefinitions().filter((definition) => !options.category || definition.category === options.category);
  return {
    schema_version: 1,
    node_count: definitions.length,
    latest_registry_node_count: automationNodeDefinitions().length,
    categories: automationNodeCategoryDefinitions,
    port_types: automationPortTypes,
    edge_roles: {
      values: automationEdgeRoles,
      flow: "Main readable execution route.",
      data: "Supporting value consumed by a later step; it does not replace a main route.",
      error: "Recovery route originating from an error output.",
      retry: "Bounded backward route into logic.retry-gate feedback only.",
    },
    workflow_settings: {
      defaults: DEFAULT_AUTOMATION_WORKFLOW_SETTINGS,
      limits: {
        timeoutSeconds: { min: 60, max: 86_400 },
        maxNodeExecutions: { min: 1, max: 100_000 },
        maxGeneratedAssets: { min: 1, max: 5_000 },
        maxCredits: { min: 0, max: 1_000_000_000, nullable: true },
        maxParallelism: { min: 1, max: 32 },
        maxSubworkflowDepth: { min: 1, max: 16 },
        overlapPolicy: ["queue", "skip", "cancel-previous"],
        maxConcurrentRuns: { min: 1, max: 32 },
      },
    },
    automatic_triggers: {
      lifecycle: "Create paused, verify inputs and deployment bindings, then activate. Activation pins the current published immutable version.",
      schedule: {
        interval: { mode: "interval", everyMinutes: "integer 1-525600", misfirePolicy: ["skip", "catch-up-once"] },
        calendar: { mode: "calendar", cron: "five fields: minute hour day month weekday", timezone: "IANA timezone", misfirePolicy: ["skip", "catch-up-once"] },
      },
      webhook: { config: {}, payload: "JSON object up to 1 MB", idempotency: "Optional Idempotency-Key header", secret_url: "Returned once when the trigger is created." },
      canvas_event: {
        events: [
          { name: "tiktok.imported", version: 1, payload: { sourceUrl: "URL", assetIds: "1-500 asset IDs", title: "optional text" } },
          { name: "generation.completed", version: 1, payload: { generationId: "ID", nodeId: "ID", assetId: "ID", mediaType: ["image", "video"], operation: ["generation", "edit"] } },
        ],
      },
    },
    binding_contract: {
      fixed: "Use config or a fixed binding value.",
      ask_on_run: "Allowed only when the field is runtimeBindable. The run input key is node-id.field-id.",
      sidebar: "Use set_automation_run_input. Optional and required modes appear in the left RUN INPUTS panel; fixed mode removes the field from that panel.",
    },
    nodes: definitions.map((definition) => nodeCapability(definition, options.includeHelp !== false)),
  };
}

export function inspectAutomationWorkflowGraph(value: unknown) {
  const validation = validateAutomationWorkflowGraph(value);
  const parsed = automationWorkflowGraphSchema.safeParse(value);
  if (!parsed.success) return { validation, graph_contract: null };
  return {
    validation,
    graph_contract: {
      ordered_node_ids: topologicalAutomationNodeIds(parsed.data),
      run_inputs: automationRunInputFields(parsed.data),
      node_count: parsed.data.nodes.length,
      edge_count: parsed.data.edges.length,
      disabled_node_ids: parsed.data.nodes.filter((node) => node.disabled).map((node) => node.id),
    },
  };
}

export function inspectAutomationConnection(value: unknown, connection: {
  id?: string;
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
  role: "flow" | "data" | "error" | "retry";
}) {
  const parsed = automationWorkflowGraphSchema.safeParse(value);
  if (!parsed.success) {
    return {
      valid: false,
      issues: validateAutomationWorkflowGraph(value).issues,
      connection: null,
    };
  }
  const result = validateAutomationConnection(parsed.data as AutomationWorkflowGraph, connection);
  return { ...result, connection };
}

function automationErrorGuidance(code: string) {
  if (/^(?:INVALID_GRAPH|UNKNOWN_NODE|DUPLICATE_NODE|MISSING_REQUIRED_SETTING|INVALID_SETTING|SETTING_|IMMUTABLE_NODE|EMPTY_RESPONSE_SCHEMA|INVALID_RESPONSE_SCHEMA|VARIABLE_IN_PERMANENT_INSTRUCTIONS|SECRET_IN_WORKFLOW|NODE_CONFIGURATION_INVARIANT|WORKFLOW_INVALID)/.test(code)) {
    return { area: "node-configuration", retry_without_change: false, next: "Read the exact node type and version with get_automation_capabilities, repair its settings or bindings, then validate the complete draft." };
  }
  if (/(?:PORT|CONNECTION|ROUTE|CYCLE|INPUTS|OUTPUT|TERMINAL|DEAD_END|UNREACHABLE|TRIGGER_COUNT|GROUP|MERGE)/.test(code)) {
    return { area: "graph-topology", retry_without_change: false, next: "Read the exact ports, validate the proposed connection, repair the visible route, then validate the complete graph." };
  }
  if (/(?:RUN_INPUT|INPUT_SNAPSHOT|PREVIEW_INPUT|TEMPLATE_VALUE|VALUE_PATH)/.test(code)) {
    return { area: "run-input", retry_without_change: false, next: "Re-read get_automation_workflow for the exact run-input keys and captured snapshot, correct the typed value or value path, then start a new run." };
  }
  if (/(?:CREDENTIAL|SUBWORKFLOW|DEPLOYMENT)/.test(code)) {
    return { area: "deployment-binding", retry_without_change: false, next: "Ask an authorized operator to bind the named credential or published child-workflow slot. Never place secret material in the workflow graph." };
  }
  if (/^(?:HTTP_|UNSAFE_HTTP_URL)/.test(code)) {
    return { area: "http-integration", retry_without_change: ["HTTP_TIMEOUT", "HTTP_STATUS"].includes(code), next: "Inspect the failed node input and response. Fix URL, headers, body, idempotency, response limits, or service availability before retrying." };
  }
  if (/^(?:AI_|MODEL_SELECTION_RETIRED)/.test(code)) {
    return { area: "ai-provider", retry_without_change: code !== "MODEL_SELECTION_RETIRED", next: "Inspect the node's captured media and prompt. Reduce context or media when over limits; replace a retired model through the node's exact model setting." };
  }
  if (/(?:LIMIT|BUDGET|TIMEOUT|DEPTH)/.test(code)) {
    return { area: "workflow-policy", retry_without_change: false, next: "Reduce the workload or deliberately change the workflow execution limit, budget, parallelism, or nesting policy before starting another run." };
  }
  if (/(?:CONTRACT|INVARIANT|HANDLER|NO_TERMINAL_OUTPUT)/.test(code)) {
    return { area: "runtime-contract", retry_without_change: false, next: "Do not blind-retry. Inspect nodeRunDetails and the immutable workflow version; repair the workflow or platform handler contract, then validate and publish a new version." };
  }
  if (code === "RUN_CANCELLED" || code === "RUN_LEASE_LOST") {
    return { area: "run-lifecycle", retry_without_change: false, next: "Confirm whether the user cancelled the run or worker ownership changed. Start a new run only when the intended inputs and version are still correct." };
  }
  return { area: "node-runtime", retry_without_change: false, next: "Inspect the exact failed node input, output, events, and immutable workflow version. Correct the cause before starting a new run." };
}

export function diagnoseAutomationRun(run: Record<string, unknown>) {
  const details = Array.isArray(run.nodeRunDetails) ? run.nodeRunDetails as Array<Record<string, unknown>> : [];
  const failures = details.filter((detail) => detail.status === "failed" || detail.error || detail.errorCode).map((detail) => ({
    node_id: detail.nodeId,
    node_type: detail.nodeType,
    attempt: detail.attempt,
    error: detail.error,
    code: detail.errorCode || "NODE_FAILED",
    guidance: automationErrorGuidance(String(detail.errorCode || "NODE_FAILED")),
  }));
  const runCode = typeof run.code === "string" && run.code ? run.code : null;
  const uniqueCodes = [...new Set([...(runCode ? [runCode] : []), ...failures.map((failure) => String(failure.code))])];
  const status = String(run.status || "unknown");
  return {
    run_id: run.id,
    status,
    terminal: ["completed", "completed_with_warnings", "failed", "cancelled"].includes(status),
    immutable_workflow_version_id: run.workflowVersionId,
    run_error: run.error || null,
    run_code: runCode,
    failures,
    guidance: uniqueCodes.map((code) => ({ code, ...automationErrorGuidance(code) })),
    captured_runtime_inputs: run.runtimeInputs || {},
    captured_input_snapshot: run.inputSnapshot || {},
    output: run.output || null,
    events: run.events || [],
    next: failures.length || runCode
      ? "Repair the identified cause in a new draft, validate, publish a new immutable version, and only then start a new run. Existing run history is never rewritten."
      : status === "completed" || status === "completed_with_warnings"
        ? "The run is complete. Use its output and nodeRunDetails as evidence."
        : "Continue polling get_automation_run. Cancel only when the user requests it or the work is no longer needed.",
  };
}
