import type { UserRecord } from "@/lib/types";

export type AuthSearchParams = {
  email?: string;
  error?: string;
  invite?: string;
  reset?: string;
};

export type AuthPageContext = {
  invitationRegistration: boolean;
  initialEmail: string;
  error: string;
  notice: string;
};

export type AssistantUsagePolicy = {
  metered: boolean;
  description: string;
};

export type FeatureAccessKind = "assistant" | "prompt" | "automation";
export type FeatureAccessDenial = {
  status: number;
  body: { error: string; code: string; accountView?: "access" };
};

export type EditionServer = Readonly<{
  authPageContext(params: AuthSearchParams): AuthPageContext;
  completeRegistration(user: UserRecord): Promise<Record<string, unknown>>;
  authProviderSettings(): Record<string, unknown>;
  assistantUsagePolicy(modelId: string): AssistantUsagePolicy;
  featureAccessDenial(kind: FeatureAccessKind): FeatureAccessDenial;
  providerCostToUsageUnits(costUsd: number): number;
  operationsQueueProjectionSql: string;
}>;
