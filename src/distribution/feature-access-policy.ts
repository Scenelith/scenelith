export type FeatureAccessKind = "assistant" | "prompt" | "automation";

export type FeatureAccessDenial = {
  status: number;
  body: { error: string; code: string; accountView?: "access" };
};

export function featureAccessDenial(kind: FeatureAccessKind): FeatureAccessDenial {
  const label = kind === "automation" ? "TikTok automation" : kind === "prompt" ? "Prompt tools" : "Assistant tools";
  return { status: 403, body: { error: `${label} are disabled for this instance`, code: "FEATURE_DISABLED" } };
}
