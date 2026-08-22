import { editionUsage } from "@/editions/current/usage";
import type { UsageAuthority } from "@/modules/usage/contracts";

export type { UsageAuthority, UsageSummary } from "@/modules/usage/contracts";

export async function usageAuthority(): Promise<UsageAuthority> {
  return editionUsage.authority;
}

export async function usageSummary(workspaceId: string) {
  return await editionUsage.authority.summary(workspaceId);
}

export async function teamUsageEntitlement(workspaceId: string) {
  return await editionUsage.teamEntitlement(workspaceId);
}
