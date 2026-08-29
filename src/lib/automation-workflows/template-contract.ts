import { automationValueAtPath, automationValuePathIssues } from "./value-path";

export function printAutomationValue(value: unknown) {
  if (typeof value === "string") return value;
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) throw Object.assign(new Error("Workflow value cannot be represented as JSON"), { code: "TEMPLATE_VALUE_INVALID", automationRetryable: false });
  return serialized;
}

function requiredTemplateValue(scope: Record<string, unknown>, path: string) {
  const value = automationValueAtPath(scope, path);
  if (value === undefined) {
    throw Object.assign(new Error(`Workflow template could not find “${path}”`), { code: "TEMPLATE_VALUE_MISSING", automationRetryable: false });
  }
  return value;
}

export function renderAutomationTemplate(template: string, scope: Record<string, unknown>) {
  const whole = template.trim().match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
  if (whole) return requiredTemplateValue(scope, whole[1].trim());
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, path: string) => printAutomationValue(requiredTemplateValue(scope, path.trim())));
}

export function automationTemplateIssues(template: string, allowedRoots: ReadonlySet<string>) {
  const issues: string[] = [];
  const paths: string[] = [];
  const remainder = template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, rawPath: string) => {
    paths.push(rawPath.trim());
    return "";
  });
  if (remainder.includes("{{") || remainder.includes("}}")) issues.push("contains an incomplete template variable");
  for (const path of paths) {
    const pathIssues = automationValuePathIssues(path);
    if (pathIssues.length) {
      issues.push(`variable “${path}” is invalid: ${pathIssues.join("; ")}`);
      continue;
    }
    const root = path.split(".")[0];
    if (!allowedRoots.has(root)) issues.push(`variable “${path}” starts with unavailable value “${root}”`);
  }
  return issues;
}

export function automationTemplateStrings(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) value.forEach((item) => automationTemplateStrings(item, found));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => automationTemplateStrings(item, found));
  return found;
}
