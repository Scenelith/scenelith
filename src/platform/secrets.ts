import { readFileSync } from "node:fs";

/** Resolve Docker/Kubernetes-style *_FILE secrets before environment values. */
export function readInstanceSecret(name: string, environment: NodeJS.ProcessEnv = process.env) {
  const file = String(environment[`${name}_FILE`] || "").trim();
  if (file) {
    const value = readFileSync(file, "utf8").trim();
    if (!value) throw new Error(`${name}_FILE points to an empty secret`);
    return value;
  }
  const value = String(environment[name] || "").trim();
  return value || null;
}

export function requireInstanceSecret(name: string, environment: NodeJS.ProcessEnv = process.env) {
  const value = readInstanceSecret(name, environment);
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export function hasInstanceSecret(name: string, environment: NodeJS.ProcessEnv = process.env) {
  try { return Boolean(readInstanceSecret(name, environment)); }
  catch { return false; }
}
