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

export type FeatureAccessKind = "assistant" | "prompt" | "automation";
export type FeatureAccessDenial = {
  status: number;
  body: { error: string; code: string; accountView?: "access" };
};

export type RecoveryDrillStatus = Readonly<{
  healthy: boolean;
  completedAtUnixSeconds: number | null;
  ageSeconds: number | null;
  recoveryPointAgeSeconds: number | null;
  recoveryTimeSeconds: number | null;
}>;

export type EditionServer = Readonly<{
  authPageContext(params: AuthSearchParams): AuthPageContext;
  completeRegistration(user: UserRecord): Promise<Record<string, unknown>>;
  authProviderSettings(): Record<string, unknown>;
  featureAccessDenial(kind: FeatureAccessKind): FeatureAccessDenial;
  operationsQueueProjectionSql: string;
  recoveryDrillStatus(): Promise<RecoveryDrillStatus | null>;
}>;
