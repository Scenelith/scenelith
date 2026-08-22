import { z } from "zod";

const deploymentTypeSchema = z.literal("selfhost");
const usageModeSchema = z.literal("bring_your_own");
const registrationModeSchema = z.enum(["owner_only", "invite", "open"]);

export type DeploymentType = z.infer<typeof deploymentTypeSchema>;
export type UsageMode = z.infer<typeof usageModeSchema>;
export type RegistrationMode = z.infer<typeof registrationModeSchema>;
export type RuntimeService = "web" | "generation-worker" | "automation-worker" | "storage-worker" | "collaboration" | "migration";

export type RuntimeConfig = Readonly<{
  deploymentType: DeploymentType;
  usageMode: UsageMode;
  registrationMode: RegistrationMode;
  publicUrl: string;
}>;

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export function readRuntimeConfig(environment: RuntimeEnvironment = process.env): RuntimeConfig {
  const deploymentType = deploymentTypeSchema.parse(environment.SCENELITH_DEPLOYMENT_TYPE || "selfhost");
  const usageMode = usageModeSchema.parse(environment.SCENELITH_USAGE_MODE || "bring_your_own");
  const registrationMode = environment.SCENELITH_REGISTRATION_MODE
    ? registrationModeSchema.parse(environment.SCENELITH_REGISTRATION_MODE)
    : "owner_only";
  return Object.freeze({
    deploymentType,
    usageMode,
    registrationMode,
    publicUrl: String(environment.PUBLIC_URL || "http://localhost:3000").replace(/\/$/, ""),
  });
}

export function requiredEnvironmentForService(service: RuntimeService) {
  const byService: Record<RuntimeService, string[]> = {
    web: ["DATABASE_URL", "SESSION_SECRET"],
    "generation-worker": ["DATABASE_URL"],
    "automation-worker": ["DATABASE_URL"],
    "storage-worker": ["DATABASE_URL"],
    collaboration: ["COLLABORATION_DATABASE_URL", "COLLABORATION_JWT_SECRET", "COLLABORATION_INTERNAL_SECRET"],
    migration: ["DATABASE_URL"],
  };
  return byService[service];
}

export function validateRuntimeEnvironment(service: RuntimeService, environment: RuntimeEnvironment = process.env) {
  const config = readRuntimeConfig(environment);
  const missing = requiredEnvironmentForService(service).filter((key) => !String(environment[key] || "").trim());
  if (missing.length) throw new Error(`Missing ${service} configuration: ${missing.join(", ")}`);
  return config;
}
