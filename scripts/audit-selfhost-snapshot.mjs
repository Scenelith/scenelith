import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootArgIndex = process.argv.indexOf("--root");
const root = realpathSync(rootArgIndex === -1 ? defaultRoot : resolve(process.argv[rootArgIndex + 1] || ""));
const failures = [];
const files = [];
const ignoredDirectories = new Set([".git", ".next", "node_modules", "dist", "backups"]);

try {
  execFileSync(process.execPath, [join(root, "scripts/compose-edition-package.mjs"), "--check", "--base", join(root, "package.base.json"), "--overlay", join(root, "editions/selfhost/package.overlay.json"), "--output", join(root, "package.json")], { stdio: "pipe" });
} catch {
  failures.push("package.json is not the deterministic self-hosted composition");
}

function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const path = relative(root, absolute).split(sep).join("/");
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) visit(absolute);
      continue;
    }
    if (entry.isSymbolicLink()) {
      const resolved = realpathSync(absolute);
      if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) failures.push(`symlink escapes repository: ${path}`);
      continue;
    }
    if (entry.isFile()) files.push(path);
  }
}

visit(root);

for (const path of files) {
  const base = path.split("/").at(-1) || "";
  if ((base === ".env" || base.startsWith(".env.")) && !base.endsWith(".example")) {
    failures.push(`runtime environment file must not be published: ${path}`);
  }
}

const requiredPaths = [
  "CLA.md",
  "CONTRIBUTING.md",
  "Dockerfile",
  "LICENSE.md",
  "README.md",
  ".github/workflows/cla.yml",
  "deploy/selfhost/compose.yaml",
  "deploy/selfhost/.env.example",
  "docs/DISTRIBUTION_ARCHITECTURE.md",
  "recipes/README.md",
  "src/editions/contracts/runtime.ts",
  "src/editions/contracts/server.ts",
  "src/editions/contracts/client.ts",
  "src/editions/contracts/access.ts",
  "src/editions/selfhost/runtime.ts",
  "src/editions/selfhost/server.ts",
  "src/editions/selfhost/client.tsx",
  "src/editions/current/runtime.ts",
  "src/editions/current/server.ts",
  "src/core/access/owner-workspace-access.ts",
  "database/baselines/core-v1.sql",
  "database/edition.mjs",
  "src/lib/scenelith-document.ts",
  "src/platform/providers/registry.ts",
];
for (const path of requiredPaths) {
  if (!existsSync(join(root, path))) failures.push(`required public path is missing: ${path}`);
}

for (const path of [
  ".scenelith-release.json",
  "deploy/selfhost/export-manifest.json",
  "deploy/selfhost/repository",
  "src/app/(cloud)",
  "src/app/api/billing",
  "src/app/api/webhooks/whop",
  "src/app/pricing",
  "src/app/affiliates",
  "src/components/CreditPacksModal.tsx",
  "src/components/PricingModal.tsx",
  "src/components/affiliate",
  "src/distribution/commerce-observability.ts",
  "src/distribution/commerce-ui.tsx",
  "src/distribution/commerce-worker.ts",
  "src/lib/affiliate.ts",
  "src/lib/billing.ts",
  "src/lib/credit-economics.ts",
  "src/lib/credit-packs.ts",
  "src/lib/pricing.ts",
  "src/lib/whop.ts",
  "src/modules/usage/cloud-usage-authority.ts",
  "src/cloud",
  "src/distribution",
]) {
  if (existsSync(join(root, path))) failures.push(`hosted-only path crossed the public boundary: ${path}`);
}

const credentialPatterns = [
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\bgh[pousr]_[A-Za-z0-9_]{32,}\b/, "GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/, "GitHub fine-grained token"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/, "provider API token"],
  [/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/, "Slack token"],
];

for (const path of files) {
  const absolute = join(root, path);
  const stat = lstatSync(absolute);
  if (stat.size > 2 * 1024 * 1024) continue;
  const bytes = readFileSync(absolute);
  if (bytes.includes(0)) continue;
  const content = bytes.toString("utf8");
  for (const [pattern, label] of credentialPatterns) {
    if (pattern.test(content)) failures.push(`${label} pattern in ${path}`);
  }
  if (path !== "scripts/audit-selfhost-snapshot.mjs" && (content.includes("/Users/") || content.includes("/home/andrei/"))) {
    failures.push(`developer-local absolute path in ${path}`);
  }
}

const runtimeFiles = files.filter((path) => (
  (path.startsWith("src/") || path.startsWith("collaboration/") || path.startsWith("config/"))
  && /\.(?:ts|tsx|js|mjs|json)$/.test(path)
));
const hostedRuntimePatterns = [
  [/@whop\//i, "hosted payment dependency"],
  [/\bWHOP_[A-Z0-9_]+\b/, "hosted payment environment variable"],
  [/\/api\/billing\b/i, "hosted billing route"],
  [/\/api\/webhooks\/whop\b/i, "hosted payment webhook"],
  [/\bmanaged_credits\b/i, "hosted usage mode"],
  [/\bpricingUrl\b/, "hosted upgrade link"],
  [/\b(?:commerce|subscription|affiliate)\b/i, "hosted commercial policy"],
  [/\b(?:support_tickets|support_messages|feature_requests|feature_votes|notification_reads|team_memberships|team_canvas_grants|workspace_invitations|auth_tokens)\b/i, "hosted account or community schema"],
  [/(?:media|api|cloud)\.scenelith\.com/i, "automatic Scenelith-operated runtime endpoint"],
];
for (const path of runtimeFiles) {
  if (path.startsWith("src/editions/contracts/")) continue;
  const content = readFileSync(join(root, path), "utf8");
  for (const [pattern, label] of hostedRuntimePatterns) {
    if (pattern.test(content)) failures.push(`${label} in public runtime: ${path}`);
  }
}

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const envExample = readFileSync(join(root, "deploy/selfhost/.env.example"), "utf8");
if (packageJson.name !== "scenelith" || packageJson.private !== true || packageJson.license !== "SEE LICENSE IN LICENSE.md") {
  failures.push("public package metadata must identify Scenelith, prevent npm publication, and declare the repository license");
}
if (packageJson.repository?.url !== "git+https://github.com/Scenelith/scenelith.git") {
  failures.push("package metadata must point to the canonical public repository");
}
if (!new RegExp(`^SCENELITH_VERSION=${String(packageJson.version).replaceAll(".", "\\.")}$`, "m").test(envExample)) {
  failures.push("SCENELITH_VERSION in the example environment must match package.json");
}
if (!envExample.includes("SCENELITH_APP_IMAGE=ghcr.io/scenelith/scenelith")) {
  failures.push("self-hosted runtime must use the canonical public application package");
}
for (const dependency of ["@whop/checkout", "@whop/sdk", "better-sqlite3"]) {
  if (packageJson.dependencies?.[dependency] || packageJson.devDependencies?.[dependency] || packageJson.optionalDependencies?.[dependency]) {
    failures.push(`hosted-only dependency must not exist in the public package: ${dependency}`);
  }
}

const workflowFiles = files.filter((path) => path.startsWith(".github/workflows/") && /\.ya?ml$/.test(path));
for (const path of workflowFiles) {
  const content = readFileSync(join(root, path), "utf8");
  for (const match of content.matchAll(/uses:\s*([^\s#]+)/g)) {
    if (!/@[a-f0-9]{40}$/.test(match[1])) failures.push(`GitHub Action is not pinned to an immutable commit in ${path}: ${match[1]}`);
  }
}

const composeModel = `${readFileSync(join(root, "deploy/compose/runtime.yaml"), "utf8")}\n${readFileSync(join(root, "deploy/selfhost/compose.yaml"), "utf8")}\n${readFileSync(join(root, "deploy/selfhost/runtime.override.yaml"), "utf8")}`;
if (!composeModel.includes("SCENELITH_APP_IMAGE") || !composeModel.includes("SCENELITH_VERSION")) failures.push("versioned unified application image is missing from Compose");
for (const image of ["postgres", "redis", "caddy"]) {
  if (!new RegExp(`image: ${image}:[^\\s]+@sha256:[a-f0-9]{64}`).test(composeModel)) failures.push(`infrastructure image is not digest pinned: ${image}`);
}

const dockerfileSource = readFileSync(join(root, "Dockerfile"), "utf8");
if (!/FROM node:[^\s]+@sha256:[a-f0-9]{64}/.test(dockerfileSource)) failures.push("Node base image is not digest pinned");

const cloudTables = [
  "billing_orders",
  "subscriptions",
  "billing_payments",
  "billing_adjustments",
  "credit_accounts",
  "credit_ledger",
  "generation_credit_reservations",
  "automation_credit_reservations",
  "billing_webhook_events",
];
const migrationDirectories = [join(root, "database/migrations/core")];
const applicationMigrations = [readFileSync(join(root, "database/baselines/core-v1.sql"), "utf8")]
  .concat(migrationDirectories.flatMap((directory) => readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => readFileSync(join(directory, name), "utf8"))))
  .join("\n");
for (const table of cloudTables) {
  if (new RegExp(`(?:CREATE|ALTER|INSERT\\s+INTO|UPDATE)\\s+(?:TABLE\\s+)?${table}\\b`, "i").test(applicationMigrations)) {
    failures.push(`hosted commercial table must not exist in public migrations: ${table}`);
  }
}

for (const table of [
  "workspace_invitations",
  "team_memberships",
  "team_canvas_grants",
  "workspace_invitation_grants",
  "auth_tokens",
  "support_tickets",
  "support_messages",
  "feature_requests",
  "feature_votes",
  "notifications",
  "notification_reads",
]) {
  if (new RegExp(`CREATE\\s+TABLE\\s+(?:public\\.)?${table}\\b`, "i").test(applicationMigrations)) {
    failures.push(`Cloud-only table must not exist in the self-hosted baseline or core stream: ${table}`);
  }
}

for (const path of runtimeFiles) {
  const content = readFileSync(join(root, path), "utf8");
  if (!path.startsWith("src/editions/current/") && /@\/editions\/selfhost\//.test(content)) {
    failures.push(`shared runtime bypasses the edition contract: ${path}`);
  }
  if (/@\/cloud\//.test(content)) failures.push(`public runtime imports a private Cloud module: ${path}`);
}

if (existsSync(join(root, "compose.yaml"))) failures.push("root compose.yaml would confuse the public self-hosted deployment");

if (failures.length) {
  console.error("Public repository boundary audit failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const digest = createHash("sha256");
for (const path of files.sort()) {
  digest.update(path);
  digest.update("\0");
  digest.update(readFileSync(join(root, path)));
  digest.update("\0");
}
console.log(`Public repository boundary audit passed (${files.length} files, sha256:${digest.digest("hex")})`);
