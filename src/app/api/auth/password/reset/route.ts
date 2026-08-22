import { hash } from "bcryptjs";
import { z } from "zod";
import { sameOriginRequest } from "@/lib/auth";
import { consumeAuthToken } from "@/lib/auth-tokens";
import { db } from "@/lib/postgres-db";
import { sendPasswordChangedEmail } from "@/lib/email";

export const runtime = "nodejs";

const schema = z.object({ token: z.string().min(32).max(256), password: z.string().min(8).max(128) });

export async function POST(request: Request) {
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Use a password of at least 8 characters" }, { status: 400 });
  const passwordHash = await hash(parsed.data.password, 12);
  const consumed = await consumeAuthToken(parsed.data.token, "password_reset");
  if (!consumed) return Response.json({ error: "This reset link is invalid or has expired" }, { status: 400 });
  const now = new Date().toISOString();
  await db.transaction(async () => {
    await db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(passwordHash, now, consumed.user_id);
    await db.prepare("DELETE FROM sessions WHERE user_id = ?").run(consumed.user_id);
    await db.prepare("UPDATE auth_tokens SET used_at = COALESCE(used_at, ?) WHERE user_id = ? AND purpose = 'password_reset'").run(now, consumed.user_id);
  })();
  await sendPasswordChangedEmail(consumed.email, consumed.name);
  return Response.json({ ok: true });
}
