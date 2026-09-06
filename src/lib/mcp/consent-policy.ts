import type { AutomationCapabilities } from "@/editions/contracts/access";
import type { McpScope } from "@/lib/mcp/oauth";

export type McpConsentWorkspace = {
  id: string;
  name: string;
  role: "owner" | "member" | null;
  automation: AutomationCapabilities;
};

// Shared by consent rendering and approval. Edition adapters supply the live
// role policy; selecting an OAuth scope can only narrow that policy.
export function availableMcpConsentScopes(requested: readonly McpScope[], workspaces: McpConsentWorkspace[]) {
  return requested.filter((scope) => {
    if (scope === "mcp:read") return true;
    if (!workspaces.length) return false;
    if (scope === "automation:credentials") return workspaces.some((workspace) => workspace.automation.manageCredentials);
    if (scope === "automation:run") return workspaces.some((workspace) => workspace.automation.run);
    if (scope === "automation:write") return workspaces.some((workspace) => workspace.automation.edit || workspace.automation.publish || workspace.automation.manageTriggers);
    return true;
  });
}

export function mcpConsentPermissionCopy(scope: McpScope, workspaces: McpConsentWorkspace[]) {
  const allOwners = workspaces.length > 0 && workspaces.every((workspace) => workspace.role === "owner");
  const allPublish = workspaces.length > 0 && workspaces.every((workspace) => workspace.automation.publish);
  const somePublish = workspaces.some((workspace) => workspace.automation.publish);
  const copy: Record<McpScope, { title: string; detail: string }> = {
    "mcp:read": { title: "View creative resources", detail: "Read accessible canvases, media, identities and workflow history." },
    "canvas:write": { title: "Edit canvases", detail: allOwners ? "Create canvases and edit their nodes and connections." : "Edit nodes and connections in canvases you can access. Creating canvases requires an owner role." },
    "assistant:run": { title: "Run assistants", detail: "Build prompts and run Assistant nodes. May use credits." },
    "generation:run": { title: "Generate and edit media", detail: "Create images and videos, or edit existing images. May use credits." },
    "library:write": { title: "Add media to Library", detail: "Upload images and videos to accessible canvas Libraries." },
    "import:write": { title: "Import external media", detail: "Import TikTok posts into accessible canvases and their Libraries." },
    "identity:write": { title: "Manage identities", detail: "Create and update reusable identities using approved Library images." },
    "automation:write": { title: "Edit automations", detail: allPublish ? "Create, edit and publish workflows where your role permits." : somePublish ? "Edit workflows. Publishing is available only in workspaces where your role permits it." : "Create and edit workflow drafts. Publishing and trigger management stay with the owner." },
    "automation:credentials": { title: "Connect automation credentials", detail: "Use saved workspace credentials. Secret values stay private." },
    "automation:run": { title: "Run automations", detail: "Start or stop permitted workflow runs. May use credits." },
  };
  return copy[scope];
}
