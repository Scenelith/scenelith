import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "dist");
const stage = resolve(output, "selfhost-bundle");
const bundle = resolve(stage, "scenelith-selfhost");
const archive = resolve(output, "scenelith-selfhost.tar.gz");
const checksum = `${archive}.sha256`;
const installer = resolve(output, "install.sh");
const files = [
  "scenelith",
  "README.md",
  "LICENSE.md",
  "docs/SELF_HOSTING.md",
  "config/runtime-providers.json",
  "deploy/compose/runtime.yaml",
  "deploy/selfhost/.env.example",
  "deploy/selfhost/Caddyfile",
  "deploy/selfhost/compose.yaml",
  "deploy/selfhost/runtime.override.yaml",
];

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

rmSync(stage, { recursive: true, force: true });
rmSync(archive, { force: true });
rmSync(checksum, { force: true });
rmSync(installer, { force: true });
mkdirSync(bundle, { recursive: true });

for (const path of files) {
  const destination = join(bundle, path);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(root, path), destination);
}
chmodSync(join(bundle, "scenelith"), 0o755);

const manifest = files
  .map((path) => `${sha256(join(bundle, path))}  ${path}`)
  .join("\n");
writeFileSync(join(bundle, "MANIFEST.sha256"), `${manifest}\n`, { mode: 0o644 });

const packed = spawnSync("tar", ["-czf", archive, "-C", stage, "scenelith-selfhost"], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, COPYFILE_DISABLE: "1" },
});
if (packed.status !== 0) throw new Error(`tar failed: ${packed.stderr || packed.stdout}`);
writeFileSync(checksum, `${sha256(archive)}  scenelith-selfhost.tar.gz\n`, { mode: 0o644 });
copyFileSync(join(root, "install.sh"), installer);
chmodSync(installer, 0o755);

const version = readFileSync(join(root, "deploy/selfhost/.env.example"), "utf8")
  .match(/^SCENELITH_VERSION=(\d+\.\d+\.\d+)$/m)?.[1];
if (!version) throw new Error("deploy/selfhost/.env.example has no exact SCENELITH_VERSION");
console.log(`Created Scenelith ${version} self-hosted release bundle: ${archive}`);
