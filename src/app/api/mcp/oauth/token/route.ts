import { exchangeMcpOAuthToken } from "@/lib/mcp/oauth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type")?.toLowerCase() || "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return Response.json({ error: "invalid_request", error_description: "Send token parameters as form data" }, { status: 415, headers: { "cache-control": "no-store" } });
  }
  return await exchangeMcpOAuthToken(new URLSearchParams(await request.text()), request);
}
export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" },
  });
}
