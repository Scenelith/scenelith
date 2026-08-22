import { selfhostUsageAuthority } from "@/modules/usage/selfhost-usage-authority";

export const editionUsage = Object.freeze({
  authority: selfhostUsageAuthority,
  async teamEntitlement(_workspaceId: string) {
    return { enabled: false, reason: "selfhost_owner_access" } as const;
  },
});
