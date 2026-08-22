import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { listNotifications, markNotificationRead } from "@/lib/community";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: RouteContext<"/api/notifications/[id]">) {
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  if (!await markNotificationRead(auth.user.id, id)) return Response.json({ error: "Notification not found" }, { status: 404 });
  return Response.json(await listNotifications(auth.user.id));
}
