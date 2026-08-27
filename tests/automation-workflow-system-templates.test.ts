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

test("system workflow identity, metadata and graph factory have one public-core registry", () => {
  assert.ok(AUTOMATION_SYSTEM_WORKFLOW_TEMPLATES.length);
  assert.equal(DEFAULT_TIKTOK_AUTOMATION_TEMPLATE.revision, 28);
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
    assert.equal(validateAutomationWorkflowGraph(template.createGraph()).valid, true, `${template.key} must build a valid graph`);
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
