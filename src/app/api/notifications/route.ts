import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { listNotifications, markAllNotificationsRead } from "@/lib/community";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  return Response.json(await listNotifications(auth.user.id));
}

export async function PATCH(request: Request) {
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  await markAllNotificationsRead(auth.user.id);
  return Response.json(await listNotifications(auth.user.id));
}
