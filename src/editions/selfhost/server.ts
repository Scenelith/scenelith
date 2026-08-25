import type { EditionServer } from "@/editions/contracts/server";

export const editionServer: EditionServer = Object.freeze({
  authPageContext() {
    return { registrationOverride: false, registrationVariant: "default", initialEmail: "", lockEmail: false, error: "", notice: "" };
  },
  async completeRegistration() {
    return {};
  },
  authProviderSettings() {
    return {};
  },
  featureAccessDenial(kind) {
    const label = kind === "automation" ? "TikTok automation" : kind === "prompt" ? "Prompt tools" : "Assistant tools";
    return { status: 403, body: { error: `${label} are disabled for this instance`, code: "FEATURE_DISABLED" } };
  },
  operationsQueueProjectionSql: "",
  async recoveryDrillStatus() {
    return null;
  },
});
