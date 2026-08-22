export type UsageSummary = {
  usageMode: "metered" | "unmetered";
  profileId: string;
  profileName: string;
  used: number;
  limit: number;
  remaining: number;
  assistantEnabled: boolean;
  generationConcurrency: number;
  version: number;
  updatedAt: string;
};

export type GenerationUsageReservation = {
  generationId: string;
  workspaceId: string;
  userId: string;
  credits: number;
  metadata?: Record<string, unknown>;
};

export type AutomationUsageReservation = {
  reservationId: string;
  workspaceId: string;
  userId: string;
  kind: string;
  credits: number;
  metadata?: Record<string, unknown>;
};

export type AutomationUsageSettlement = {
  reservationId: string;
  actualCredits: number;
  actualCostUsd: number;
  metadata?: Record<string, unknown>;
};

export interface UsageAuthority {
  summary(workspaceId: string): Promise<UsageSummary>;
  reserveGeneration(input: GenerationUsageReservation): Promise<boolean>;
  settleGeneration(generationId: string): Promise<void>;
  releaseGeneration(generationId: string, reason: string): Promise<boolean>;
  reserveAutomation(input: AutomationUsageReservation): Promise<boolean>;
  settleAutomation(input: AutomationUsageSettlement): Promise<{ chargedCredits: number; capped: boolean; settled: boolean }>;
  releaseAutomation(reservationId: string, reason: string, metadata?: Record<string, unknown>): Promise<boolean>;
}
