import { compare } from "bcryptjs";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  attachSessionCookie,
  attachLastAuthMethodCookie,
  authRateLimitKey,
  authRateLimitStatus,
  clearAuthFailures,
  createSession,
  normalizeEmail,
  recordAuthFailure,
  sameOriginRequest,
} from "@/lib/auth";
import { db, rowToUser } from "@/lib/postgres-db";

export const runtime = "nodejs";

const schema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(128),
});
// Keep unknown-email attempts on the same expensive bcrypt path as real users.
const dummyHash = "$2b$12$wSagpdGYlnhulrwk5FtQDuGVWK6LvADy2G6.v361wMNPCVVT5.pgi";

export async function POST(request: Request) {
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Enter a valid email and password" }, { status: 400 });
  const email = normalizeEmail(parsed.data.email);
  const rateKey = authRateLimitKey(request, email);
  const rate = await authRateLimitStatus(rateKey);
  if (rate.blocked) return Response.json({ error: "Too many attempts. Try again later." }, { status: 429, headers: { "retry-after": String(rate.retryAfter) } });

  const row = await db.prepare("SELECT * FROM users WHERE email = ?").get(email) as Record<string, unknown> | undefined;
  const passwordHash = row?.password_hash ? String(row.password_hash) : dummyHash;
  const valid = await compare(parsed.data.password, passwordHash).catch(() => false);
  if (!row || !row.password_hash || !valid) {
    await recordAuthFailure(rateKey);
    return Response.json({ error: "Email or password is incorrect" }, { status: 401 });
  }

  await clearAuthFailures(rateKey);
  const user = rowToUser(row);
  const session = await createSession(user.id);
  return attachLastAuthMethodCookie(attachSessionCookie(NextResponse.json({ ok: true, user }), session.token, session.expiresAt), "email");
}
