import { NextResponse } from "next/server";
import { baseUrl } from "@/lib/auth";
import { consumeAuthToken } from "@/lib/auth-tokens";
import { db } from "@/lib/postgres-db";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") || "";
  const consumed = token.length >= 32 ? await consumeAuthToken(token, "email_verification") : null;
  if (!consumed) return NextResponse.redirect(`${baseUrl(request)}/login?error=verification_invalid`);
  const now = new Date().toISOString();
  await db.prepare("UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?")
    .run(now, now, consumed.user_id);
  return NextResponse.redirect(`${baseUrl(request)}/canvas?emailVerified=1`);
}
