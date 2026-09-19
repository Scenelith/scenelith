import { randomUUID } from "node:crypto";
import { usageAuthority } from "@/modules/usage";
import { assistantRequestReserveCredits, providerCostToUsageUnits } from "./automation-pricing";
import { getAssistantModel } from "./assistant-models";
import { createOpenRouterUsageTracker, summarizeOpenRouterUsage, withOpenRouterModel, withOpenRouterSignal, withOpenRouterUsage, withOpenRouterOutputLimit, openRouterUsagePending } from "./openrouter";
import { db } from "./postgres-db";
import { editionEconomics } from "@/editions/current/economics";

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
  signal?: AbortSignal;
  nodeRunId?: string;
  budget?: {
    reserve: (credits: number) => Promise<string | null>;
    settle: (reservationId: string | null, actualCredits: number) => Promise<void>;
    release: (reservationId: string | null) => Promise<void>;
  };
  run: () => Promise<T>;
}) {
  const selected = getAssistantModel(input.modelId);
  const tracker = createOpenRouterUsageTracker();
  const metered = editionEconomics.assistantUsagePolicy(selected.id).metered;
  const authority = await usageAuthority();
  const reservationId = randomUUID();
  const reserveCredits = assistantRequestReserveCredits(input);
  const budgetReservationId = metered ? await input.budget?.reserve(reserveCredits) ?? null : null;
  const metadata = { modelId: selected.id, nodeRunId: input.nodeRunId, budgetReservationId, accountingVersion: 1 };
  if (metered) {
    let reserved = false;
    try {
      reserved = await authority.reserveAutomation({
        reservationId, workspaceId: input.workspaceId, userId: input.userId, kind: input.kind,
        credits: reserveCredits, metadata: { ...metadata, providerRequestPending: false, inputCharacters: input.inputCharacters, imageCount: input.imageCount },
      });
    } catch (error) {
      await input.budget?.release(budgetReservationId);
      throw error;
    }
    if (!reserved) {
      await input.budget?.release(budgetReservationId);
      throw new AssistantCreditError(reserveCredits);
    }
  }
  const usageSnapshot = (chargedCredits = 0, settled = false) => ({
    ...summarizeOpenRouterUsage(tracker), chargedCredits,
    status: !settled || openRouterUsagePending(tracker) ? "pending" as const : "confirmed" as const,
    entries: tracker.entries,
  });
  const persistNodeUsage = async (usage: ReturnType<typeof usageSnapshot>) => {
    if (input.nodeRunId) await db.prepare("UPDATE automation_node_runs SET provider_usage_json = ?, charged_credits = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(usage), usage.chargedCredits, new Date().toISOString(), input.nodeRunId);
  };
  tracker.checkpoint = async () => {
    const usage = usageSnapshot();
    await db.transaction(async () => {
      if (metered) await authority.checkpointAutomation?.(reservationId, {
        ...metadata, providerRequestPending: openRouterUsagePending(tracker), pendingRequestCount: tracker.pendingRequests, providerUsage: usage, usageEntries: tracker.entries,
      });
      await persistNodeUsage(usage);
    })();
  };
  const settle = async () => {
    const usage = usageSnapshot();
    try { return await db.transaction(async () => {
      const settlement = metered ? await authority.settleAutomation({
        reservationId, actualCredits: providerCostToUsageUnits(usage.costUsd), actualCostUsd: usage.costUsd,
        metadata: { ...metadata, ...summarizeOpenRouterUsage(tracker), usageEntries: tracker.entries, providerRequestPending: false },
      }) : { chargedCredits: 0 };
      const settledUsage = usageSnapshot(settlement.chargedCredits, true);
      await input.budget?.settle(budgetReservationId, settlement.chargedCredits);
      await persistNodeUsage(settledUsage);
      return settledUsage;
    })(); } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        code: "PROVIDER_USAGE_PENDING", automationRetryable: false, automationUsage: usageSnapshot(),
      });
    }
  };
  let result: T;
  try {
    result = await withOpenRouterUsage(tracker, () => withOpenRouterModel(selected.id, () =>
      withOpenRouterOutputLimit(input.maxOutputTokens || 4_096, () => withOpenRouterSignal(input.signal, input.run))));
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (openRouterUsagePending(tracker)) {
      // Transport loss is not proof of zero spend. Preserve authorization and
      // the durable receipt for reconciliation, and prohibit automatic retries.
      Object.assign(failure, { code: "PROVIDER_USAGE_PENDING", automationRetryable: false, automationUsage: usageSnapshot() });
      throw failure;
    }
    // Parsing/schema/provider errors can occur after paid inference.
    const usage = await settle();
    Object.assign(failure, { automationUsage: usage });
    throw failure;
  }
  // Settlement errors must never enter the provider-error refund path.
  const usage = await settle();
  return { result, chargedCredits: usage.chargedCredits, costUsd: usage.costUsd, usage };
}
