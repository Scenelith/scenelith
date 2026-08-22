import { selfhostUsageAuthority } from "@/modules/usage/selfhost-usage-authority";
import type { UsageAuthority } from "@/modules/usage/contracts";

export type { UsageAuthority, UsageSummary } from "@/modules/usage/contracts";

export async function usageAuthority(): Promise<UsageAuthority> {
  return selfhostUsageAuthority;
}

export async function usageSummary(workspaceId: string) {
  return await selfhostUsageAuthority.summary(workspaceId);
}
