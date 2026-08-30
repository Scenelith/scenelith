import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { automationNodeDefinitions } from "../src/lib/automation-workflows/registry";
import { DEFAULT_AUTOMATION_WORKFLOW_SETTINGS, type AutomationWorkflowGraph } from "../src/lib/automation-workflows/types";
import { createScenelithMcpServer } from "../src/lib/mcp/server";
import {
  getAutomationCapabilities,
  inspectAutomationConnection,
  inspectAutomationWorkflowGraph,
} from "../src/lib/mcp/automation";

test("MCP Automation catalog stays in exact parity with every latest canonical node", () => {
  const definitions = automationNodeDefinitions();
  const catalog = getAutomationCapabilities({ includeHelp: true });
  assert.equal(catalog.node_count, definitions.length);
  assert.equal(catalog.latest_registry_node_count, definitions.length);
  assert.equal(definitions.length, 25);

  for (const definition of definitions) {
    const capability = catalog.nodes.find((node) => node.type === definition.type);
    assert.ok(capability, `missing ${definition.type}@${definition.version}`);
    assert.equal(capability.version, definition.version);
    assert.deepEqual(capability.inputs.map((port) => port.id), definition.inputs.map((port) => port.id));
    assert.deepEqual(capability.outputs, definition.outputs);
    assert.deepEqual(capability.fields.map((field) => field.id), definition.fields.map((field) => field.id));
    assert.deepEqual(capability.help, definition.help);
    assert.equal(capability.node_template.type, definition.type);
    assert.equal(capability.node_template.version, definition.version);
    for (const field of definition.fields.filter((item) => item.defaultValue !== undefined)) {
      assert.deepEqual(capability.default_config[field.id], field.defaultValue, `${definition.type}.${field.id}`);
    }
  }
});

test("full Automation OAuth grant exposes the complete guarded MCP lifecycle surface", async () => {
  const server = createScenelithMcpServer({
    connectionId: "catalog-audit",
    clientId: "catalog-audit",
    userId: "catalog-audit",
    workspaceId: "catalog-audit",
    projectIds: null,
    libraryAccess: false,
    scopes: ["mcp:read", "automation:write", "automation:run", "automation:credentials"],
    resource: "http://localhost/api/mcp",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, "http://localhost");
  const client = new Client({ name: "catalog-audit", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const actual = (await client.listTools()).tools.map((tool) => tool.name)
    .filter((name) => name.includes("automation") || name.includes("workflow") || name.includes("trigger") || name.includes("fixture") || name.includes("credential") || name.includes("deployment"))
    .sort();
  const expected = [
    "add_automation_node", "archive_automation_workflow", "bind_automation_credential", "bind_automation_subworkflow",
    "cancel_automation_run", "configure_automation_node", "configure_automation_workflow", "connect_automation_nodes",
    "create_automation_fixture", "create_automation_trigger", "create_automation_workflow", "delete_automation_fixture",
    "delete_automation_trigger", "diagnose_automation_run", "export_automation_workflow", "get_automation_capabilities",
    "get_automation_run", "get_automation_workflow", "import_automation_workflow", "list_automation_credentials",
    "list_automation_deployment_bindings", "list_automation_fixtures", "list_automation_runs", "list_automation_trigger_deliveries",
    "list_automation_triggers", "list_automation_versions", "list_automation_workflows", "preview_automation_node",
    "publish_automation_workflow", "remove_automation_connection", "remove_automation_node", "replay_automation_trigger_delivery",
    "restore_automation_version", "retry_automation_run_from_node", "run_automation_workflow", "save_automation_workflow",
    "set_automation_run_input", "set_automation_trigger_status", "set_system_automation_model", "unbind_automation_deployment_slot",
    "validate_automation_connection", "validate_automation_workflow",
  ].sort();
  assert.deepEqual(actual, expected);
  await client.close();
  await server.close();
});

test("MCP Automation catalog exposes exact prompt roots, historical versions, and dynamic Merge ports", () => {
  const ai = getAutomationCapabilities({ nodeType: "ai.structured-task", version: 2 }).nodes[0];
  const userPrompt = ai.fields.find((field) => field.id === "userPrompt");
  const systemPrompt = ai.fields.find((field) => field.id === "systemPrompt");
  assert.deepEqual(userPrompt?.allowed_variable_roots, ["primary", "context", "identity", "connected", "run", "trigger"]);
  assert.deepEqual(systemPrompt?.allowed_variable_roots, []);
  assert.equal(systemPrompt?.variables_forbidden, true);
  assert.equal(userPrompt?.run_input_sidebar.supported, false);

  const workflowData = getAutomationCapabilities({ nodeType: "input.workflow-data" }).nodes[0];
  const valueField = workflowData.fields.find((field) => field.id === "value");
  assert.deepEqual(valueField?.run_input_sidebar.modes, ["fixed", "optional", "required"]);
  assert.equal(valueField?.run_input_sidebar.key, "replace-with-stable-node-id.value");

  const conditionV2 = getAutomationCapabilities({ nodeType: "logic.condition", version: 2 }).nodes[0];
  assert.equal(conditionV2.version, 2);
  assert.equal(conditionV2.fields.find((field) => field.id === "path")?.value_path_syntax, "dot.path.without.brackets");

  const merge = getAutomationCapabilities({ nodeType: "logic.merge" }).nodes[0];
  assert.match(String(merge.dynamic_ports), /2-24 stable input sockets/);
  assert.deepEqual(merge.inputs.map((port) => port.id), ["input-1", "input-2"]);
});

function simpleGraph(): AutomationWorkflowGraph {
  return {
    schemaVersion: 1,
    nodes: [
      {
        id: "start", type: "core.manual-trigger", version: 1, name: "Start workflow", description: "",
        position: { x: 0, y: 0 }, groupId: null, config: {}, bindings: {}, disabled: false,
      },
      {
        id: "input", type: "input.workflow-data", version: 1, name: "Workflow data", description: "",
        position: { x: 280, y: 0 }, groupId: null, config: { value: {}, payloadPath: "" },
        bindings: { value: { mode: "ask-on-run", label: "Manual value", required: false } }, disabled: false,
      },
      {
        id: "finish", type: "output.finish", version: 1, name: "Finish", description: "",
        position: { x: 560, y: 0 }, groupId: null, config: { outcome: "completed", message: "Received {{ data }}" }, bindings: {}, disabled: false,
      },
    ],
    edges: [
      { id: "start-input", source: "start", sourcePort: "run", target: "input", targetPort: "run", role: "flow" },
      { id: "input-finish", source: "input", sourcePort: "data", target: "finish", targetPort: "data", role: "flow" },
    ],
    groups: [], annotations: [], settings: DEFAULT_AUTOMATION_WORKFLOW_SETTINGS,
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

test("MCP Automation validation returns graph order, exact run keys, and connection diagnostics", () => {
  const graph = simpleGraph();
  const inspection = inspectAutomationWorkflowGraph(graph);
  assert.equal(inspection.validation.valid, true, JSON.stringify(inspection.validation.issues));
  assert.deepEqual(inspection.graph_contract?.ordered_node_ids, ["start", "input", "finish"]);
  assert.deepEqual(inspection.graph_contract?.run_inputs.map((field) => field.key), ["input.value"]);

  const validConnection = inspectAutomationConnection({ ...graph, edges: graph.edges.slice(0, 1) }, {
    source: "input", sourcePort: "data", target: "finish", targetPort: "data", role: "flow",
  });
  assert.equal(validConnection.valid, true, JSON.stringify(validConnection.issues));

  const invalidConnection = inspectAutomationConnection(graph, {
    source: "finish", sourcePort: "result", target: "input", targetPort: "run", role: "flow",
  });
  assert.equal(invalidConnection.valid, false);
  assert.ok(invalidConnection.issues.some((issue) => issue.code === "TERMINAL_CONTINUES"));
  assert.ok(invalidConnection.issues.some((issue) => issue.code === "INTERNAL_OUTPUT_CONNECTED"));
});

test("MCP Automation validation preserves actionable parser and prompt errors", () => {
  const malformed = inspectAutomationWorkflowGraph({ schemaVersion: 1, nodes: "wrong" });
  assert.equal(malformed.validation.valid, false);
  assert.equal(malformed.graph_contract, null);
  assert.ok(malformed.validation.issues.every((issue) => issue.code === "INVALID_GRAPH"));

  const graph = simpleGraph();
  graph.nodes[2].config.message = "{{ unknown.value }}";
  const invalid = inspectAutomationWorkflowGraph(graph);
  assert.equal(invalid.validation.valid, false);
  assert.ok(invalid.validation.issues.some((issue) => issue.code === "INVALID_TEMPLATE" && issue.nodeId === "finish"));
});
