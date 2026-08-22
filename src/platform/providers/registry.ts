import providerDefinitions from "../../../config/runtime-providers.json";
import { kieGenerationProvider, type GenerationProviderWorkflow } from "./kie-provider";
import { openRouterIntelligenceProvider } from "./openrouter-provider";
import { tikwmImportProvider } from "./tikwm-provider";

export type { GenerationProviderWorkflow };

const generationProviders = { kie: kieGenerationProvider } as const;
const intelligenceProviders = { openrouter: openRouterIntelligenceProvider } as const;
const importProviders = { tikwm: tikwmImportProvider } as const;

export type GenerationProviderId = keyof typeof generationProviders;
export type IntelligenceProviderId = keyof typeof intelligenceProviders;
export type ImportProviderId = keyof typeof importProviders;
export type RegisteredProviderId = GenerationProviderId | IntelligenceProviderId | ImportProviderId;

export const defaultGenerationProviderId: GenerationProviderId = "kie";
export const defaultIntelligenceProviderId: IntelligenceProviderId = "openrouter";
export const defaultImportProviderId: ImportProviderId = "tikwm";

function requiredProvider<T extends Record<string, unknown>>(providers: T, id: string, capability: string) {
  const provider = providers[id as keyof T];
  if (!provider) throw new Error(`Provider ${id} is not registered for ${capability}`);
  return provider;
}

export function generationProvider(id: GenerationProviderId = defaultGenerationProviderId) {
  return requiredProvider(generationProviders, id, "generation");
}

export function intelligenceProvider(id: IntelligenceProviderId = defaultIntelligenceProviderId) {
  return requiredProvider(intelligenceProviders, id, "AI intelligence");
}

export function importProvider(id: ImportProviderId = defaultImportProviderId) {
  return requiredProvider(importProviders, id, "media import");
}

export function registeredProviderIds(): RegisteredProviderId[] {
  return [
    ...Object.keys(generationProviders),
    ...Object.keys(intelligenceProviders),
    ...Object.keys(importProviders),
  ] as RegisteredProviderId[];
}

const configuredProviderIds = new Set(providerDefinitions.map((provider) => provider.id));
for (const id of registeredProviderIds()) {
  if (!configuredProviderIds.has(id)) throw new Error(`Registered provider ${id} is missing from config/runtime-providers.json`);
}
for (const id of configuredProviderIds) {
  if (!registeredProviderIds().includes(id as RegisteredProviderId)) throw new Error(`Configured provider ${id} has no runtime adapter`);
}
