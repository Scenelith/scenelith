import {
  composeGenerationPrompt,
  extractHookFromImage,
  generateAssistantPrompt,
  generateHookVariants,
  requestOpenRouter,
} from "@/lib/openrouter";

export const openRouterIntelligenceProvider = {
  id: "openrouter",
  generateAssistantPrompt,
  composeGenerationPrompt,
  extractHookFromImage,
  generateHookVariants,
  requestStructured: requestOpenRouter,
} as const;
