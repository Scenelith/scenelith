import { z } from "zod";
import { requireApiAdmin, requireApiUser, sameOriginRequest } from "@/lib/auth";
import { createNotification, getSupportTicket, markActionNotificationsRead, notifyAdmins } from "@/lib/community";
import { nextTicketStatusAfterReply, writableTicketStatuses } from "@/lib/community-policy";
import { db } from "@/lib/postgres-db";

export const runtime = "nodejs";

const replySchema = z.object({ body: z.string().trim().min(1).max(6000) });
const updateSchema = z.object({
  status: z.enum(["open", "in_progress", "resolved", "closed"]).optional(),
  priority: z.enum(["normal", "high", "urgent"]).optional(),
}).refine((value) => value.status || value.priority, "No changes supplied");

export async function GET(_request: Request, context: RouteContext<"/api/support/[id]">) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  const ticket = await getSupportTicket(auth.user, id);
  if (!ticket) return Response.json({ error: "Ticket not found" }, { status: 404 });
  await markActionNotificationsRead(auth.user.id, "support", id);
  return Response.json({ ticket });
}

export async function POST(request: Request, context: RouteContext<"/api/support/[id]">) {
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  const ticket = await getSupportTicket(auth.user, id);
  if (!ticket) return Response.json({ error: "Ticket not found" }, { status: 404 });
  if (!writableTicketStatuses.has(ticket.status)) return Response.json({ error: "This ticket is closed" }, { status: 409 });
  const parsed = replySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message || "Invalid reply" }, { status: 400 });
  const now = new Date().toISOString();
  const nextStatus = nextTicketStatusAfterReply(auth.user.isAdmin, ticket.status);
  await db.transaction(async () => {
    await db.prepare("INSERT INTO support_messages (id, ticket_id, author_user_id, body, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), id, auth.user.id, parsed.data.body, now);
    await db.prepare("UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?").run(nextStatus, now, id);
  })();
  if (auth.user.isAdmin && ticket.userId !== auth.user.id) {
    await createNotification({ recipientUserId: ticket.userId, kind: "ticket_reply", title: "New reply from Scenelith support", body: `We replied to “${ticket.subject}”`, actionType: "support", actionId: id });
  } else {
    await notifyAdmins({ kind: "admin_queue", title: "New ticket reply", body: ticket.subject, actionType: "admin", actionId: `ticket:${id}` });
  }
  return Response.json({ ticket: await getSupportTicket(auth.user, id) });
}

export async function PATCH(request: Request, context: RouteContext<"/api/support/[id]">) {
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
  const auth = await requireApiAdmin();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  const ticket = await getSupportTicket(auth.user, id);
  if (!ticket) return Response.json({ error: "Ticket not found" }, { status: 404 });
  const parsed = updateSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message || "Invalid update" }, { status: 400 });
  const nextStatus = parsed.data.status || ticket.status;
  const nextPriority = parsed.data.priority || ticket.priority;
  await db.prepare("UPDATE support_tickets SET status = ?, priority = ?, updated_at = ? WHERE id = ?")
    .run(nextStatus, nextPriority, new Date().toISOString(), id);
  if (nextStatus !== ticket.status) await createNotification({ recipientUserId: ticket.userId, kind: "ticket_status", title: `Ticket ${nextStatus.replace("_", " ")}`, body: ticket.subject, actionType: "support", actionId: id });
  return Response.json({ ticket: await getSupportTicket(auth.user, id) });
}
