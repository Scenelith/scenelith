import {
  composeGenerationPrompt,
  extractHookFromImage,
  generateAssistantPrompt,
  generateHookVariants,
  requestOpenRouter,
  requestOpenRouterText,
} from "@/lib/openrouter";

export const openRouterIntelligenceProvider = {
  id: "openrouter",
  generateAssistantPrompt,
  composeGenerationPrompt,
  extractHookFromImage,
  generateHookVariants,
  requestStructured: requestOpenRouter,
  requestText: requestOpenRouterText,
} as const;
