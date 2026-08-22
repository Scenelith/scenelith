import type { UserRecord } from "@/lib/types";

export type DistributionAuthSearchParams = {
  email?: string;
  error?: string;
  invite?: string;
  reset?: string;
};

export function distributionAuthPageContext(_params: DistributionAuthSearchParams) {
  return {
    invitationRegistration: false,
    initialEmail: "",
    error: "",
    notice: "",
  };
}

export async function completeDistributionRegistration(
  _user: UserRecord,
): Promise<Record<string, never>> {
  return {};
}

export function distributionAuthProviderSettings(): Record<string, never> {
  return {};
}
