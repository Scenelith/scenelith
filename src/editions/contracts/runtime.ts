export type DeploymentType = "selfhost" | "cloud";
export type UsageMode = "bring_your_own" | "managed_credits";
export type RegistrationMode = "owner_only" | "open" | "invite";

export type RuntimeService =
  | "web"
  | "generation-worker"
  | "automation-worker"
  | "billing-worker"
  | "storage-worker"
  | "collaboration"
  | "migration";

export type RuntimeConfig = Readonly<{
  deploymentType: DeploymentType;
  usageMode: UsageMode;
  registrationMode: RegistrationMode;
  publicUrl: string;
}>;

export type RuntimeCapabilities = Readonly<{
  deploymentType: DeploymentType;
  usageMode: UsageMode;
  billing: boolean;
  managedCredits: boolean;
  bringYourOwnKeys: boolean;
  teamWorkspaces: boolean;
  emailDelivery: boolean;
  passwordRecovery: boolean;
  productSupport: boolean;
  featureRequests: boolean;
  marketingSite: boolean;
}>;

export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export type EditionRuntimeProfile = Readonly<{
  deploymentType: DeploymentType;
  usageMode: UsageMode;
  defaultRegistrationMode: RegistrationMode;
  allowedRegistrationModes: readonly RegistrationMode[];
  capabilities: Omit<RuntimeCapabilities, "deploymentType" | "usageMode">;
  requiredEnvironment: Readonly<Record<RuntimeService, readonly string[]>>;
}>;
