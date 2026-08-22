import { z } from "zod";
import { requireApiAdmin, sameOriginRequest } from "@/lib/auth";
import { createNotification } from "@/lib/community";
import { db } from "@/lib/postgres-db";

export const runtime = "nodejs";

const announcementSchema = z.object({
  title: z.string().trim().min(3).max(100),
  body: z.string().trim().min(3).max(1200),
  recipientEmail: z.string().trim().email().optional().or(z.literal("")),
});

export async function POST(request: Request) {
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
  const auth = await requireApiAdmin();
  if (auth.response) return auth.response;
  const parsed = announcementSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message || "Invalid notification" }, { status: 400 });
  let recipientUserId: string | null = null;
  if (parsed.data.recipientEmail) {
    const recipient = await db.prepare("SELECT id FROM users WHERE lower(email) = lower(?)").get(parsed.data.recipientEmail) as { id: string } | undefined;
    if (!recipient) return Response.json({ error: "No user found with that email" }, { status: 404 });
    recipientUserId = recipient.id;
  }
  const id = await createNotification({ recipientUserId, kind: "announcement", title: parsed.data.title, body: parsed.data.body });
  return Response.json({ ok: true, id, audience: recipientUserId ? "personal" : "everyone" }, { status: 201 });
}
