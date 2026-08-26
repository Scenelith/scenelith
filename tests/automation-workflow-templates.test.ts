import assert from "node:assert/strict";
import { test } from "node:test";
import { renderAutomationTemplate } from "../src/lib/automation-workflows/node-handlers";

test("workflow templates preserve structured whole-value substitutions", () => {
  const source = { slides: [{ index: 1 }, { index: 2 }] };
  assert.deepEqual(renderAutomationTemplate("{{ primary }}", { primary: source }), source);
  assert.equal(renderAutomationTemplate("Slides: {{ primary.slides }}", { primary: source }), 'Slides: [\n  {\n    "index": 1\n  },\n  {\n    "index": 2\n  }\n]');
});
