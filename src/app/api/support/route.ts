import { z } from "zod";
import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { getSupportTicket, listSupportTickets, notifyAdmins } from "@/lib/community";
import { db, userCanAccessWorkspace } from "@/lib/postgres-db";

export const runtime = "nodejs";

const createTicketSchema = z.object({
  workspaceId: z.string().trim().min(1).max(120).optional(),
  subject: z.string().trim().min(4).max(140),
  category: z.enum(["bug", "generation", "account", "other"]),
  body: z.string().trim().min(10).max(6000),
});

export async function GET() {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  return Response.json({ tickets: await listSupportTickets(auth.user) });
}

export async function POST(request: Request) {
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const parsed = createTicketSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message || "Invalid ticket" }, { status: 400 });
  if (parsed.data.workspaceId && !await userCanAccessWorkspace(auth.user.id, parsed.data.workspaceId)) return Response.json({ error: "Workspace not found" }, { status: 404 });

  const ticketId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.transaction(async () => {
    await db.prepare(`INSERT INTO support_tickets (id, user_id, workspace_id, subject, category, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', 'normal', ?, ?)`)
      .run(ticketId, auth.user.id, parsed.data.workspaceId || null, parsed.data.subject, parsed.data.category, now, now);
    await db.prepare("INSERT INTO support_messages (id, ticket_id, author_user_id, body, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(messageId, ticketId, auth.user.id, parsed.data.body, now);
  })();
  await notifyAdmins({ kind: "admin_queue", title: "New support ticket", body: parsed.data.subject, actionType: "admin", actionId: `ticket:${ticketId}` });
  const ticket = await getSupportTicket(auth.user, ticketId);
  return Response.json({ ticket }, { status: 201 });
}
