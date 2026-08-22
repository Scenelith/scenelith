import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statfsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(root, "deploy/selfhost/.env");
const composePath = resolve(root, "deploy/selfhost/compose.yaml");
const providerManifestPath = resolve(root, "config/runtime-providers.json");
const json = process.argv.includes("--json");
const strictProviders = process.argv.includes("--strict-providers");

const checks = [];
const add = (level, id, message) => checks.push({ level, id, message });

function parseEnvironment(contents) {
  const values = new Map();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return values;
}

function versionParts(value) {
  return String(value).replace(/^v/, "").split(".").slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
}

function versionAtLeast(actual, expected) {
  const left = versionParts(actual);
  const right = versionParts(expected);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

const composeVersion = spawnSync("docker", ["compose", "version", "--short"], { encoding: "utf8", timeout: 10_000 });
if (composeVersion.status !== 0) {
  add("error", "compose", "Docker Compose is unavailable. Install Docker with Compose 2.20.3 or newer.");
} else if (!versionAtLeast(composeVersion.stdout.trim(), "2.20.3")) {
  add("error", "compose", `Docker Compose ${composeVersion.stdout.trim()} is too old; 2.20.3 or newer is required.`);
} else {
  add("ok", "compose", `Docker Compose ${composeVersion.stdout.trim()} supports the shared runtime stack.`);
}

let environment = new Map();
if (!existsSync(envPath)) {
  add("error", "environment", "deploy/selfhost/.env is missing. Run npm run selfhost:init.");
} else {
  environment = parseEnvironment(readFileSync(envPath, "utf8"));
  const mode = statSync(envPath).mode & 0o777;
  if ((mode & 0o077) !== 0) add("error", "permissions", "deploy/selfhost/.env must not be readable by group or other users (use mode 0600).");
  else add("ok", "permissions", "Instance secrets file is private (0600).");

  for (const key of ["POSTGRES_PASSWORD", "SESSION_SECRET", "COLLABORATION_JWT_SECRET", "COLLABORATION_INTERNAL_SECRET"]) {
    const value = environment.get(key) || "";
    if (value.length < 32 || /change|replace|example/i.test(value)) add("error", `secret:${key}`, `${key} is missing or still uses a placeholder. Run npm run selfhost:init on a clean environment file.`);
    else add("ok", `secret:${key}`, `${key} is configured.`);
  }

  const releaseVersion = environment.get("SCENELITH_VERSION") || "";
  if (!/^\d+\.\d+\.\d+$/.test(releaseVersion)) {
    add("error", "version", "SCENELITH_VERSION must be an exact release version such as 1.2.3.");
  } else if (releaseVersion !== packageJson.version) {
    add("error", "version", `SCENELITH_VERSION ${releaseVersion} does not match this source release ${packageJson.version}.`);
  } else {
    add("ok", "version", `Source and container images use Scenelith ${releaseVersion}.`);
  }

  if (environment.get("SCENELITH_DEPLOYMENT_TYPE") !== "selfhost" || environment.get("SCENELITH_USAGE_MODE") !== "bring_your_own") {
    add("error", "runtime", "The public distribution must use SCENELITH_DEPLOYMENT_TYPE=selfhost and SCENELITH_USAGE_MODE=bring_your_own.");
  } else {
    add("ok", "runtime", "The self-hosted BYOK runtime profile is locked.");
  }

  const providers = JSON.parse(readFileSync(providerManifestPath, "utf8"));
  for (const provider of providers) {
    if (!provider.environmentVariable) add("ok", `provider:${provider.id}`, `${provider.name} is available for ${provider.description.toLowerCase()}; no provider key is required.`);
    else if (environment.get(provider.environmentVariable)) add("ok", `provider:${provider.id}`, `${provider.name} is connected for ${provider.description.toLowerCase()}.`);
    else add(strictProviders ? "error" : "warning", `provider:${provider.id}`, `${provider.name} key is missing; ${provider.description.toLowerCase()} will stay unavailable.`);
  }

  const storage = (environment.get("STORAGE_PROVIDER") || "local").toLowerCase();
  if (storage === "local") {
    add("ok", "storage", "Local persistent media storage is enabled.");
  } else if (storage === "s3") {
    const missing = ["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_PRIVATE_BUCKET", "S3_PUBLIC_BUCKET"].filter((key) => !environment.get(key));
    if (missing.length) add("error", "storage", `S3 storage is selected but ${missing.join(", ")} is not configured.`);
    else add("ok", "storage", "S3-compatible media storage is configured.");
  } else {
    add("error", "storage", `Unsupported self-hosted storage provider: ${storage}. Use local or s3.`);
  }

  const publicUrl = environment.get("PUBLIC_URL") || "http://localhost";
  const publicHost = environment.get("SCENELITH_HOST") || "http://localhost";
  const secureCookies = (environment.get("COOKIE_SECURE") || "false").toLowerCase() === "true";
  if (publicUrl.startsWith("https://") && !secureCookies) add("error", "https", "COOKIE_SECURE must be true when PUBLIC_URL uses HTTPS.");
  else if (!publicUrl.startsWith("http://localhost") && !publicUrl.startsWith("https://")) add("error", "https", "A public instance must use an HTTPS PUBLIC_URL.");
  else add("ok", "https", publicUrl.startsWith("https://") ? "Public HTTPS and secure cookies are configured." : "Localhost HTTP mode is configured.");
  try {
    const hostUrl = publicHost.includes("://") ? new URL(publicHost) : new URL(`https://${publicHost}`);
    const appUrl = new URL(publicUrl);
    if (hostUrl.host !== appUrl.host) add("error", "origin", "SCENELITH_HOST and PUBLIC_URL must point to the same host.");
    else add("ok", "origin", "Gateway and application use the same public host.");
  } catch {
    add("error", "origin", "SCENELITH_HOST or PUBLIC_URL is not a valid host/origin.");
  }

}

try {
  const disk = statfsSync(root);
  const availableBytes = Number(disk.bavail) * Number(disk.bsize);
  const availableGiB = availableBytes / (1024 ** 3);
  if (availableGiB < 10) add("error", "disk", `Only ${availableGiB.toFixed(1)} GiB is free; at least 10 GiB is required before building the stack.`);
  else if (availableGiB < 20) add("warning", "disk", `${availableGiB.toFixed(1)} GiB is free; 20 GiB or more is recommended for images and media.`);
  else add("ok", "disk", `${availableGiB.toFixed(1)} GiB is free.`);
} catch {
  add("warning", "disk", "Available disk space could not be measured.");
}

if (existsSync(envPath) && composeVersion.status === 0) {
  const configuration = spawnSync("docker", ["compose", "--env-file", envPath, "-f", composePath, "config", "--quiet"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (configuration.status === 0) add("ok", "configuration", "The complete self-hosted Compose model is valid.");
  else add("error", "configuration", "The self-hosted Compose model is invalid. Review deploy/selfhost/.env; secret values were intentionally hidden.");
}

const errors = checks.filter((check) => check.level === "error").length;
const warnings = checks.filter((check) => check.level === "warning").length;

if (json) {
  process.stdout.write(`${JSON.stringify({ ok: errors === 0, errors, warnings, checks }, null, 2)}\n`);
} else {
  const symbols = { ok: "✓", warning: "!", error: "✗" };
  console.log("Scenelith self-hosted doctor\n");
  for (const check of checks) console.log(`${symbols[check.level]} ${check.message}`);
  console.log(`\n${errors ? `${errors} error${errors === 1 ? "" : "s"}` : "Ready"}${warnings ? ` · ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}`);
}

process.exitCode = errors ? 1 : 0;
