import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { decideMcpOAuthConsent, mcpScopes, type McpScope } from "@/lib/mcp/oauth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const form = await request.formData();
  const requestId = String(form.get("request_id") || "");
  const allow = form.get("decision") === "allow";
  const workspaceId = String(form.get("workspace_id") || "") || null;
  const projectIds = form.getAll("project_id").map(String).filter(Boolean);
  const restrictToProjects = form.get("canvas_access") === "specific";
  const libraryAccess = form.get("library_access") === "true";
  const scopes = form.getAll("scope").map(String).filter((scope): scope is McpScope => mcpScopes.includes(scope as McpScope));
  if (!requestId) return Response.json({ error: "Authorization request is required" }, { status: 400 });
  try {
    const destination = await decideMcpOAuthConsent({ userId: auth.user.id, requestId, allow, workspaceId, projectIds, restrictToProjects, libraryAccess, scopes });
    if (request.headers.get("accept")?.includes("application/json")) {
      return Response.json({ redirectTo: destination }, { headers: { "cache-control": "no-store" } });
    }
    return Response.redirect(destination, 303);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Authorization could not be completed" }, { status: 400, headers: { "cache-control": "no-store" } });
  }
}
