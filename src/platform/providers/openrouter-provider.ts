import {
  composeGenerationPrompt,
  extractHookFromImage,
  generateAssistantPrompt,
  generateHookVariants,
} from "@/lib/openrouter";

export const openRouterIntelligenceProvider = {
  id: "openrouter",
  generateAssistantPrompt,
  composeGenerationPrompt,
  extractHookFromImage,
  generateHookVariants,
} as const;
