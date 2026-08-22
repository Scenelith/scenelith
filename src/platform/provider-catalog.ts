import { hasInstanceSecret } from "@/platform/secrets";
import { registeredProviderIds } from "@/platform/providers/registry";
import providerDefinitions from "../../config/runtime-providers.json";

export type RuntimeProviderStatus = {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  environmentVariable: string | null;
  requiresKey: boolean;
  configured: boolean;
};

export function runtimeProviderStatuses(): RuntimeProviderStatus[] {
  const registered = new Set<string>(registeredProviderIds());
  return providerDefinitions.map((provider) => {
    if (!registered.has(provider.id)) throw new Error(`Provider ${provider.id} has no runtime adapter`);
    const requiresKey = Boolean(provider.environmentVariable);
    return {
      ...provider,
      capabilities: [...provider.capabilities],
      requiresKey,
      configured: provider.environmentVariable ? hasInstanceSecret(provider.environmentVariable) : true,
    };
  });
}
