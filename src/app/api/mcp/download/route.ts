import { serveMcpOriginalDownload } from "@/lib/mcp/downloads";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return serveMcpOriginalDownload(request);
}
