import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assistantModels } from "../src/lib/assistant-models";
import { createDefaultTikTokWorkflowGraph } from "../src/lib/automation-workflows/default-tiktok";
import { buildAutomationCanvasPlanNotes, coreAutomationNodeHandlers, isUnsafeAutomationHttpAddress } from "../src/lib/automation-workflows/node-handlers";
import { automationNodeDefinition, automationNodeDefinitions } from "../src/lib/automation-workflows/registry";
import { automationRunInputFields, topologicalAutomationNodeIds, validateAutomationConnection, validateAutomationRunInputs, validateAutomationWorkflowGraph } from "../src/lib/automation-workflows/validation";

const nodeContractAudit = readFileSync(new URL("../docs/AUTOMATION_NODE_CONTRACT_AUDIT.md", import.meta.url), "utf8");
const machineNodeContractAudit = JSON.parse(readFileSync(new URL("../docs/automation-node-contract-audit.json", import.meta.url), "utf8")) as {
  schemaVersion: number;
  nodes: Record<string, { inputs: string[]; outputs: string[]; settings: Record<string, string> }>;
};

test("default TikTok workflow exposes every AI request and validates", () => {
  const graph = createDefaultTikTokWorkflowGraph();
  const result = validateAutomationWorkflowGraph(graph);
  assert.deepEqual(result.issues, []);
  assert.equal(result.valid, true);
  assert.equal(graph.nodes.filter((node) => node.type === "ai.structured-task").length, 13);
  assert.equal(graph.nodes.filter((node) => node.type === "ai.interpret-creative-direction").length, 1);
  for (const aiNode of graph.nodes.filter((node) => node.type === "ai.structured-task")) {
    assert.equal(aiNode.version, 2);
    assert.equal(aiNode.config.outputMode, "structured");
    assert.equal(aiNode.config.creativity, "consistent");
    assert.equal(typeof aiNode.config.systemPrompt, "string");
    assert.equal(typeof aiNode.config.userPrompt, "string");
    assert.ok(String(aiNode.config.userPrompt).length > 20);
  }
  const merge = graph.nodes.find((node) => node.id === "assemble-contract");
  assert.equal(merge?.type, "logic.merge");
  assert.equal(merge?.config.mode, "named-object");
  assert.deepEqual(merge?.config.inputs, [
    { id: "input-source-analysis", name: "sourceAnalysis" },
    { id: "input-choices", name: "choices" },
    { id: "input-copy", name: "copy" },
    { id: "input-brief", name: "brief" },
    { id: "input-references", name: "references" },
  ]);
  assert.deepEqual(graph.edges.filter((edge) => edge.target === "assemble-contract").map((edge) => edge.targetPort).sort(), ["input-brief", "input-choices", "input-copy", "input-references", "input-source-analysis"]);
  assert.ok(graph.edges.filter((edge) => edge.role === "data").length >= 8);
  assert.ok(graph.edges.some((edge) => edge.role === "flow"));

  assert.equal(graph.nodes.some((node) => node.id === "visual-references"), false, "the base template must not expose an unused optional input");
  assert.ok(automationNodeDefinitions().some((definition) => definition.type === "input.visual-references"), "custom workflows must still be able to add a visual-reference input");
});

test("the product exposes one current AI contract", () => {
  const aiDefinitions = automationNodeDefinitions().filter((definition) => definition.type === "ai.structured-task");
  assert.deepEqual(aiDefinitions.map((definition) => definition.version), [2]);
  const handlers = coreAutomationNodeHandlers();
  assert.equal(typeof handlers["ai.structured-task@2"], "function");
});

test("current node catalogue exposes latest semantics while historical handlers remain executable", () => {
  const definitions = automationNodeDefinitions();
  assert.equal(definitions.find((definition) => definition.type === "input.tiktok-source")?.version, 2);
  assert.equal(definitions.find((definition) => definition.type === "input.identity")?.version, 2);
  assert.equal(definitions.find((definition) => definition.type === "logic.condition")?.version, 3);
  assert.equal(definitions.find((definition) => definition.type === "generation.image")?.version, 2);
  assert.equal(definitions.find((definition) => definition.type === "logic.validate-slide-plans")?.version, 2);
  assert.equal(definitions.find((definition) => definition.type === "logic.prepare-creative-direction")?.version, 3);
  assert.equal(definitions.find((definition) => definition.type === "ai.interpret-creative-direction")?.version, 3);
  assert.equal(definitions.find((definition) => definition.type === "logic.resolve-creative-direction")?.version, 4);
  assert.equal(definitions.find((definition) => definition.type === "output.add-to-canvas")?.version, 3);
  const handlers = coreAutomationNodeHandlers();
  assert.equal(typeof handlers["input.tiktok-source@1"], "function");
  assert.equal(typeof handlers["input.tiktok-source@2"], "function");
  assert.equal(typeof handlers["input.identity@1"], "function");
  assert.equal(typeof handlers["input.identity@2"], "function");
  assert.equal(typeof handlers["logic.condition@1"], "function");
  assert.equal(typeof handlers["logic.condition@2"], "function");
  assert.equal(typeof handlers["logic.condition@3"], "function");
  assert.equal(typeof handlers["generation.image@1"], "function");
  assert.equal(typeof handlers["generation.image@2"], "function");
  assert.equal(typeof handlers["logic.validate-slide-plans@1"], "function");
  assert.equal(typeof handlers["logic.validate-slide-plans@2"], "function");
  assert.equal(typeof handlers["logic.prepare-creative-direction@1"], "function");
  assert.equal(typeof handlers["logic.prepare-creative-direction@2"], "function");
  assert.equal(typeof handlers["logic.prepare-creative-direction@3"], "function");
  assert.equal(typeof handlers["ai.interpret-creative-direction@1"], "function");
  assert.equal(typeof handlers["ai.interpret-creative-direction@2"], "function");
  assert.equal(typeof handlers["ai.interpret-creative-direction@3"], "function");
  assert.equal(typeof handlers["logic.resolve-creative-direction@2"], "function");
  assert.equal(typeof handlers["logic.resolve-creative-direction@3"], "function");
  assert.equal(typeof handlers["logic.resolve-creative-direction@4"], "function");
  assert.equal(typeof handlers["output.add-to-canvas@1"], "function");
  assert.equal(typeof handlers["output.add-to-canvas@2"], "function");
  assert.equal(typeof handlers["output.add-to-canvas@3"], "function");
  assert.deepEqual(automationNodeDefinition("generation.image", 1)?.inputs.map((port) => port.id), ["plans", "source", "identity", "references"]);
  assert.deepEqual(automationNodeDefinition("generation.image", 2)?.inputs.map((port) => port.id), ["requests"]);
  assert.equal(automationNodeDefinition("logic.prepare-creative-direction", 2)?.inputs.find((port) => port.id === "settings")?.type, "creative-settings");
  assert.equal(automationNodeDefinition("logic.prepare-creative-direction", 3)?.inputs.find((port) => port.id === "settings")?.type, "data", "current custom controls must accept user-authored settings objects instead of only the built-in TikTok choice shape");
  const graph = createDefaultTikTokWorkflowGraph();
  assert.equal(graph.nodes.find((node) => node.id === "tiktok-source")?.version, 2);
  assert.equal(graph.nodes.find((node) => node.id === "identity")?.version, 2);
  assert.ok(graph.nodes.filter((node) => node.type === "logic.condition").every((node) => node.version === 3));
  assert.equal(graph.nodes.find((node) => node.id === "generate-images")?.version, 2);
  assert.equal(graph.nodes.find((node) => node.id === "validate-slide-plans")?.version, 2);
  assert.equal(graph.nodes.find((node) => node.id === "prepare-user-direction")?.version, 3);
  assert.equal(graph.nodes.find((node) => node.id === "interpret-user-direction")?.version, 3);
  assert.equal(graph.nodes.find((node) => node.id === "resolve-user-direction")?.version, 4);
  assert.equal(graph.nodes.find((node) => node.id === "add-to-canvas")?.version, 3);
});

test("current canvas output preserves long plans across bounded notes", () => {
  const prompt = `Start ${"x".repeat(58_000)} End`;
  const notes = buildAutomationCanvasPlanNotes([{ prompt, referenceAssetIds: ["ref-1"], presentation: { index: 1, role: "scene", overlayText: "Caption" } }]);
  assert.ok(notes.length >= 3);
  assert.ok(notes.every((note) => note.length <= 30_000));
  assert.equal(notes.map((note) => note.slice(note.indexOf("\n\n") + 2)).join(""), `SLIDE 01 · SCENE\n${prompt}\nOn-screen text: Caption\nAttached references: 1`);
});

test("every AI node exposes the full Canvas Assistant model catalogue", () => {
  const expectedModelIds = assistantModels.map((model) => model.id);
  const aiDefinitions = automationNodeDefinitions().filter((definition) => definition.category === "ai");
  assert.ok(aiDefinitions.length > 0);
  for (const definition of aiDefinitions) {
    const modelField = definition.fields.find((field) => field.id === "modelId");
    assert.equal(modelField?.kind, "model", `${definition.type} must expose its own model selector`);
    assert.equal(modelField?.modelCapability, "assistant");
    assert.deepEqual(modelField?.options?.map((option) => option.value), expectedModelIds);
  }
});

test("the default workflow stores each AI model independently in node settings", () => {
  const graph = createDefaultTikTokWorkflowGraph();
  const aiNodes = graph.nodes.filter((node) => node.type === "ai.structured-task" || node.type === "ai.interpret-creative-direction");
  assert.ok(aiNodes.length > 1);
  for (const aiNode of aiNodes) {
    assert.equal(aiNode.config.modelId, "google/gemini-3.7-flash");
    assert.equal(aiNode.bindings.modelId, undefined, `${aiNode.id} must not shadow its model setting with a fixed binding`);
  }
  aiNodes[0].config.modelId = "qwen/qwen3.8-max";
  aiNodes[1].config.modelId = "anthropic/claude-sonnet-5";
  assert.equal(aiNodes[0].config.modelId, "qwen/qwen3.8-max");
  assert.equal(aiNodes[1].config.modelId, "anthropic/claude-sonnet-5");
  assert.equal(aiNodes[2].config.modelId, "google/gemini-3.7-flash");
  assert.equal(validateAutomationWorkflowGraph(graph).valid, true);
});

test("the AI node validates only the selected output contract and keeps permanent instructions static", () => {
  const help = automationNodeDefinition("ai.structured-task", 2)!.help.technicalNotes!.join(" ");
  assert.match(help, /80,000 characters/);
  assert.match(help, /200,000 characters/);
  assert.match(help, /24 images/);
  assert.match(help, /never truncates an input/);
  const graph = createDefaultTikTokWorkflowGraph();
  const node = graph.nodes.find((entry) => entry.id === "review-series")!;
  node.config.outputMode = "text";
  node.config.responseSchema = null;
  assert.equal(validateAutomationWorkflowGraph(graph).valid, true);

  node.config.outputMode = "structured";
  node.config.responseSchema = { type: "object", additionalProperties: false, properties: {}, required: [] };
  let result = validateAutomationWorkflowGraph(graph);
  assert.ok(result.issues.some((entry) => entry.code === "EMPTY_RESPONSE_SCHEMA"));

  node.config.responseSchema = { type: "object", additionalProperties: false, properties: { passed: { type: "boolean" } }, required: ["passed"] };
  node.config.systemPrompt = "Always follow {{ primary }}";
  result = validateAutomationWorkflowGraph(graph);
  assert.ok(result.issues.some((entry) => entry.code === "VARIABLE_IN_PERMANENT_INSTRUCTIONS"));
});

test("creative-direction interpretation exposes editable prompt and taxonomy settings", () => {
  const graph = createDefaultTikTokWorkflowGraph();
  const node = graph.nodes.find((entry) => entry.id === "interpret-user-direction")!;
  const definition = automationNodeDefinitions().find((entry) => entry.type === "ai.interpret-creative-direction")!;
  const contract = definition.fields.find((field) => field.id === "systemInstructions")!;
  assert.equal(contract.readOnly, undefined);
  assert.match(String(contract.defaultValue), /COMPLETE COVERAGE/);
  node.config.systemInstructions = "Classify the exact configured request and preserve every character range.";
  assert.equal(validateAutomationWorkflowGraph(graph).valid, true);
  const prepare = graph.nodes.find((entry) => entry.id === "prepare-user-direction")!;
  prepare.config.requirementCategories = [{ id: "composition", label: "Composition", meaning: "Framing and composition requirements." }];
  prepare.config.requirementPlacements = [{ id: "apply", label: "Apply", meaning: "Forward this instruction to the next planning step." }];
  assert.equal(validateAutomationWorkflowGraph(graph).valid, true);
});

test("runtime panel fields come from ask-on-run bindings", () => {
  const fields = automationRunInputFields(createDefaultTikTokWorkflowGraph());
  assert.deepEqual(fields.map((field) => field.key), [
    "tiktok-source.source",
    "identity.identity",
    "creative-settings.mode",
    "creative-settings.newOutfit",
    "creative-settings.newLocation",
    "creative-settings.textStrategy",
    "creative-settings.creativeBrief",
    "creative-settings.creativeDirectionPolicy",
  ]);
  const generator = createDefaultTikTokWorkflowGraph().nodes.find((node) => node.id === "generate-images");
  assert.equal(generator?.config.modelId, "nano-banana-2");
  assert.equal(generator?.bindings.modelId, undefined, "the image model belongs to the generator node settings, not the run panel");
});

test("runtime inputs are derived from node contracts rather than built-in node ids", () => {
  const graph = createDefaultTikTokWorkflowGraph();
  const source = graph.nodes.find((node) => node.id === "tiktok-source")!;
  source.id = "source-created-by-user";
  for (const edge of graph.edges) {
    if (edge.source === "tiktok-source") edge.source = source.id;
    if (edge.target === "tiktok-source") edge.target = source.id;
  }
  const fields = automationRunInputFields(graph);
  assert.ok(fields.some((field) => field.key === "source-created-by-user.source" && field.valueType === "tiktok-source"));
  assert.ok(!fields.some((field) => field.key === "tiktok-source.source"));
});

test("new input nodes expose only the fields deliberately chosen for the run panel", () => {
  const defaults = (type: string) => automationNodeDefinitions()
    .find((definition) => definition.type === type)!
    .fields.filter((field) => field.defaultRunInput)
    .map((field) => field.id);

  assert.deepEqual(defaults("input.tiktok-source"), ["source"]);
  assert.deepEqual(defaults("input.identity"), ["identity"]);
  assert.deepEqual(defaults("input.visual-references"), ["references"]);
  assert.deepEqual(defaults("input.workflow-data"), ["value"]);
  assert.deepEqual(defaults("input.creative-settings"), [
    "mode",
    "newOutfit",
    "newLocation",
    "textStrategy",
    "creativeBrief",
    "creativeDirectionPolicy",
  ]);
  assert.deepEqual(defaults("ai.structured-task"), []);
  assert.deepEqual(defaults("generation.image"), []);
});

test("replacement caption is required only while replacement mode is visible", () => {
  const graph = createDefaultTikTokWorkflowGraph();
  const source = graph.nodes.find((node) => node.id === "tiktok-source")!;
  source.bindings.captionMode = { mode: "ask-on-run", required: true };
  source.bindings.caption = { mode: "ask-on-run", required: false };

  const baseValues = Object.fromEntries(automationRunInputFields(graph)
    .filter((field) => field.key !== "tiktok-source.captionMode" && field.key !== "tiktok-source.caption")
    .map((field) => [field.key, field.value ?? (field.required ? "selected" : "")]));
  baseValues["creative-settings.newOutfit"] = true;
  baseValues["creative-settings.newLocation"] = true;

  assert.equal(validateAutomationRunInputs(graph, {
    ...baseValues,
    "tiktok-source.captionMode": "original",
  }).valid, true);

  const missingReplacement = validateAutomationRunInputs(graph, {
    ...baseValues,
    "tiktok-source.captionMode": "replacement",
  });
  assert.equal(missingReplacement.valid, false);
  assert.ok(missingReplacement.issues.some((entry) => entry.code === "MISSING_RUN_INPUT" && entry.nodeId === "tiktok-source"));

  assert.equal(validateAutomationRunInputs(graph, {
    ...baseValues,
    "tiktok-source.captionMode": "replacement",
    "tiktok-source.caption": "A new caption",
  }).valid, true);
});

test("server validates exact published run inputs and rejects hidden extras", () => {
  const graph = createDefaultTikTokWorkflowGraph();
  const values = Object.fromEntries(automationRunInputFields(graph).map((field) => [field.key, field.value ?? (field.required ? "selected" : "")]));
  values["creative-settings.newOutfit"] = true;
  values["creative-settings.newLocation"] = true;
  const valid = validateAutomationRunInputs(graph, values);
  assert.equal(valid.valid, true);
  const invalid = validateAutomationRunInputs(graph, { ...values, "old-hardcoded.setting": "ignored" });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.issues.some((entry) => entry.code === "UNEXPECTED_RUN_INPUT"));
});

test("workflow validation rejects settings and bindings outside the node registry", () => {
  const graph = createDefaultTikTokWorkflowGraph();
  const node = graph.nodes.find((entry) => entry.id === "generate-images")!;
  node.config.legacyConcurrencyHack = 99;
  node.bindings.unknownProviderKey = { mode: "ask-on-run", required: false };
  const result = validateAutomationWorkflowGraph(graph);
  assert.ok(result.issues.some((entry) => entry.code === "UNKNOWN_NODE_SETTING"));
  assert.ok(result.issues.some((entry) => entry.code === "UNKNOWN_NODE_BINDING"));
});

test("HTTP workflows reject embedded secrets and private or reserved destinations", () => {
  const graph = createDefaultTikTokWorkflowGraph();
  const node = graph.nodes.find((entry) => entry.id === "review-series")!;
  node.type = "integration.http-request";
  node.version = 1;
  node.config = { url: "https://api.example.com", headers: { Authorization: "Bearer secret-token-that-must-not-be-stored" }, credentialSlot: "provider", credentialKind: "bearer" };
  const validation = validateAutomationWorkflowGraph(graph);
  assert.ok(validation.issues.some((entry) => entry.code === "SECRET_IN_WORKFLOW" && entry.nodeId === node.id));
  node.config = { url: "https://api.example.com", headers: { "x-api-key": "plain-custom-secret" }, credentialSlot: "", credentialKind: "bearer" };
  assert.ok(validateAutomationWorkflowGraph(graph).issues.some((entry) => entry.code === "SECRET_IN_WORKFLOW" && entry.nodeId === node.id));
  for (const address of ["127.0.0.1", "10.0.0.5", "100.64.1.1", "169.254.169.254", "192.0.2.1", "198.51.100.3", "203.0.113.9", "::1", "fc00::1", "fe80::1", "2001:db8::1", "::ffff:127.0.0.1"]) {
    assert.equal(isUnsafeAutomationHttpAddress(address), true, address);
  }
  assert.equal(isUnsafeAutomationHttpAddress("8.8.8.8"), false);
  assert.equal(isUnsafeAutomationHttpAddress("2606:4700:4700::1111"), false);

  node.config = { url: "https://api.example.com", method: "GET", headers: ["not", "an", "object"], body: {}, credentialSlot: "", credentialKind: "bearer", failureMode: "stop" };
  assert.ok(validateAutomationWorkflowGraph(graph).issues.some((entry) => entry.code === "INVALID_HTTP_HEADERS" && entry.nodeId === node.id));

  node.config = { url: "https://api.example.com", method: "POST", headers: {}, body: { exact: "payload" }, credentialSlot: "", credentialKind: "bearer", maxAttempts: 2, failureMode: "stop" };
  assert.ok(validateAutomationWorkflowGraph(graph).issues.some((entry) => entry.code === "HTTP_RETRY_NOT_IDEMPOTENT" && entry.nodeId === node.id));
  node.config.headers = { "Idempotency-Key": "{{ run.requestId }}" };
  assert.equal(validateAutomationWorkflowGraph(graph).issues.some((entry) => entry.code === "HTTP_RETRY_NOT_IDEMPOTENT" && entry.nodeId === node.id), false);
});

test("subworkflow fixed inputs cannot silently collapse a non-object value", () => {
  const graph = createDefaultTikTokWorkflowGraph();
  const node = graph.nodes.find((entry) => entry.id === "review-series")!;
  node.type = "logic.run-subworkflow";
  node.version = 1;
  node.config = { subworkflowSlot: "review-child", childInputs: ["not", "an", "object"], failureMode: "stop" };
  node.bindings = {};
  const result = validateAutomationWorkflowGraph(graph);
  assert.ok(result.issues.some((entry) => entry.code === "INVALID_SUBWORKFLOW_INPUTS" && entry.nodeId === node.id));
});

test("deployment slot names cannot collide across secret kinds or workflow bindings", () => {
  const graph = createDefaultTikTokWorkflowGraph();
  const first = graph.nodes.find((entry) => entry.id === "review-series")!;
  const second = graph.nodes.find((entry) => entry.id === "repair-slides")!;
  first.type = "integration.http-request";
  first.version = 1;
  first.config = { url: "https://api.example.com/a", method: "GET", headers: {}, body: {}, credentialSlot: "shared-slot", credentialKind: "bearer", failureMode: "stop" };
  first.bindings = {};
  second.type = "integration.http-request";
  second.version = 1;
  second.config = { url: "https://api.example.com/b", method: "GET", headers: {}, body: {}, credentialSlot: "shared-slot", credentialKind: "basic", failureMode: "stop" };
  second.bindings = {};
  let result = validateAutomationWorkflowGraph(graph);
  assert.ok(result.issues.some((entry) => entry.code === "CREDENTIAL_SLOT_KIND_CONFLICT"));

  second.type = "logic.run-subworkflow";
  second.version = 1;
  second.config = { subworkflowSlot: "shared-slot", childInputs: {}, failureMode: "stop" };
  result = validateAutomationWorkflowGraph(graph);
  assert.ok(result.issues.some((entry) => entry.code === "DEPLOYMENT_SLOT_TYPE_CONFLICT"));
});

test("every node exposed in the editor has a server runtime handler", () => {
  const handlers = coreAutomationNodeHandlers();
  assert.deepEqual(automationNodeDefinitions().filter((definition) => !handlers[`${definition.type}@${definition.version}`]).map((definition) => `${definition.type}@${definition.version}`), []);
  assert.deepEqual(Object.keys(handlers).filter((key) => {
    const separator = key.lastIndexOf("@");
    return separator < 1 || !automationNodeDefinition(key.slice(0, separator), Number(key.slice(separator + 1)));
  }), [], "every current or historical handler must have a registered versioned definition");
});

test("the settings-to-runtime audit covers every current node version", () => {
  const definitions = automationNodeDefinitions();
  const missing = definitions.map((definition) => `${definition.type}@${definition.version}`).filter((key) => !nodeContractAudit.includes(`\`${key}\``));
  assert.deepEqual(missing, []);
  assert.equal(machineNodeContractAudit.schemaVersion, 1);
  assert.deepEqual(new Set(Object.keys(machineNodeContractAudit.nodes)), new Set(definitions.map((definition) => `${definition.type}@${definition.version}`)));
  for (const definition of definitions) {
    const key = `${definition.type}@${definition.version}`;
    const audited = machineNodeContractAudit.nodes[key];
    assert.ok(audited, `${key} needs a machine-readable contract audit`);
    assert.deepEqual(audited.inputs, definition.inputs.map((port) => port.id), `${key} input ports changed without an audit update`);
    assert.deepEqual(audited.outputs, definition.outputs.map((port) => port.id), `${key} output ports changed without an audit update`);
    assert.deepEqual(new Set(Object.keys(audited.settings)), new Set(definition.fields.map((field) => field.id)), `${key} settings changed without an audit update`);
    for (const [fieldId, effect] of Object.entries(audited.settings)) {
      assert.ok(effect.trim().length >= 20, `${key}.${fieldId} needs an explicit runtime effect`);
    }
  }
});

test("historical node guides describe their own version instead of current semantics", () => {
  assert.match(automationNodeDefinition("input.tiktok-source", 1)!.help.technicalNotes!.join(" "), /Historical contract/);
  assert.match(automationNodeDefinition("input.identity", 1)!.help.technicalNotes!.join(" "), /empty assets list/);
  assert.match(automationNodeDefinition("input.identity", 2)!.help.technicalNotes!.join(" "), /applies only when no identity is selected/i);
  assert.match(automationNodeDefinition("logic.condition", 1)!.help.technicalNotes!.join(" "), /truthiness/);
  assert.match(automationNodeDefinition("logic.condition", 2)!.help.technicalNotes!.join(" "), /numeric text/);
  assert.match(automationNodeDefinition("logic.prepare-creative-direction", 2)!.help.technicalNotes!.join(" "), /fixed direction field/);
  assert.match(automationNodeDefinition("logic.resolve-creative-direction", 3)!.help.technicalNotes!.join(" "), /fixed creativeBrief and direction fields/);
  assert.match(automationNodeDefinition("generation.image", 1)!.help.technicalNotes!.join(" "), /Historical combined adapter\/generator/);
  assert.match(automationNodeDefinition("output.add-to-canvas", 1)!.help.technicalNotes!.join(" "), /accepts both historical and canonical/);
  assert.match(automationNodeDefinition("output.add-to-canvas", 2)!.help.technicalNotes!.join(" "), /truncates its text/);
  assert.match(automationNodeDefinition("output.add-to-canvas", 3)!.description, /without silent truncation/);
});

test("validation rejects incompatible ports and cycles", () => {
  const graph = createDefaultTikTokWorkflowGraph();
  graph.edges.push({ id: "bad-port", source: "generate-images", sourcePort: "assets", target: "identity", targetPort: "run" });
  graph.edges.push({ id: "cycle", source: "add-to-canvas", sourcePort: "result", target: "analyze-source", targetPort: "context" });
  const result = validateAutomationWorkflowGraph(graph);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((entry) => entry.code === "INCOMPATIBLE_PORTS"));
  assert.ok(result.issues.some((entry) => entry.code === "UNBOUNDED_CYCLE"));
});

test("generic data cannot impersonate stronger domain ports", () => {
  const graph = createDefaultTikTokWorkflowGraph();
  const result = validateAutomationConnection(graph, {
    source: "repair-slides",
    sourcePort: "result",
    target: "prepare-image-requests",
    targetPort: "source",
    role: "flow",
  });
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((entry) => entry.code === "INCOMPATIBLE_PORTS"));
  const unvalidatedPlans = validateAutomationConnection(graph, {
    source: "repair-slides",
    sourcePort: "result",
    target: "prepare-image-requests",
    targetPort: "plans",
    role: "flow",
  });
  assert.ok(unvalidatedPlans.issues.some((entry) => entry.code === "INCOMPATIBLE_PORTS"));
});

test("supporting data cannot replace a visible execution route", () => {
  const graph = createDefaultTikTokWorkflowGraph();
  const route = graph.edges.find((edge) => edge.target === "analyze-source" && edge.role === "flow");
  assert.ok(route);
  route.role = "data";
  const result = validateAutomationWorkflowGraph(graph);
  assert.ok(result.issues.some((entry) => entry.code === "MISSING_FLOW_ROUTE" && entry.nodeId === "analyze-source"));
});

test("connection guard rejects duplicate edges, occupied inputs and cycles before they enter the graph", () => {
  const graph = createDefaultTikTokWorkflowGraph();
  const duplicate = graph.edges.find((edge) => edge.target === "generate-images" && edge.targetPort === "requests")!;
  assert.ok(validateAutomationConnection(graph, { ...duplicate, id: "new-edge" }).issues.some((entry) => entry.code === "DUPLICATE_CONNECTION"));
  assert.ok(validateAutomationConnection(graph, {
    source: "plan-slides", sourcePort: "result", target: "generate-images", targetPort: "requests", role: "flow",
  }).issues.some((entry) => entry.code === "TOO_MANY_INPUTS"));
  assert.ok(validateAutomationConnection(graph, {
    source: "add-to-canvas", sourcePort: "result", target: "analyze-source", targetPort: "context", role: "flow",
  }).issues.some((entry) => entry.code === "UNBOUNDED_CYCLE"));
});

test("merge inputs are separate named sockets instead of one shared multi-input port", () => {
  const graph = createDefaultTikTokWorkflowGraph();
  const merge = graph.nodes.find((node) => node.id === "assemble-contract")!;
  assert.ok(validateAutomationConnection(graph, {
    source: "analyze-source", sourcePort: "result", target: merge.id, targetPort: "input-copy", role: "data",
  }).issues.some((entry) => entry.code === "TOO_MANY_INPUTS"));

  merge.config.inputs = [...(merge.config.inputs as Array<{ id: string; name: string }>), { id: "input-extra", name: "extra" }];
  assert.equal(validateAutomationConnection(graph, {
    source: "analyze-source", sourcePort: "result", target: merge.id, targetPort: "input-extra", role: "data",
  }).valid, true);

  merge.config.inputs = [{ id: "input-a", name: "same" }, { id: "input-b", name: "same" }];
  const invalid = validateAutomationWorkflowGraph(graph);
  assert.ok(invalid.issues.some((entry) => entry.code === "DUPLICATE_MERGE_INPUT" && entry.nodeId === merge.id));

  merge.config.inputs = [{ id: "input-copy", name: "copy" }, { id: "", name: "" }];
  const malformed = validateAutomationWorkflowGraph(graph);
  assert.ok(malformed.issues.some((entry) => entry.code === "INVALID_MERGE_INPUT" && entry.nodeId === merge.id));
});

test("required settings cannot be made optional at run time", () => {
  const graph = createDefaultTikTokWorkflowGraph();
  graph.nodes.find((node) => node.id === "tiktok-source")!.bindings.source.required = false;
  const result = validateAutomationWorkflowGraph(graph);
  assert.ok(result.issues.some((entry) => entry.code === "REQUIRED_BINDING_OPTIONAL"));
  assert.equal(automationRunInputFields(graph).find((field) => field.key === "tiktok-source.source")?.required, true);
});

test("condition nodes require both outcomes to lead somewhere", () => {
  const graph = createDefaultTikTokWorkflowGraph();
  graph.edges = graph.edges.filter((edge) => !(edge.source === "repair-slides" && edge.target === "validate-slide-plans" && edge.targetPort === "data"));
  graph.nodes.push({
    id: "quality-gate", type: "logic.condition", version: 1, name: "Quality gate", description: "", position: { x: 4500, y: 80 }, groupId: null,
    config: { path: "passed", operator: "is-truthy", compareValue: null }, bindings: {}, disabled: false,
  });
  graph.edges.push(
    { id: "repair-to-gate", source: "repair-slides", sourcePort: "result", target: "quality-gate", targetPort: "data" },
    { id: "gate-yes", source: "quality-gate", sourcePort: "yes", target: "validate-slide-plans", targetPort: "data" },
  );
  const result = validateAutomationWorkflowGraph(graph);
  assert.ok(result.issues.some((entry) => entry.code === "MISSING_REQUIRED_OUTPUT" && entry.nodeId === "quality-gate"));
});

test("error branches and failure policy must agree", () => {
  const graph = createDefaultTikTokWorkflowGraph();
  graph.edges.push({ id: "unused-error", source: "review-series", sourcePort: "error", target: "repair-slides", targetPort: "context", role: "error" });
  let result = validateAutomationWorkflowGraph(graph);
  assert.ok(result.issues.some((entry) => entry.code === "DORMANT_ERROR_OUTPUT"));
  graph.nodes.find((node) => node.id === "review-series")!.config.failureMode = "error-output";
  graph.edges = graph.edges.filter((edge) => edge.id !== "unused-error");
  result = validateAutomationWorkflowGraph(graph);
  assert.ok(result.issues.some((entry) => entry.code === "MISSING_ERROR_HANDLER"));
});

test("connection roles cannot disguise error routes as normal flow", () => {
  const graph = createDefaultTikTokWorkflowGraph();
  const errorAsFlow = validateAutomationConnection(graph, {
    source: "review-series", sourcePort: "error", target: "repair-slides", targetPort: "context", role: "flow",
  });
  assert.ok(errorAsFlow.issues.some((entry) => entry.code === "ERROR_ROUTE_ROLE"));
  const normalAsError = validateAutomationConnection(graph, {
    source: "review-series", sourcePort: "result", target: "repair-slides", targetPort: "context", role: "error",
  });
  assert.ok(normalAsError.issues.some((entry) => entry.code === "ERROR_ROUTE_ROLE"));
});

test("AI model and response schema contracts fail closed before publishing", () => {
  const graph = createDefaultTikTokWorkflowGraph();
  const node = graph.nodes.find((entry) => entry.id === "review-series")!;
  node.config.modelId = "made-up/model";
  node.config.responseSchema = { type: "object", properties: { passed: { type: "boolean" } }, unsupportedKeyword: true };
  let result = validateAutomationWorkflowGraph(graph);
  assert.ok(result.issues.some((entry) => entry.code === "INVALID_SETTING_OPTION"));
  assert.ok(result.issues.some((entry) => entry.code === "INVALID_RESPONSE_SCHEMA"));

  node.config.modelId = "openai/gpt-5.6-terra-pro";
  node.config.responseSchema = { type: "object", properties: { passed: { type: "boolean" } }, required: ["passed"] };
  result = validateAutomationWorkflowGraph(graph);
  assert.ok(result.issues.some((entry) => entry.code === "INVALID_RESPONSE_SCHEMA" && entry.message.includes("additionalProperties")));
});

test("execution order includes every active node", () => {
  const graph = createDefaultTikTokWorkflowGraph();
  const ordered = topologicalAutomationNodeIds(graph);
  assert.equal(ordered.length, graph.nodes.length);
  assert.ok(ordered.indexOf("manual-run") < ordered.indexOf("tiktok-source"));
  assert.ok(ordered.indexOf("repair-slides") < ordered.indexOf("generate-images"));
});
