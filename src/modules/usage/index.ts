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

/** Reporting must never turn an accepted generation into a failed/retried request. */
export async function taskCreditUsage(tasks: import("./contracts").UsageTaskReference[]) {
  if (!tasks.length || !editionUsage.authority.taskCreditUsage) return {};
  try {
    return await editionUsage.authority.taskCreditUsage(tasks);
  } catch {
    console.error("[usage:task-report-unavailable]");
    return {};
  }
}
