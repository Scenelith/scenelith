import { NextResponse, type NextRequest } from "next/server";

export function handleEditionRequest(request: NextRequest) {
  if (request.nextUrl.pathname === "/") return NextResponse.redirect(new URL("/canvas", request.url));
  return NextResponse.next();
}
