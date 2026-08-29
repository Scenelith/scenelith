import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  AUTOMATION_SYSTEM_WORKFLOW_TEMPLATES,
  DEFAULT_TIKTOK_AUTOMATION_TEMPLATE,
  automationSystemWorkflowTemplate,
} from "../src/lib/automation-workflows/system-templates";
import { validateAutomationWorkflowGraph } from "../src/lib/automation-workflows/validation";

const defaultWorkflowSource = readFileSync(new URL("../src/lib/automation-workflows/default-tiktok.ts", import.meta.url), "utf8");
const repositorySource = readFileSync(new URL("../src/lib/automation-workflows/repository.ts", import.meta.url), "utf8");
const systemTemplatesSource = readFileSync(new URL("../src/lib/automation-workflows/system-templates.ts", import.meta.url), "utf8");
const workerSource = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");

test("system workflow identity, metadata and graph factory have one public-core registry", () => {
  assert.ok(AUTOMATION_SYSTEM_WORKFLOW_TEMPLATES.length);
  assert.equal(DEFAULT_TIKTOK_AUTOMATION_TEMPLATE.revision, 49);
  assert.equal(
    new Set(AUTOMATION_SYSTEM_WORKFLOW_TEMPLATES.map((template) => template.key)).size,
    AUTOMATION_SYSTEM_WORKFLOW_TEMPLATES.length,
  );
  for (const template of AUTOMATION_SYSTEM_WORKFLOW_TEMPLATES) {
    assert.match(template.key, /^system\./);
    assert.ok(Number.isSafeInteger(template.revision) && template.revision > 0);
    assert.ok(template.name.length > 0 && template.name.length <= 120);
    assert.ok(template.description.length <= 500);
    assert.equal(automationSystemWorkflowTemplate(template.key), template);
    const graph = template.createGraph();
    assert.equal(validateAutomationWorkflowGraph(graph).valid, true, `${template.key} must build a valid graph`);
    const edgeSignatures = graph.edges.map((edge) => `${edge.source}:${edge.sourcePort}:${edge.role}->${edge.target}:${edge.targetPort}`);
    assert.equal(new Set(edgeSignatures).size, edgeSignatures.length, `${template.key} must not contain duplicate connections`);
  }
  assert.equal(automationSystemWorkflowTemplate("system.unknown"), null);
});

test("system workflow persistence consumes the registry instead of duplicating template metadata", () => {
  assert.match(systemTemplatesSource, /defineSystemWorkflowTemplate/);
  assert.match(repositorySource, /AUTOMATION_SYSTEM_WORKFLOW_TEMPLATES/);
  assert.match(repositorySource, /ensureSystemAutomationWorkflows/);
  assert.match(repositorySource, /template\.createGraph\(\)/);
  assert.doesNotMatch(repositorySource, /"Recreate TikTok slideshow"/);
  assert.doesNotMatch(defaultWorkflowSource, /system\.tiktok-recreate/);
});

test("the default workflow has no decorative or bypassed executable nodes", () => {
  const graph = DEFAULT_TIKTOK_AUTOMATION_TEMPLATE.createGraph();
  const incoming = new Map(graph.nodes.map((node) => [node.id, graph.edges.filter((edge) => edge.target === node.id)]));
  const outgoing = new Map(graph.nodes.map((node) => [node.id, graph.edges.filter((edge) => edge.source === node.id)]));
  assert.deepEqual(graph.nodes.filter((node) => node.disabled).map((node) => node.id), []);
  assert.deepEqual(graph.nodes.filter((node) => node.type !== "core.manual-trigger" && !incoming.get(node.id)?.length).map((node) => node.id), []);
  assert.deepEqual(graph.nodes.filter((node) => !node.type.startsWith("output.") && !outgoing.get(node.id)?.length).map((node) => node.id), []);
  assert.deepEqual(graph.nodes.filter((node) => node.type === "input.visual-references").map((node) => node.id), []);
  assert.deepEqual(incoming.get("generate-images")?.map((edge) => `${edge.source}.${edge.sourcePort}->${edge.targetPort}`), ["prepare-image-requests.requests->requests"]);
});

test("automation workers reconcile persisted system workflows before consuming triggers", () => {
  assert.match(workerSource, /await reconcilePersistedSystemAutomationWorkflows\(\);[\s\S]*await Promise\.all\(\[startTikTokAutomationWorkers\(\), startAutomationWorkflowWorkers\(\)\]\)/);
});
