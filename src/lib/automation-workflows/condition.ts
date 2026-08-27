function valueAtPath(source: unknown, path: string) {
  const segments = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let value = source;
  for (const segment of segments) {
    if (value === null || value === undefined || typeof value !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(value, segment)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function equalAutomationValue(left: unknown, right: unknown) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  try { return JSON.stringify(left) === JSON.stringify(right); }
  catch { return false; }
}

export function evaluateAutomationCondition(data: unknown, config: Record<string, unknown>) {
  const enteredPath = String(config.path || "").trim();
  const path = enteredPath === "data" ? "" : enteredPath.startsWith("data.") ? enteredPath.slice(5) : enteredPath;
  const value = path ? valueAtPath(data, path) : data;
  const expected = config.compareValue;
  const operator = String(config.operator || "is-truthy");
  const empty = value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)
    || (typeof value === "object" && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0);
  if (operator === "is-truthy") return Boolean(value);
  if (operator === "is-falsy") return !value;
  if (operator === "is-empty") return empty;
  if (operator === "is-not-empty") return !empty;
  if (operator === "equals") return equalAutomationValue(value, expected);
  if (operator === "not-equals") return !equalAutomationValue(value, expected);
  if (operator === "contains") return typeof value === "string"
    ? value.includes(String(expected ?? ""))
    : Array.isArray(value) && value.some((item) => equalAutomationValue(item, expected));
  if (operator === "greater-than" || operator === "less-than") {
    const left = Number(value);
    const right = Number(expected);
    return Number.isFinite(left) && Number.isFinite(right) && (operator === "greater-than" ? left > right : left < right);
  }
  return false;
}
