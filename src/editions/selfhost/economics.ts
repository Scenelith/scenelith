import type { EditionEconomics } from "@/editions/contracts/economics";

const providerUsdPerUsageUnit = 0.01;

export const editionEconomics: EditionEconomics = Object.freeze({
  assistantUsagePolicy() {
    return { metered: false, description: "Provider-billed" };
  },
  providerCostToUsageUnits(costUsd) {
    if (!Number.isFinite(costUsd) || costUsd <= 0) return 0;
    return Math.ceil((costUsd - Number.EPSILON) / providerUsdPerUsageUnit);
  },
});
