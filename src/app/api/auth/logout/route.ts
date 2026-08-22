import { NextResponse } from "next/server";
import { revokeCurrentSession, sameOriginRequest, SESSION_COOKIE } from "@/lib/auth";

export async function POST(request: Request) {
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  await revokeCurrentSession();
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
