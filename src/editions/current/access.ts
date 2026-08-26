export { editionWorkspaceAccess } from "@/editions/selfhost/access";

import { editionWorkspaceAccess } from "@/editions/selfhost/access";

export const listAccessibleWorkspaceRows = editionWorkspaceAccess.listAccessibleWorkspaceRows.bind(editionWorkspaceAccess);
export const listAccessibleProjectRows = editionWorkspaceAccess.listAccessibleProjectRows.bind(editionWorkspaceAccess);
export const canUserCreateWorkspace = editionWorkspaceAccess.canUserCreateWorkspace.bind(editionWorkspaceAccess);
export const workspaceRoleForUser = editionWorkspaceAccess.workspaceRoleForUser.bind(editionWorkspaceAccess);
export const userCanManageWorkspace = editionWorkspaceAccess.userCanManageWorkspace.bind(editionWorkspaceAccess);
export const userCanAccessWorkspace = editionWorkspaceAccess.userCanAccessWorkspace.bind(editionWorkspaceAccess);
export const userCanAccessProject = editionWorkspaceAccess.userCanAccessProject.bind(editionWorkspaceAccess);
export const userCanPerformAutomationAction = editionWorkspaceAccess.userCanPerformAutomationAction.bind(editionWorkspaceAccess);
export const usageWorkspaceForUserProject = editionWorkspaceAccess.usageWorkspaceForUserProject.bind(editionWorkspaceAccess);
export const usageWorkspaceForUserWorkspace = editionWorkspaceAccess.usageWorkspaceForUserWorkspace.bind(editionWorkspaceAccess);
