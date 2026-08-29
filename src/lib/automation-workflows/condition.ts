import { automationValueAtPath } from "./value-path";

function equalAutomationValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => equalAutomationValue(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key)
      && equalAutomationValue(leftRecord[key], rightRecord[key]));
}

function evaluateCondition(data: unknown, config: Record<string, unknown>, booleanOperators: readonly string[], strictComparisonTypes = false) {
  if (typeof config.path !== "string") throw Object.assign(new Error("Condition field path must be text"), { code: "NODE_CONFIGURATION_INVARIANT", automationRetryable: false });
  const path = config.path.trim();
  const value = automationValueAtPath(data, path);
  const expected = config.compareValue;
  const operator = config.operator;
  const supported = new Set([...booleanOperators, "is-empty", "is-not-empty", "equals", "not-equals", "contains", "greater-than", "less-than"]);
  if (typeof operator !== "string" || !supported.has(operator)) {
    throw Object.assign(new Error("Condition operator is invalid"), { code: "NODE_CONFIGURATION_INVARIANT", automationRetryable: false });
  }
  const empty = value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)
    || (typeof value === "object" && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0);
  if (operator === "is-truthy") return Boolean(value);
  if (operator === "is-falsy") return !value;
  if (operator === "is-true") return value === true;
  if (operator === "is-false") return value === false;
  if (operator === "is-empty") return empty;
  if (operator === "is-not-empty") return !empty;
  if (operator === "equals") return equalAutomationValue(value, expected);
  if (operator === "not-equals") return !equalAutomationValue(value, expected);
  if (operator === "contains") {
    if (expected === undefined || expected === null) throw Object.assign(new Error("Contains requires a comparison value"), { code: "CONDITION_COMPARISON_INVALID", automationRetryable: false });
    if (strictComparisonTypes && typeof value === "string" && typeof expected !== "string") {
      throw Object.assign(new Error("Text containment requires a text comparison value"), { code: "CONDITION_COMPARISON_INVALID", automationRetryable: false });
    }
    return typeof value === "string"
    ? value.includes(String(expected))
    : Array.isArray(value) && value.some((item) => equalAutomationValue(item, expected));
  }
  if (operator === "greater-than" || operator === "less-than") {
    if (expected === undefined || expected === null || expected === "" || value === undefined || value === null || value === "") {
      throw Object.assign(new Error("Numeric comparison requires both values"), { code: "CONDITION_COMPARISON_INVALID", automationRetryable: false });
    }
    if (strictComparisonTypes && (typeof value !== "number" || typeof expected !== "number")) {
      throw Object.assign(new Error("Numeric comparison requires actual number values"), { code: "CONDITION_COMPARISON_INVALID", automationRetryable: false });
    }
    const left = Number(value);
    const right = Number(expected);
    if (!Number.isFinite(left) || !Number.isFinite(right)) throw Object.assign(new Error("Numeric comparison received a non-numeric value"), { code: "CONDITION_COMPARISON_INVALID", automationRetryable: false });
    return operator === "greater-than" ? left > right : left < right;
  }
  throw Object.assign(new Error("Condition operator is invalid"), { code: "NODE_CONFIGURATION_INVARIANT", automationRetryable: false });
}

/** Historical @1 semantics. Published workflows keep JavaScript truthiness. */
export function evaluateAutomationCondition(data: unknown, config: Record<string, unknown>) {
  return evaluateCondition(data, config, ["is-truthy", "is-falsy"]);
}

/** Current @2 semantics. Boolean routes never coerce text or numbers. */
export function evaluateAutomationConditionV2(data: unknown, config: Record<string, unknown>) {
  return evaluateCondition(data, config, ["is-true", "is-false"]);
}

/** Current @3 semantics. Boolean, text and numeric comparisons preserve JSON types. */
export function evaluateAutomationConditionV3(data: unknown, config: Record<string, unknown>) {
  return evaluateCondition(data, config, ["is-true", "is-false"], true);
}
