const supportedKeywords = new Set([
  "type", "description", "properties", "required", "items", "enum", "additionalProperties",
  "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => sameValue(item, right[index]));
  const leftRecord = record(left);
  const rightRecord = record(right);
  if (!leftRecord || !rightRecord) return false;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && sameValue(leftRecord[key], rightRecord[key]));
}

export function automationJsonSchemaDefinitionIssues(schema: unknown, path = "responseSchema", strict = false, depth = 0): string[] {
  if (depth > 24) return [`${path} exceeds the maximum schema depth`];
  const rule = record(schema);
  if (!rule) return [`${path} must be a JSON object`];
  const errors = Object.keys(rule).filter((key) => !supportedKeywords.has(key)).map((key) => `${path}.${key} is not supported by automation schemas`);
  const type = rule.type === undefined ? "" : String(rule.type);
  if (type && !["object", "array", "string", "integer", "number", "boolean", "null"].includes(type)) errors.push(`${path}.type is unsupported`);
  if (rule.enum !== undefined && !Array.isArray(rule.enum)) errors.push(`${path}.enum must be an array`);
  if (type === "object" || rule.properties !== undefined || rule.required !== undefined) {
    const properties = rule.properties === undefined ? {} : record(rule.properties);
    if (!properties) errors.push(`${path}.properties must be an object`);
    const required = rule.required === undefined ? [] : Array.isArray(rule.required) && rule.required.every((item) => typeof item === "string") ? rule.required as string[] : null;
    if (!required) errors.push(`${path}.required must be an array of property names`);
    if (properties && required) {
      for (const [key, child] of Object.entries(properties)) errors.push(...automationJsonSchemaDefinitionIssues(child, `${path}.properties.${key}`, strict, depth + 1));
      if (strict) {
        if (rule.additionalProperties !== false) errors.push(`${path}.additionalProperties must be false in strict mode`);
        for (const key of required) if (!(key in properties)) errors.push(`${path}.required references unavailable property ${key} in strict mode`);
        for (const key of Object.keys(properties)) if (!required.includes(key)) errors.push(`${path}.required must include ${key} in strict mode`);
      }
    }
    if (rule.additionalProperties !== undefined && typeof rule.additionalProperties !== "boolean") errors.push(`${path}.additionalProperties must be true or false`);
  }
  if (type === "array" || rule.items !== undefined) {
    if (!record(rule.items)) errors.push(`${path}.items must be a schema object`);
    else errors.push(...automationJsonSchemaDefinitionIssues(rule.items, `${path}.items`, strict, depth + 1));
  }
  for (const key of ["minItems", "maxItems", "minLength", "maxLength"] as const) {
    if (rule[key] !== undefined && (typeof rule[key] !== "number" || !Number.isInteger(rule[key]) || rule[key] < 0)) errors.push(`${path}.${key} must be a non-negative integer`);
  }
  for (const key of ["minimum", "maximum"] as const) {
    if (rule[key] !== undefined && (typeof rule[key] !== "number" || !Number.isFinite(rule[key]))) errors.push(`${path}.${key} must be a finite number`);
  }
  return errors;
}

export function validateAutomationStructuredValue(value: unknown, schema: unknown, path = "result", depth = 0): string[] {
  if (depth > 24) return [`${path} exceeds the maximum validation depth`];
  const rule = record(schema);
  if (!rule) return [`${path} schema is invalid`];
  if (Array.isArray(rule.enum) && !rule.enum.some((candidate) => sameValue(candidate, value))) return [`${path} must match an allowed value`];
  const type = String(rule.type || "");
  if (type === "null") return value === null ? [] : [`${path} must be null`];
  if (type === "object") {
    const valueRecord = record(value);
    if (!valueRecord) return [`${path} must be an object`];
    const required = Array.isArray(rule.required) ? rule.required.map(String) : [];
    const errors = required.filter((key) => !(key in valueRecord)).map((key) => `${path}.${key} is required`);
    const properties = record(rule.properties) || {};
    for (const [key, child] of Object.entries(properties)) if (key in valueRecord) errors.push(...validateAutomationStructuredValue(valueRecord[key], child, `${path}.${key}`, depth + 1));
    if (rule.additionalProperties === false) for (const key of Object.keys(valueRecord)) if (!(key in properties)) errors.push(`${path}.${key} is not allowed`);
    return errors;
  }
  if (type === "array") {
    if (!Array.isArray(value)) return [`${path} must be an array`];
    const errors: string[] = [];
    if (typeof rule.minItems === "number" && Number.isInteger(rule.minItems) && value.length < rule.minItems) errors.push(`${path} needs at least ${rule.minItems} items`);
    if (typeof rule.maxItems === "number" && Number.isInteger(rule.maxItems) && value.length > rule.maxItems) errors.push(`${path} accepts at most ${rule.maxItems} items`);
    return [...errors, ...value.flatMap((item, index) => validateAutomationStructuredValue(item, rule.items, `${path}[${index}]`, depth + 1))];
  }
  if (type === "string") {
    if (typeof value !== "string") return [`${path} must be a string`];
    if (typeof rule.minLength === "number" && Number.isInteger(rule.minLength) && value.length < rule.minLength) return [`${path} is too short`];
    if (typeof rule.maxLength === "number" && Number.isInteger(rule.maxLength) && value.length > rule.maxLength) return [`${path} is too long`];
  }
  if (type === "integer" && !Number.isInteger(value)) return [`${path} must be an integer`];
  if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return [`${path} must be a finite number`];
  if (type === "boolean" && typeof value !== "boolean") return [`${path} must be a boolean`];
  if ((type === "integer" || type === "number") && typeof value === "number") {
    if (typeof rule.minimum === "number" && Number.isFinite(rule.minimum) && value < rule.minimum) return [`${path} must be at least ${rule.minimum}`];
    if (typeof rule.maximum === "number" && Number.isFinite(rule.maximum) && value > rule.maximum) return [`${path} must be at most ${rule.maximum}`];
  }
  return [];
}
