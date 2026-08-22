import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { readRuntimeConfig } from "@/platform/runtime-config";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

test("the public runtime is permanently self-hosted", () => {
  assert.deepEqual(readRuntimeConfig({}), {
    deploymentType: "selfhost",
    usageMode: "bring_your_own",
    registrationMode: "owner_only",
    publicUrl: "http://localhost:3000",
  });
  assert.throws(() => readRuntimeConfig({ SCENELITH_DEPLOYMENT_TYPE: "cloud" }));
  assert.throws(() => readRuntimeConfig({ SCENELITH_USAGE_MODE: "managed_credits" }));
});

test("hosted commercial source and dependencies are absent", () => {
  for (const path of [
    "src/app/api/billing",
    "src/app/api/webhooks/whop",
    "src/app/pricing",
    "src/app/affiliates",
    "src/lib/billing.ts",
    "src/lib/whop.ts",
    "src/modules/usage/cloud-usage-authority.ts",
  ]) assert.equal(existsSync(join(root, path)), false, path);

  const packageJson = JSON.parse(source("package.json"));
  const checkoutPackage = ["@", "whop/checkout"].join("");
  const sdkPackage = ["@", "whop/sdk"].join("");
  assert.equal(packageJson.dependencies?.[checkoutPackage], undefined);
  assert.equal(packageJson.dependencies?.[sdkPackage], undefined);
  assert.doesNotMatch(source("src/worker.ts"), /webhooks\/whop|billing_webhook_events/);
  assert.doesNotMatch(source("src/proxy.ts"), /@\/lib\/affiliate/);
});

test("self-hosted compose selects the BYOK profile and contains no hosted worker", () => {
  const compose = source("deploy/selfhost/compose.yaml");
  const override = source("deploy/selfhost/runtime.override.yaml");
  assert.match(override, /SCENELITH_DEPLOYMENT_TYPE: selfhost/);
  assert.match(override, /SCENELITH_USAGE_MODE: bring_your_own/);
  assert.doesNotMatch(`${compose}\n${override}`, /billing-worker|WORKER_ROLE: billing/);
});

test("every application role uses the same immutable image", () => {
  const override = source("deploy/selfhost/runtime.override.yaml");
  const runtime = source("deploy/compose/runtime.yaml");
  const dockerfile = source("Dockerfile");
  assert.match(override, /SCENELITH_APP_IMAGE:-ghcr\.io\/scenelith\/scenelith/);
  const roleCommands = {
    "collaboration-migrate": '["node", "collaboration/migrate.mjs"]',
    "application-migrate": '["node", "database/migrate.mjs"]',
    frameflow: '["node", "server.js"]',
    "generation-worker": '["node", "--import", "tsx", "src/worker.ts"]',
    "automation-worker": '["node", "--import", "tsx", "src/worker.ts"]',
    "storage-worker": '["node", "--import", "tsx", "src/worker.ts"]',
    collaboration: '["node", "collaboration/server.mjs"]',
  };
  for (const [service, command] of Object.entries(roleCommands)) {
    assert.ok(override.includes(`\n  ${service}:\n    <<: *selfhost-application\n    command: ${command}`));
  }
  assert.match(dockerfile, /COPY --chown=scenelith:scenelith collaboration \.\/collaboration/);
  assert.match(dockerfile, /COPY --chown=scenelith:scenelith config \.\/config/);
  assert.doesNotMatch(dockerfile, /FROM base AS (?:worker|migration)/);
  assert.doesNotMatch(runtime, /SCENELITH_(?:WEB|WORKER|MIGRATION|COLLABORATION)_IMAGE/);
  assert.doesNotMatch(runtime, /Dockerfile\.collaboration|target: (?:runner|worker|migration)/);
  assert.match(dockerfile, /\/usr\/local\/lib\/node_modules\/npm/);
  assert.match(dockerfile, /\/usr\/local\/lib\/node_modules\/corepack/);
});
