export type AssistantUsagePolicy = {
  metered: boolean;
  description: string;
};

export type EditionEconomics = Readonly<{
  assistantUsagePolicy(modelId: string): AssistantUsagePolicy;
  providerCostToUsageUnits(costUsd: number): number;
}>;
