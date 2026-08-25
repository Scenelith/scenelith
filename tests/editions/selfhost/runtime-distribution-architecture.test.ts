import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { readRuntimeConfig } from "@/platform/runtime-config";
import { runtimeCapabilities } from "@/platform/runtime-capabilities";

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
  assert.throws(() => readRuntimeConfig({ SCENELITH_REGISTRATION_MODE: "invite" }));
  assert.deepEqual(runtimeCapabilities(), {
    deploymentType: "selfhost",
    usageMode: "bring_your_own",
    billing: false,
    managedCredits: false,
    bringYourOwnKeys: true,
    teamWorkspaces: false,
    emailDelivery: false,
    passwordRecovery: false,
    productSupport: false,
    featureRequests: false,
    marketingSite: false,
  });
});

test("hosted product source and dependencies are absent", () => {
  for (const path of [
    "src/app/(cloud)",
    "src/app/api/billing",
    "src/app/api/webhooks/whop",
    "src/app/pricing",
    "src/app/affiliates",
    "src/lib/billing.ts",
    "src/lib/whop.ts",
    "src/modules/usage/cloud-usage-authority.ts",
    "src/app/api/admin/overview/route.ts",
    "src/app/api/admin/notifications/route.ts",
    "src/app/api/features/route.ts",
    "src/app/api/notifications/route.ts",
    "src/app/api/support/route.ts",
    "src/app/api/team/route.ts",
    "src/app/invite/[token]/page.tsx",
    "src/components/CommunityPanels.tsx",
    "src/components/InviteAcceptance.tsx",
    "src/components/PendingTeamInvitations.tsx",
    "src/components/TeamPanel.tsx",
    "src/lib/community-policy.ts",
    "src/lib/community.ts",
    "src/lib/team.ts",
    "src/app/forgot-password/page.tsx",
    "src/app/reset-password/page.tsx",
    "src/app/api/auth/password/forgot/route.ts",
    "src/app/api/auth/password/reset/route.ts",
    "src/app/api/auth/verify-email/route.ts",
    "src/components/ui/auth-recovery-form.tsx",
    "src/lib/auth-tokens.ts",
    "src/lib/email.ts",
    "src/lib/public-media.ts",
    "src/cloud",
    "src/distribution",
  ]) assert.equal(existsSync(join(root, path)), false, path);

  const packageJson = JSON.parse(source("package.json"));
  const checkoutPackage = ["@", "whop/checkout"].join("");
  const sdkPackage = ["@", "whop/sdk"].join("");
  assert.equal(packageJson.dependencies?.[checkoutPackage], undefined);
  assert.equal(packageJson.dependencies?.[sdkPackage], undefined);
  assert.equal(packageJson.dependencies?.nodemailer, undefined);
  assert.equal(packageJson.devDependencies?.["@types/nodemailer"], undefined);
  assert.doesNotMatch(source("src/worker.ts"), /webhooks\/whop|billing_webhook_events/);
  assert.doesNotMatch(source("src/worker.ts"), /auth_tokens/);
  assert.doesNotMatch(source("src/proxy.ts"), /@\/lib\/affiliate/);
  assert.doesNotMatch(source("src/components/ui/auth-section-2.tsx"), /forgot-password|Create your team|teamInvite|href="\/(?:terms|privacy)"/);
  assert.doesNotMatch(source("src/app/globals.css"), /\.(?:(?:invite|landing|marketing|policy|auth-recovery)(?:[-_][a-zA-Z0-9_-]+)?|identity-place-button)\b/);
  assert.doesNotMatch(source("deploy/compose/runtime.yaml"), /EMAIL_TRANSPORT|RESEND_API_KEY|SMTP_/);
  assert.doesNotMatch(source("deploy/selfhost/.env.example"), /EMAIL_TRANSPORT|RESEND_API_KEY|SMTP_/);
  const baseline = source("database/baselines/core-v1.sql");
  for (const cloudTable of ["workspace_invitations", "team_memberships", "team_canvas_grants", "workspace_invitation_grants", "auth_tokens", "support_tickets", "support_messages", "feature_requests", "feature_votes", "notifications", "notification_reads"]) {
    assert.doesNotMatch(baseline, new RegExp(`CREATE TABLE public\\.${cloudTable}\\b`, "i"), cloudTable);
  }
});

test("self-hosted compose selects the BYOK profile and contains no hosted worker", () => {
  const compose = source("deploy/selfhost/compose.yaml");
  const runtime = source("deploy/compose/runtime.yaml");
  const override = source("deploy/selfhost/runtime.override.yaml");
  assert.match(override, /SCENELITH_DEPLOYMENT_TYPE: selfhost/);
  assert.match(override, /SCENELITH_USAGE_MODE: bring_your_own/);
  assert.doesNotMatch(`${compose}\n${override}`, /billing-worker|WORKER_ROLE: billing/);
  assert.match(runtime, /collaboration-migrate:[\s\S]*?depends_on:\s*\n\s*application-migrate:\s*\n\s*condition: service_completed_successfully/);
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

test("self-hosted persistence verifies only portable canvas state", () => {
  const selfhostE2e = source("scripts/selfhost-e2e.mjs");
  assert.match(selfhostE2e, /graphMarker/);
  assert.match(selfhostE2e, /realtimeMarker/);
  assert.doesNotMatch(selfhostE2e, /\/api\/(?:support|features|notifications|team)/);
});
