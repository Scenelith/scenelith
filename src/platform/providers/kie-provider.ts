import {
  KieRateLimitError,
  allowedKieRatios,
  allowedKieResolutions,
  getKieModel,
  kieModels,
  normalizeKieTask,
  startGeneration,
  verifyKieWebhook,
} from "@/lib/kie";

export type { KieProviderWorkflow as GenerationProviderWorkflow } from "@/lib/kie";

export const kieGenerationProvider = {
  id: "kie",
  models: kieModels,
  getModel: getKieModel,
  allowedRatios: allowedKieRatios,
  allowedResolutions: allowedKieResolutions,
  promptLengthLimit(model: ReturnType<typeof getKieModel>) {
    return model.maxPromptLength ?? 5_000;
  },
  start: startGeneration,
  normalizeWebhook: normalizeKieTask,
  verifyWebhook: verifyKieWebhook,
  rateLimitRetryAfter(error: unknown) {
    return error instanceof KieRateLimitError ? error.retryAfterMs : null;
  },
} as const;
