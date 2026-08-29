const unsafeAutomationPathSegments = new Set(["__proto__", "prototype", "constructor"]);
const automationPathSegmentPattern = /^(?:[A-Za-z_][A-Za-z0-9_-]*|\d+)$/;

export function automationValuePathIssues(path: string, options: { allowEmpty?: boolean } = {}) {
  const normalized = path.trim();
  if (!normalized) return options.allowEmpty ? [] : ["the field path is empty"];
  const segments = normalized.split(".");
  if (segments.some((segment) => !segment)) return ["field paths cannot contain empty segments"];
  if (segments.some((segment) => unsafeAutomationPathSegments.has(segment))) return ["the field path contains a reserved segment"];
  if (segments.some((segment) => !automationPathSegmentPattern.test(segment))) {
    return ["use dot-separated field names and numeric list indexes, for example campaign.slides.0.title"];
  }
  return [];
}

export function automationValueAtPath(source: unknown, path: string) {
  const issues = automationValuePathIssues(path, { allowEmpty: true });
  if (issues.length) {
    throw Object.assign(new Error(`Invalid workflow field path “${path}”: ${issues.join("; ")}`), {
      code: "VALUE_PATH_INVALID",
      automationRetryable: false,
    });
  }
  const normalized = path.trim();
  if (!normalized) return source;
  let value = source;
  for (const segment of normalized.split(".")) {
    if (value === null || value === undefined || typeof value !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(value, segment)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}
