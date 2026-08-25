import type { UserRecord } from "@/lib/types";

export type AuthSearchParams = {
  [key: string]: string | string[] | undefined;
};

export type AuthPageContext = {
  registrationOverride: boolean;
  registrationVariant: string;
  initialEmail: string;
  lockEmail: boolean;
  error: string;
  notice: string;
};

export type FeatureAccessKind = "assistant" | "prompt" | "automation";
export type FeatureAccessDenial = {
  status: number;
  body: { error: string; code: string; accountView?: string };
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
