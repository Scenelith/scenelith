import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { baseUrl } from "@/lib/auth";
import {
  authenticateMcpBearer,
  mcpProtectedResourceMetadataUrl,
  mcpScopes,
  type McpPrincipal,
} from "@/lib/mcp/oauth";
import { createScenelithMcpServer } from "@/lib/mcp/server";
import { enforceDistributedRateLimit } from "@/lib/distributed-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = createMcpHandler((context) => {
  const principal = context.authInfo?.extra?.principal;
  const origin = String(context.authInfo?.extra?.origin || "http://localhost:3000");
  if (!principal || typeof principal !== "object") throw new Error("MCP authentication context is missing");
  return createScenelithMcpServer(principal as McpPrincipal, origin);
}, {
  legacy: "stateless",
  responseMode: "auto",
  onerror: (error) => console.error("MCP request failed", error),
});

function unauthorized(request: Request) {
  return Response.json({ error: "Connect Scenelith through OAuth before using this MCP endpoint" }, {
    status: 401,
    headers: {
      "www-authenticate": `Bearer realm="Scenelith MCP", resource_metadata="${mcpProtectedResourceMetadataUrl(request)}", scope="${mcpScopes.join(" ")}"`,
      "cache-control": "no-store",
      vary: "Authorization",
    },
  });
}

async function serve(request: Request) {
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin && requestOrigin !== new URL(baseUrl(request)).origin) {
    return Response.json({ error: "Invalid request origin" }, { status: 403, headers: { "cache-control": "no-store" } });
  }
  const principal = await authenticateMcpBearer(request);
  if (!principal || !principal.scopes.includes("mcp:read")) return unauthorized(request);
  const limited = await enforceDistributedRateLimit({ scope: "mcp-request", identity: principal.connectionId, limit: 300, windowSeconds: 60 });
  if (limited) return limited;
  const authInfo: AuthInfo = {
    token: `mcp-connection:${principal.connectionId}`,
    clientId: principal.clientId,
    scopes: principal.scopes,
    expiresAt: Math.floor(Date.parse(principal.expiresAt) / 1000),
    resource: new URL(principal.resource),
    extra: { principal, origin: baseUrl(request) },
  };
  const response = await handler.fetch(request, { authInfo });
  response.headers.set("cache-control", "no-store");
  response.headers.set("vary", "Authorization");
  return response;
}

export const GET = serve;
export const POST = serve;
export const DELETE = serve;
