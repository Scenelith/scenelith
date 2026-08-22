import type { UsageAuthority } from "./contracts";

const updatedAt = new Date(0).toISOString();
const selfhostConcurrency = Math.max(1, Number(process.env.SELFHOST_GENERATION_CONCURRENCY || 8));

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
  async reserveGeneration() { return true; },
  async settleGeneration() {},
  async releaseGeneration() { return false; },
  async reserveAutomation() { return true; },
  async settleAutomation(input) {
    return { chargedCredits: input.actualCredits, capped: false, settled: true };
  },
  async releaseAutomation() { return false; },
};
