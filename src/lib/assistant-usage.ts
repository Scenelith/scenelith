import { randomUUID } from "node:crypto";
import { usageAuthority } from "@/modules/usage";
import { assistantRequestReserveCredits, providerCostToUsageUnits } from "./automation-pricing";
import { getAssistantModel } from "./assistant-models";
import { createOpenRouterUsageTracker, summarizeOpenRouterUsage, withOpenRouterModel, withOpenRouterUsage } from "./openrouter";
import { assistantUsagePolicy } from "@/distribution/assistant-usage-policy";

export class AssistantCreditError extends Error {
  status = 402;
  code = "INSUFFICIENT_CREDITS";
  constructor(public requiredCredits: number) {
    super(`This model needs up to ${requiredCredits} credits for this request`);
  }
}

export async function runAssistantUsage<T>(input: {
  modelId: string;
  workspaceId: string;
  userId: string;
  kind: string;
  inputCharacters: number;
  imageCount: number;
  maxOutputTokens?: number;
  run: () => Promise<T>;
}) {
  const selected = getAssistantModel(input.modelId);
  const tracker = createOpenRouterUsageTracker();
  const execute = () => withOpenRouterUsage(tracker, () => withOpenRouterModel(selected.id, input.run));
  if (!assistantUsagePolicy(selected.id).metered) {
    const result = await execute();
    return { result, chargedCredits: 0, costUsd: summarizeOpenRouterUsage(tracker).costUsd };
  }

  const reservationId = randomUUID();
  const reserveCredits = assistantRequestReserveCredits(input);
  const authority = await usageAuthority();
  const reserved = await authority.reserveAutomation({
    reservationId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    kind: input.kind,
    credits: reserveCredits,
    metadata: { modelId: selected.id, inputCharacters: input.inputCharacters, imageCount: input.imageCount },
  });
  if (!reserved) throw new AssistantCreditError(reserveCredits);

  try {
    const result = await execute();
    const providerUsage = summarizeOpenRouterUsage(tracker);
    const settlement = await authority.settleAutomation({
      reservationId,
      actualCredits: providerCostToUsageUnits(providerUsage.costUsd),
      actualCostUsd: providerUsage.costUsd,
      metadata: { modelId: selected.id, requestCount: providerUsage.requestCount, promptTokens: providerUsage.promptTokens, completionTokens: providerUsage.completionTokens, totalTokens: providerUsage.totalTokens, usageEntries: tracker.entries },
    });
    return { result, chargedCredits: settlement.chargedCredits, costUsd: providerUsage.costUsd };
  } catch (error) {
    await authority.releaseAutomation(reservationId, "assistant_failed", { modelId: selected.id });
    throw error;
  }
}
