"use client";

import type { UsageSummary } from "@/modules/usage/contracts";

export type AccountMenuPresentation = {
  subtitle: string;
  summaryLabel: string;
  summaryValue: string;
  meterPercent?: number;
  meterEmpty?: boolean;
};

export function accountMenuPresentation(usage: UsageSummary): AccountMenuPresentation {
  return {
    subtitle: `${usage.profileName} · Your provider keys`,
    summaryLabel: "INSTANCE",
    summaryValue: usage.profileName,
  };
}

export function AccountMenuExtension(_props: {
  usage: UsageSummary;
  workspaceId: string;
  workspaceOwner: boolean;
  onDismiss: () => void;
  onRequestView: (view: "access" | "credits") => void;
}) {
  return null;
}

export function AccountOverlayExtension(_props: {
  view: "access" | "credits" | null;
  usage: UsageSummary;
  workspaceId: string;
  userEmail: string;
  workspaceOwner: boolean;
  onClose: () => void;
  onUsageUpdated: (usage: UsageSummary) => void;
}) {
  return null;
}
