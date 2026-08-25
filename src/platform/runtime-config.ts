import { editionRuntimeProfile } from "@/editions/current/runtime";
import type { RegistrationMode, RuntimeConfig, RuntimeEnvironment, RuntimeService } from "@/editions/contracts/runtime";

export type { DeploymentType, RegistrationMode, RuntimeConfig, RuntimeService, UsageMode } from "@/editions/contracts/runtime";

export function readRuntimeConfig(environment: RuntimeEnvironment = process.env): RuntimeConfig {
  const deploymentType = environment.SCENELITH_DEPLOYMENT_TYPE || editionRuntimeProfile.deploymentType;
  if (deploymentType !== editionRuntimeProfile.deploymentType) throw new Error(`Invalid deployment type for this edition: ${deploymentType}`);
  const usageMode = environment.SCENELITH_USAGE_MODE || editionRuntimeProfile.usageMode;
  if (usageMode !== editionRuntimeProfile.usageMode) throw new Error(`Invalid usage mode for this edition: ${usageMode}`);
  const registrationMode = (environment.SCENELITH_REGISTRATION_MODE || editionRuntimeProfile.defaultRegistrationMode) as RegistrationMode;
  if (!editionRuntimeProfile.allowedRegistrationModes.some((allowed) => allowed === registrationMode)) throw new Error(`Invalid registration mode for this edition: ${registrationMode}`);
  return Object.freeze({
    deploymentType,
    usageMode,
    registrationMode,
    publicUrl: String(environment.PUBLIC_URL || "http://localhost:3000").replace(/\/$/, ""),
  });
}

export function requiredEnvironmentForService(service: RuntimeService) {
  const required = (editionRuntimeProfile.requiredEnvironment as Readonly<Record<string, readonly string[]>>)[service];
  if (!required) throw new Error(`Unknown runtime service for this edition: ${service}`);
  return [...required];
}

export function validateRuntimeEnvironment(service: RuntimeService, environment: RuntimeEnvironment = process.env) {
  const config = readRuntimeConfig(environment);
  const missing = requiredEnvironmentForService(service).filter((key) => !String(environment[key] || "").trim());
  if (missing.length) throw new Error(`Missing ${service} configuration: ${missing.join(", ")}`);
  return config;
}
