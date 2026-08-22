import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const root = resolve(import.meta.dirname, "..");
export const envPath = resolve(root, "deploy/selfhost/.env");
export const composePath = resolve(root, "deploy/selfhost/compose.yaml");

export function requireEnvironment() {
  if (!existsSync(envPath)) throw new Error("deploy/selfhost/.env is missing. Run npm run selfhost:init first.");
  const values = new Map();
  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator > 0) values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return values;
}

export function composeArgs(...args) {
  return ["compose", "--env-file", envPath, "-f", composePath, ...args];
}

export function runDocker(args, options = {}) {
  const result = spawnSync("docker", args, { cwd: root, stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`docker ${args.join(" ")} exited with ${result.status}`);
}

export function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] || null;
}
