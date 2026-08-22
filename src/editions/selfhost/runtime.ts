import type { EditionRuntimeProfile } from "@/editions/contracts/runtime";

export const editionRuntimeProfile = Object.freeze({
  deploymentType: "selfhost",
  usageMode: "bring_your_own",
  defaultRegistrationMode: "owner_only",
  allowedRegistrationModes: ["owner_only", "open"],
  capabilities: {
    billing: false,
    managedCredits: false,
    bringYourOwnKeys: true,
    teamWorkspaces: false,
    emailDelivery: false,
    passwordRecovery: false,
    productSupport: false,
    featureRequests: false,
    marketingSite: false,
  },
  requiredEnvironment: {
    web: ["DATABASE_URL", "SESSION_SECRET"],
    "generation-worker": ["DATABASE_URL"],
    "automation-worker": ["DATABASE_URL"],
    "billing-worker": [],
    "storage-worker": ["DATABASE_URL"],
    collaboration: ["COLLABORATION_DATABASE_URL", "COLLABORATION_JWT_SECRET", "COLLABORATION_INTERNAL_SECRET"],
    migration: ["DATABASE_URL"],
  },
} satisfies EditionRuntimeProfile);
