/**
 * Provider costs are normalized into whole usage units for admission and queue
 * estimates. Self-hosted instances never charge these units; the conversion is
 * intentionally neutral and contains no commercial pricing policy.
 */
export const PROVIDER_USD_PER_USAGE_UNIT = 0.01;

export function providerCostToUsageUnits(costUsd: number) {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return 0;
  return Math.ceil((costUsd - Number.EPSILON) / PROVIDER_USD_PER_USAGE_UNIT);
}
