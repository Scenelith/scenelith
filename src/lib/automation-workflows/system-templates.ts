import { createDefaultTikTokWorkflowGraph } from "./default-tiktok";
import type { AutomationWorkflowGraph } from "./types";

export type AutomationSystemWorkflowTemplate = Readonly<{
  key: string;
  revision: number;
  name: string;
  description: string;
  createGraph: () => AutomationWorkflowGraph;
}>;

function defineSystemWorkflowTemplate(
  template: AutomationSystemWorkflowTemplate,
): AutomationSystemWorkflowTemplate {
  const key = template.key.trim();
  const name = template.name.trim();
  const description = template.description.trim();
  if (!/^system\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(key)) {
    throw new Error(`Invalid automation system template key: ${template.key}`);
  }
  if (!Number.isSafeInteger(template.revision) || template.revision < 1) {
    throw new Error(`Automation system template ${key} must have a positive integer revision`);
  }
  if (!name || name.length > 120) {
    throw new Error(`Automation system template ${key} must have a name between 1 and 120 characters`);
  }
  if (description.length > 500) {
    throw new Error(`Automation system template ${key} description cannot exceed 500 characters`);
  }
  return Object.freeze({ ...template, key, name, description });
}

export const DEFAULT_TIKTOK_AUTOMATION_TEMPLATE = defineSystemWorkflowTemplate({
  key: "system.tiktok-recreate",
  revision: 37,
  name: "Recreate TikTok slideshow",
  description: "Analyze a source slideshow, adapt it and generate an editable canvas branch.",
  createGraph: createDefaultTikTokWorkflowGraph,
});

export const AUTOMATION_SYSTEM_WORKFLOW_TEMPLATES = Object.freeze([
  DEFAULT_TIKTOK_AUTOMATION_TEMPLATE,
] satisfies readonly AutomationSystemWorkflowTemplate[]);

const systemTemplatesByKey = new Map(
  AUTOMATION_SYSTEM_WORKFLOW_TEMPLATES.map((template) => [template.key, template]),
);

if (systemTemplatesByKey.size !== AUTOMATION_SYSTEM_WORKFLOW_TEMPLATES.length) {
  throw new Error("Automation system template keys must be unique");
}

export function automationSystemWorkflowTemplate(key: string) {
  return systemTemplatesByKey.get(key) || null;
}
