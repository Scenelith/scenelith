import type { WorkspaceRole } from "@/lib/types";

export const automationPermissions = [
  "automation.run",
  "automation.edit",
  "automation.publish",
  "automation.triggers.manage",
  "automation.credentials.manage",
] as const;

export type AutomationPermission = (typeof automationPermissions)[number];

export type AutomationCapabilities = {
  run: boolean;
  edit: boolean;
  publish: boolean;
  manageTriggers: boolean;
  manageCredentials: boolean;
};

export interface WorkspaceAccess {
  listAccessibleWorkspaceRows(userId: string): Promise<Record<string, unknown>[]>;
  listAccessibleProjectRows(userId: string): Promise<Record<string, unknown>[]>;
  canUserCreateWorkspace(userId: string): Promise<boolean>;
  workspaceRoleForUser(userId: string, workspaceId: string): Promise<WorkspaceRole | null>;
  userCanManageWorkspace(userId: string, workspaceId: string): Promise<boolean>;
  userCanAccessWorkspace(userId: string, workspaceId: string): Promise<boolean>;
  userCanAccessProject(userId: string, projectId: string): Promise<boolean>;
  userCanPerformAutomationAction(userId: string, workspaceId: string, permission: AutomationPermission): Promise<boolean>;
  usageWorkspaceForUserProject(userId: string, projectId: string): Promise<string | null>;
  usageWorkspaceForUserWorkspace(userId: string, workspaceId: string): Promise<string | null>;
}
