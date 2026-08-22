import type { UsageAuthority } from "./contracts";

const updatedAt = new Date(0).toISOString();
const selfhostConcurrency = Math.max(1, Number(process.env.SELFHOST_GENERATION_CONCURRENCY || 8));
const selfhostSeatLimit = Math.max(1, Number(process.env.SELFHOST_TEAM_SEATS || 100));

export const selfhostUsageAuthority: UsageAuthority = {
  async summary() {
    return {
      usageMode: "unmetered",
      profileId: "selfhosted",
      profileName: "Self-hosted",
      used: 0,
      limit: 0,
      remaining: 0,
      assistantEnabled: true,
      generationConcurrency: selfhostConcurrency,
      version: 1,
      updatedAt,
    };
  },
  async teamEntitlement() {
    return { enabled: selfhostSeatLimit > 1, policyId: "selfhosted", policyName: "Self-hosted", seatLimit: selfhostSeatLimit };
  },
  async reserveGeneration() { return true; },
  async settleGeneration() {},
  async releaseGeneration() { return false; },
  async reserveAutomation() { return true; },
  async settleAutomation(input) {
    return { chargedCredits: input.actualCredits, capped: false, settled: true };
  },
  async releaseAutomation() { return false; },
};
