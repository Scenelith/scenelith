import { readRuntimeConfig } from "./runtime-config";

export type RuntimeCapabilities = Readonly<{
  deploymentType: "selfhost";
  usageMode: "bring_your_own";
  bringYourOwnKeys: boolean;
  teamWorkspaces: boolean;
}>;

export function runtimeCapabilities(): RuntimeCapabilities {
  const config = readRuntimeConfig();
  return Object.freeze({
    deploymentType: config.deploymentType,
    usageMode: config.usageMode,
    bringYourOwnKeys: true,
    teamWorkspaces: true,
  });
}
