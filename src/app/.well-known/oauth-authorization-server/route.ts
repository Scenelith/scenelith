import { mcpOAuthMetadata } from "@/lib/mcp/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return Response.json(mcpOAuthMetadata(request), {
    headers: { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" },
  });
}
