import { createHash } from "node:crypto";
import { enforceDistributedRateLimit } from "@/lib/distributed-rate-limit";
import { registerMcpOAuthClient } from "@/lib/mcp/oauth";

export const runtime = "nodejs";

function caller(request: Request) {
  const address = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  return createHash("sha256").update(address).digest("hex");
}
export async function POST(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return Response.json({ error: "invalid_client_metadata", error_description: "Send client metadata as JSON" }, { status: 415 });
  }
  const limited = await enforceDistributedRateLimit({ scope: "mcp-oauth-register", identity: caller(request), limit: 30, windowSeconds: 600 });
  if (limited) return limited;
  return await registerMcpOAuthClient(await request.json().catch(() => null));
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" },
  });
}
