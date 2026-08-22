import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const basePath = resolve(argument("--base", "package.base.json"));
const overlayPath = resolve(argument("--overlay", "editions/selfhost/package.overlay.json"));
const outputPath = resolve(argument("--output", "package.json"));

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function merge(base, overlay) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === null) delete result[key];
    else if (isObject(value) && isObject(result[key])) result[key] = merge(result[key], value);
    else result[key] = value;
  }
  return result;
}

const base = JSON.parse(readFileSync(basePath, "utf8"));
const overlay = JSON.parse(readFileSync(overlayPath, "utf8"));
const expected = `${JSON.stringify(merge(base, overlay), null, 2)}\n`;
if (process.argv.includes("--check")) {
  const actual = readFileSync(outputPath, "utf8");
  if (actual !== expected) throw new Error(`${outputPath} is not generated from ${basePath} and ${overlayPath}`);
} else {
  writeFileSync(outputPath, expected);
}
