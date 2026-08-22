import { z } from "zod";
import { authRateLimitKey, authRateLimitStatus, normalizeEmail, recordAuthFailure, sameOriginRequest } from "@/lib/auth";
import { createAuthToken } from "@/lib/auth-tokens";
import { db } from "@/lib/postgres-db";
import { sendPasswordResetEmail } from "@/lib/email";

export const runtime = "nodejs";

const schema = z.object({ email: z.string().trim().email().max(254) });

export async function POST(request: Request) {
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Enter a valid email address" }, { status: 400 });
  const email = normalizeEmail(parsed.data.email);
  const rateKey = authRateLimitKey(request, `password-reset:${email}`);
  const rate = await authRateLimitStatus(rateKey);
  if (rate.blocked) return Response.json({ error: "Too many requests. Try again later." }, { status: 429, headers: { "retry-after": String(rate.retryAfter) } });
  await recordAuthFailure(rateKey);

  const user = await db.prepare("SELECT id, email, name FROM users WHERE email = ? AND password_hash IS NOT NULL").get(email) as { id: string; email: string; name: string } | undefined;
  if (user) {
    const token = await createAuthToken(user.id, "password_reset", 30);
    await sendPasswordResetEmail(user.email, user.name, token);
  }
  return Response.json({ ok: true, message: "If an account exists for this email, a reset link has been sent." });
}
