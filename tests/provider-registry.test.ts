import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

test("provider transports are isolated behind the runtime registry", () => {
  const sourceFiles = readdirSync(join(root, "src"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name))
    .map((entry) => `src/${join(entry.parentPath, entry.name).slice(join(root, "src").length + 1).replaceAll("\\", "/")}`);
  const allowedAdapters = new Set([
    "src/platform/providers/kie-provider.ts",
    "src/platform/providers/openrouter-provider.ts",
    "src/platform/providers/tikwm-provider.ts",
  ]);
  const providerImplementations = new Set(["src/lib/kie.ts", "src/lib/openrouter.ts", "src/lib/tiktok.ts"]);
  for (const path of sourceFiles) {
    if (allowedAdapters.has(path) || providerImplementations.has(path)) continue;
    for (const module of ["kie", "openrouter", "tiktok"]) {
      assert.doesNotMatch(source(path), new RegExp(`(?:from|import\\()[^\\n]*["'](?:@/|\\.{1,2}/)+lib/${module}["']`), `${path} bypasses the provider registry`);
    }
  }
  const registry = source("src/platform/providers/registry.ts");
  for (const id of ["kie", "openrouter", "tikwm"]) assert.match(registry, new RegExp(`\\b${id}\\b`));
});
