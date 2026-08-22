import type { NextRequest } from "next/server";
import { handleEditionRequest } from "@/editions/current/edge";

export function proxy(request: NextRequest) {
  return handleEditionRequest(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
