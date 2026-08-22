import { DEFAULT_ASSISTANT_MODEL_ID, getAssistantModel } from "./assistant-models";
import { editionEconomics } from "@/editions/current/economics";

export const providerCostToUsageUnits = editionEconomics.providerCostToUsageUnits;

// Keep automation pricing anchored to the original planning workload rate.
// The default assistant model may change without silently repricing runs.
const AUTOMATION_BASELINE_PROMPT_USD_PER_TOKEN = 0.00000025;
const AUTOMATION_BASELINE_COMPLETION_USD_PER_TOKEN = 0.0000015;

/**
 * A conservative pre-authorization, not the final price. The fixed portion
 * covers campaign-level analysis/review; the per-slide portion covers prompt
 * planning and slide QA. Unused credits are returned after exact settlement.
 */
export function tiktokPlanningReserveCredits(slideCount: number, modelId = DEFAULT_ASSISTANT_MODEL_ID) {
  const normalizedSlides = Math.max(2, Math.min(35, Math.floor(slideCount) || 0));
  const selected = getAssistantModel(modelId);
  const selectedBlendedRate = selected.promptUsdPerToken * 0.75 + selected.completionUsdPerToken * 0.25;
  const baselineBlendedRate = AUTOMATION_BASELINE_PROMPT_USD_PER_TOKEN * 0.75
    + AUTOMATION_BASELINE_COMPLETION_USD_PER_TOKEN * 0.25;
  return Math.max(1, Math.ceil((6 + normalizedSlides * 3) * (selectedBlendedRate / baselineBlendedRate)));
}

export function assistantRequestReserveCredits(input: {
  modelId: string;
  inputCharacters: number;
  imageCount: number;
  maxOutputTokens?: number;
}) {
  const selected = getAssistantModel(input.modelId);
  if (!editionEconomics.assistantUsagePolicy(selected.id).metered) return 0;
  const estimatedInputTokens = Math.ceil(Math.max(0, input.inputCharacters) / 3.5) + Math.max(0, input.imageCount) * 2_500;
  const outputTokens = Math.max(256, input.maxOutputTokens || 4_096);
  const estimatedCost = estimatedInputTokens * selected.promptUsdPerToken + outputTokens * selected.completionUsdPerToken;
  return Math.max(1, providerCostToUsageUnits(estimatedCost * 1.2));
}
