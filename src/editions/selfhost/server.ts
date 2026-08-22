import type { EditionServer } from "@/editions/contracts/server";

const providerUsdPerUsageUnit = 0.01;

export const editionServer: EditionServer = Object.freeze({
  authPageContext() {
    return { invitationRegistration: false, initialEmail: "", error: "", notice: "" };
  },
  async completeRegistration() {
    return {};
  },
  authProviderSettings() {
    return {};
  },
  assistantUsagePolicy() {
    return { metered: false, description: "Provider-billed" };
  },
  featureAccessDenial(kind) {
    const label = kind === "automation" ? "TikTok automation" : kind === "prompt" ? "Prompt tools" : "Assistant tools";
    return { status: 403, body: { error: `${label} are disabled for this instance`, code: "FEATURE_DISABLED" } };
  },
  providerCostToUsageUnits(costUsd) {
    if (!Number.isFinite(costUsd) || costUsd <= 0) return 0;
    return Math.ceil((costUsd - Number.EPSILON) / providerUsdPerUsageUnit);
  },
  operationsQueueProjectionSql: "",
});
