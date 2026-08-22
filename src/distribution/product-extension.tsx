"use client";

import type { ComponentType } from "react";
import type { UserRecord, WorkspaceRecord, WorkspaceRole } from "@/lib/types";

export type ProductPanelKind = string;
export type ProductPanelFocus = { kind: ProductPanelKind; id?: string; nonce: number } | null;

export type ProductRailItem = {
  kind: ProductPanelKind;
  label: string;
  icon: ComponentType<{ size?: number }>;
};

export const productRailItems: readonly ProductRailItem[] = [];

export function ProductNotificationCenter({ onNavigate: _onNavigate }: { onNavigate: (kind: ProductPanelKind, id?: string) => void }) {
  return null;
}

export function ProductPanelRouter({
  focus: _focus,
  user: _user,
  workspace: _workspace,
  onOpenPricing: _onOpenPricing,
  onClose: _onClose,
}: {
  focus: ProductPanelFocus;
  user: UserRecord;
  workspace: WorkspaceRecord;
  onOpenPricing: () => void;
  onClose: () => void;
}) {
  return null;
}

export function PendingProductInvitations() {
  return null;
}

export function ProductAccountMenuExtension({
  user: _user,
  workspaceName: _workspaceName,
  workspaceRole: _workspaceRole,
  onOpen: _onOpen,
}: {
  user: UserRecord;
  workspaceName: string;
  workspaceRole: WorkspaceRole;
  onOpen: (kind: ProductPanelKind) => void;
}) {
  return null;
}
