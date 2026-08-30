import { baseUrl } from "@/lib/auth";

export const dynamic = "force-dynamic";

function isLoopbackHost(hostname: string) {
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || /^127(?:\.\d{1,3}){3}$/.test(hostname)
    || hostname === "0.0.0.0"
    || hostname === "[::1]"
    || hostname === "::1";
}

export async function GET(request: Request) {
  try {
    const endpoint = new URL("/api/mcp", baseUrl(request));
    const local = isLoopbackHost(endpoint.hostname);
    const mode = local ? "local" : endpoint.protocol === "https:" ? "https" : "insecure_remote";

    return Response.json({
      endpoint: endpoint.toString(),
      mode,
    }, {
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return Response.json({ error: "The MCP endpoint is not configured correctly" }, { status: 500 });
  }
}
