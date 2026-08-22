import { readRuntimeConfig } from "./runtime-config";
import { editionRuntimeProfile } from "@/editions/current/runtime";
import type { RuntimeCapabilities } from "@/editions/contracts/runtime";

export type { RuntimeCapabilities } from "@/editions/contracts/runtime";

export function runtimeCapabilities(): RuntimeCapabilities {
  const config = readRuntimeConfig();
  return Object.freeze({
    deploymentType: config.deploymentType,
    usageMode: config.usageMode,
    ...editionRuntimeProfile.capabilities,
  });
}
