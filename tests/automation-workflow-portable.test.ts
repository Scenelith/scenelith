import assert from "node:assert/strict";
import { test } from "node:test";
import { createDefaultTikTokWorkflowGraph } from "../src/lib/automation-workflows/default-tiktok";
import {
  AUTOMATION_PACKAGE_FORMAT,
  AutomationPackageError,
  automationPackageDigest,
  createAutomationPackage,
  parseAutomationPackage,
} from "../src/lib/automation-workflows/portable";

test("automation packages are integrity checked and remove instance-bound resources", () => {
  const graph = createDefaultTikTokWorkflowGraph();
  graph.nodes.push({
    id: "visual-references", type: "input.visual-references", version: 1, name: "Visual references", description: "Custom visual context", position: { x: 0, y: 0 }, groupId: null,
    config: { references: [], maxItems: 8, optional: true }, bindings: { references: { mode: "ask-on-run", label: "Reference images", required: false } }, disabled: false,
  });
  graph.edges.push({ id: "edge-custom-references", source: "manual-run", sourcePort: "run", target: "visual-references", targetPort: "run", role: "flow" });
  const source = graph.nodes.find((node) => node.id === "tiktok-source")!;
  const identity = graph.nodes.find((node) => node.id === "identity")!;
  const references = graph.nodes.find((node) => node.id === "visual-references")!;
  source.config.source = "private-source-node-id";
  source.bindings.source = { mode: "fixed", value: "private-source-node-id", required: true };
  identity.config.identity = "private-persona-id";
  identity.config.optional = false;
  identity.bindings.identity = { mode: "fixed", value: "private-persona-id", required: true };
  references.config.references = ["private-reference-asset-id"];
  references.bindings.references = { mode: "fixed", value: ["private-reference-asset-id"], required: false };

  const portable = createAutomationPackage({ name: "Shared creator flow", description: "Portable automation", graph });
  assert.equal(portable.format, AUTOMATION_PACKAGE_FORMAT);
  const serialized = JSON.stringify(portable);
  assert.doesNotMatch(serialized, /private-source-node-id|private-persona-id|private-reference-asset-id/);
  assert.deepEqual(portable.graph.nodes.find((node) => node.id === "tiktok-source")?.bindings.source, {
    mode: "ask-on-run", label: "Source slideshow", required: true,
  });
  assert.deepEqual(portable.graph.nodes.find((node) => node.id === "identity")?.bindings.identity, {
    mode: "ask-on-run", label: "Person or character", required: true,
  });
  assert.deepEqual(portable.graph.nodes.find((node) => node.id === "visual-references")?.bindings.references, {
    mode: "ask-on-run", label: "Reference images", required: false,
  });
  assert.deepEqual(parseAutomationPackage(JSON.parse(serialized)), portable);
});

test("automation package tampering fails closed", () => {
  const portable = createAutomationPackage({ name: "Untampered", graph: createDefaultTikTokWorkflowGraph() });
  const tampered = structuredClone(portable);
  tampered.metadata.name = "Changed after export";
  assert.throws(() => parseAutomationPackage(tampered), (error: unknown) => error instanceof AutomationPackageError && error.code === "PACKAGE_INTEGRITY");
});

test("automation packages cannot carry credentials", () => {
  const portable = createAutomationPackage({ name: "Safe", graph: createDefaultTikTokWorkflowGraph() }) as unknown as Record<string, unknown>;
  const poisoned = { ...portable, apiKey: "embedded-credential-must-not-be-imported" };
  assert.throws(() => parseAutomationPackage(poisoned), (error: unknown) => error instanceof AutomationPackageError && error.code === "EMBEDDED_SECRET");
});

test("declared package requirements must exactly describe the graph", () => {
  const portable = createAutomationPackage({ name: "Requirements", graph: createDefaultTikTokWorkflowGraph() });
  const payload = structuredClone(portable);
  payload.requirements.nodeTypes = payload.requirements.nodeTypes.slice(1);
  const unsigned = structuredClone(payload);
  delete (unsigned as Partial<typeof payload>).integrity;
  payload.integrity.digest = automationPackageDigest(unsigned as Omit<typeof payload, "integrity">);
  assert.throws(() => parseAutomationPackage(payload), (error: unknown) => error instanceof AutomationPackageError && error.code === "REQUIREMENTS_MISMATCH");
});
