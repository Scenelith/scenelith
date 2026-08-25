import type { ComponentType } from "react";
import type { UsageSummary } from "@/modules/usage/contracts";
import type { UserRecord, WorkspaceRecord, WorkspaceRole } from "@/lib/types";

export type AccountMenuPresentation = {
  subtitle: string;
  summaryLabel: string;
  summaryValue: string;
  meterPercent?: number;
  meterEmpty?: boolean;
};

export type ProductPanelKind = string;
export type EditionView = string;
export type ProductPanelFocus = { kind: ProductPanelKind; id?: string; nonce: number } | null;
export type ProductRailItem = {
  kind: ProductPanelKind;
  label: string;
  icon: ComponentType<{ size?: number }>;
};

export type AccountMenuExtensionProps = {
  usage: UsageSummary;
  workspaceId: string;
  workspaceOwner: boolean;
  onDismiss: () => void;
  onRequestView: (view: EditionView) => void;
};

export type AccountOverlayExtensionProps = {
  view: EditionView | null;
  usage: UsageSummary;
  workspaceId: string;
  userEmail: string;
  workspaceOwner: boolean;
  onClose: () => void;
  onUsageUpdated: (usage: UsageSummary) => void;
};

export type ProductPanelRouterProps = {
  focus: ProductPanelFocus;
  user: UserRecord;
  workspace: WorkspaceRecord;
  onRequestAccountView: (view: EditionView) => void;
  onClose: () => void;
};

export type ProductAccountMenuExtensionProps = {
  user: UserRecord;
  workspaceName: string;
  workspaceRole: WorkspaceRole;
  onOpen: (kind: ProductPanelKind) => void;
};

export type RegistrationConsentProps = {
  accepted: boolean;
  onAcceptedChange: (accepted: boolean) => void;
};

export type EditionClient = Readonly<{
  authPreviewMedia(asset: string): string;
  accountMenuPresentation(usage: UsageSummary): AccountMenuPresentation;
  AccountMenuExtension?: ComponentType<AccountMenuExtensionProps>;
  AccountOverlayExtension?: ComponentType<AccountOverlayExtensionProps>;
  registrationCopy(variant: string): {
    title: string;
    lead: string;
    emailLabel: string;
    submitLabel: string;
    hideSocialRegistration: boolean;
  };
  AuthRecoveryLink?: ComponentType;
  RegistrationConsent?: ComponentType<RegistrationConsentProps>;
  railItems: readonly ProductRailItem[];
  NotificationCenter?: ComponentType<{ onNavigate: (kind: ProductPanelKind, id?: string) => void }>;
  PanelRouter?: ComponentType<ProductPanelRouterProps>;
  WorkspaceNotice?: ComponentType;
  ProductAccountMenuExtension?: ComponentType<ProductAccountMenuExtensionProps>;
}>;
