import { userCanPerformAutomationAction } from "@/lib/postgres-db";
import { automationPermissions, type AutomationCapabilities, type AutomationPermission } from "@/editions/contracts/access";

const capabilityKey: Record<AutomationPermission, keyof AutomationCapabilities> = {
  "automation.run": "run",
  "automation.edit": "edit",
  "automation.publish": "publish",
  "automation.triggers.manage": "manageTriggers",
  "automation.credentials.manage": "manageCredentials",
};

export class AutomationPermissionError extends Error {
  readonly code = "AUTOMATION_PERMISSION_DENIED";
  readonly status = 403;

  constructor(readonly permission: AutomationPermission) {
    super(`This workspace role cannot perform ${permission}`);
    this.name = "AutomationPermissionError";
  }
}

export async function canPerformAutomationAction(userId: string, workspaceId: string, permission: AutomationPermission) {
  return await userCanPerformAutomationAction(userId, workspaceId, permission);
}

export async function requireAutomationPermission(userId: string, workspaceId: string, permission: AutomationPermission) {
  if (!await canPerformAutomationAction(userId, workspaceId, permission)) throw new AutomationPermissionError(permission);
}

export async function automationCapabilitiesForWorkspace(userId: string, workspaceId: string): Promise<AutomationCapabilities> {
  const allowed = await Promise.all(automationPermissions.map((permission) => canPerformAutomationAction(userId, workspaceId, permission)));
  const capabilities: AutomationCapabilities = { run: false, edit: false, publish: false, manageTriggers: false, manageCredentials: false };
  automationPermissions.forEach((permission, index) => { capabilities[capabilityKey[permission]] = allowed[index]; });
  return capabilities;
}
