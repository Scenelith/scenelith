import { NextResponse } from "next/server";
import { requireApiUser, revokeCurrentSession, sameOriginRequest, SESSION_COOKIE } from "@/lib/auth";
import { switchMcpOAuthAccount } from "@/lib/mcp/oauth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const body = await request.json().catch(() => null);
  if (typeof body?.requestId !== "string") return Response.json({ error: "Connection request is required" }, { status: 400 });
  try {
    const redirectTo = await switchMcpOAuthAccount(auth.user.id, body.requestId);
    await revokeCurrentSession();
    const response = NextResponse.json({ redirectTo }, { headers: { "cache-control": "no-store" } });
    response.cookies.delete(SESSION_COOKIE);
    return response;
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not switch accounts" }, { status: 400, headers: { "cache-control": "no-store" } });
  }
}
