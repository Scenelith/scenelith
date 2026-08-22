import { z } from "zod";
import { requireApiAdmin, sameOriginRequest } from "@/lib/auth";
import { createNotification, getFeatureRequest } from "@/lib/community";
import { db } from "@/lib/postgres-db";

export const runtime = "nodejs";

const moderationSchema = z.object({
  status: z.enum(["pending", "approved", "rejected", "planned", "in_progress", "shipped"]).optional(),
  hidden: z.boolean().optional(),
  moderationNote: z.string().trim().max(1200).optional(),
}).refine((data) => data.status !== undefined || data.hidden !== undefined || data.moderationNote !== undefined, {
  message: "Choose a status or visibility change",
});

const statusNotification = {
  pending: { title: "Feature returned to review", global: false },
  approved: { title: "Feature approved for voting", global: false },
  rejected: { title: "Feature review complete", global: false },
  planned: { title: "Roadmap update · Planned", global: true },
  in_progress: { title: "Roadmap update · In progress", global: true },
  shipped: { title: "Roadmap update · Completed", global: true },
} as const;

export async function PATCH(request: Request, context: RouteContext<"/api/features/[id]">) {
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
  const auth = await requireApiAdmin();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  const feature = await getFeatureRequest(auth.user, id);
  if (!feature) return Response.json({ error: "Feature request not found" }, { status: 404 });
  const parsed = moderationSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message || "Invalid moderation action" }, { status: 400 });
  const now = new Date().toISOString();
  const nextStatus = parsed.data.status ?? feature.status;
  const nextHidden = parsed.data.hidden ?? feature.hidden;
  const nextModerationNote = parsed.data.moderationNote ?? feature.moderationNote;
  await db.prepare("UPDATE feature_requests SET status = ?, is_hidden = ?, moderation_note = ?, updated_at = ? WHERE id = ?")
    .run(nextStatus, nextHidden ? 1 : 0, nextModerationNote, now, id);
  if (parsed.data.status && parsed.data.status !== feature.status && !nextHidden) {
    const notification = statusNotification[parsed.data.status];
    await createNotification({
      recipientUserId: notification.global ? undefined : feature.userId,
      kind: notification.global ? "feature_update" : "feature_status",
      title: notification.title,
      body: feature.title,
      actionType: "features",
      actionId: id,
    });
  }
  return Response.json({ feature: await getFeatureRequest(auth.user, id) });
}
