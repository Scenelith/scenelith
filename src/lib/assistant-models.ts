import { providerCostToUsageUnits } from "@/distribution/usage-economics";
import { assistantUsagePolicy } from "@/distribution/assistant-usage-policy";

export const DEFAULT_ASSISTANT_MODEL_ID = "google/gemini-3.7-flash";

const LEGACY_ASSISTANT_MODEL_IDS = new Set([
  "google/gemini-3.1-flash-lite",
  "google/gemini-3.1-flash-lite-preview",
  "google/gemini-3.5-flash-lite",
  "google/gemini-3.5-flash-lite-preview",
]);

export type AssistantModelOption = {
  id: string;
  label: string;
  provider: string;
  promptUsdPerToken: number;
  completionUsdPerToken: number;
  supportsVision: boolean;
};

/**
 * Prices mirror OpenRouter's model catalogue. They are used only for the
 * up-front reserve and UI estimate. Final accounting starts from usage.cost on
 * the completed provider response.
 */
export const assistantModels = [
  { id: DEFAULT_ASSISTANT_MODEL_ID, label: "Gemini 3.7 Flash", provider: "Google", promptUsdPerToken: 0.000000375, completionUsdPerToken: 0.000001875, supportsVision: true },
  { id: "qwen/qwen3.8-max", label: "Qwen 3.8 Max", provider: "Qwen", promptUsdPerToken: 0.000002, completionUsdPerToken: 0.000006, supportsVision: true },
  { id: "qwen/qwen3.7-flash", label: "Qwen 3.7 Flash", provider: "Qwen", promptUsdPerToken: 0.00000003, completionUsdPerToken: 0.00000013, supportsVision: true },
  { id: "google/gemini-3.6-flash", label: "Gemini 3.6 Flash", provider: "Google", promptUsdPerToken: 0.0000015, completionUsdPerToken: 0.0000075, supportsVision: true },
  { id: "moonshotai/kimi-k3", label: "Kimi K3", provider: "Moonshot AI", promptUsdPerToken: 0.000003, completionUsdPerToken: 0.000015, supportsVision: true },
  { id: "openai/gpt-5.6-luna-pro", label: "GPT-5.6 Luna Pro", provider: "OpenAI", promptUsdPerToken: 0.0000001, completionUsdPerToken: 0.0000006, supportsVision: true },
  { id: "openai/gpt-5.6-terra-pro", label: "GPT-5.6 Terra Pro", provider: "OpenAI", promptUsdPerToken: 0.000001, completionUsdPerToken: 0.000006, supportsVision: true },
  { id: "openai/gpt-5.6-sol-pro", label: "GPT-5.6 Sol Pro", provider: "OpenAI", promptUsdPerToken: 0.000005, completionUsdPerToken: 0.00003, supportsVision: true },
  { id: "x-ai/grok-4.5", label: "Grok 4.5", provider: "xAI", promptUsdPerToken: 0.000002, completionUsdPerToken: 0.000006, supportsVision: true },
  { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5", provider: "Anthropic", promptUsdPerToken: 0.000002, completionUsdPerToken: 0.00001, supportsVision: true },
  { id: "z-ai/glm-5.2", label: "GLM 5.2", provider: "Z.ai", promptUsdPerToken: 0.00000007, completionUsdPerToken: 0.00000022, supportsVision: false },
] as const satisfies readonly AssistantModelOption[];

export const tiktokAutomationPlanningModels = assistantModels.filter((model) => (
  model.supportsVision && model.id.startsWith("google/gemini-3")
));

export function normalizeAssistantModelId(modelId?: string | null) {
  if (!modelId || LEGACY_ASSISTANT_MODEL_IDS.has(modelId)) return DEFAULT_ASSISTANT_MODEL_ID;
  return modelId;
}

export function getAssistantModel(modelId?: string | null) {
  const normalizedModelId = normalizeAssistantModelId(modelId);
  const selected = assistantModels.find((model) => model.id === normalizedModelId);
  if (selected) return selected;
  throw new Error("Assistant model is not available");
}

export function getTikTokAutomationPlanningModel(modelId?: string | null) {
  const normalizedModelId = normalizeAssistantModelId(modelId);
  const selected = tiktokAutomationPlanningModels.find((model) => model.id === normalizedModelId);
  if (selected) return selected;
  throw new Error("Planning model is not available for TikTok automation");
}

export function assistantModelEstimatedCredits(model: AssistantModelOption, input: {
  inputCharacters?: number;
  imageCount?: number;
  outputTokens?: number;
} = {}) {
  if (!assistantUsagePolicy(model.id).metered) return 0;
  const inputTokens = Math.ceil(Math.max(0, input.inputCharacters ?? 6_000) / 3.5)
    + Math.max(0, input.imageCount || 0) * 2_500;
  const outputTokens = Math.max(256, input.outputTokens ?? 1_200);
  const providerCost = inputTokens * model.promptUsdPerToken + outputTokens * model.completionUsdPerToken;
  return Math.max(1, providerCostToUsageUnits(providerCost));
}

export function assistantModelCreditDescription(model: AssistantModelOption, input: {
  inputCharacters?: number;
  imageCount?: number;
  outputTokens?: number;
} = {}) {
  const policy = assistantUsagePolicy(model.id);
  if (!policy.metered) return policy.description;
  const credits = assistantModelEstimatedCredits(model, input);
  return `≈ ${credits.toLocaleString("en-US")} credit${credits === 1 ? "" : "s"}`;
}
