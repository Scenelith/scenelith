import type { WorkspaceRole } from "@/lib/types";

export interface WorkspaceAccess {
  listAccessibleWorkspaceRows(userId: string): Promise<Record<string, unknown>[]>;
  listAccessibleProjectRows(userId: string): Promise<Record<string, unknown>[]>;
  canUserCreateWorkspace(userId: string): Promise<boolean>;
  workspaceRoleForUser(userId: string, workspaceId: string): Promise<WorkspaceRole | null>;
  userCanManageWorkspace(userId: string, workspaceId: string): Promise<boolean>;
  userCanAccessWorkspace(userId: string, workspaceId: string): Promise<boolean>;
  userCanAccessProject(userId: string, projectId: string): Promise<boolean>;
  usageWorkspaceForUserProject(userId: string, projectId: string): Promise<string | null>;
  usageWorkspaceForUserWorkspace(userId: string, workspaceId: string): Promise<string | null>;
}
