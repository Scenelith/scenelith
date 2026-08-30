import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { listMcpOAuthConnections, revokeMcpOAuthConnection } from "@/lib/mcp/oauth";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  return Response.json({ connections: await listMcpOAuthConnections(auth.user.id) }, { headers: { "cache-control": "no-store" } });
}
export async function DELETE(request: Request) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const connectionId = String((await request.json().catch(() => null) as { connectionId?: unknown } | null)?.connectionId || "");
  if (!connectionId) return Response.json({ error: "Connection is required" }, { status: 400 });
  if (!await revokeMcpOAuthConnection(auth.user.id, connectionId)) return Response.json({ error: "Connection not found" }, { status: 404 });
  return Response.json({ revoked: true });
}
