import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { getFeatureRequest } from "@/lib/community";
import { canVoteForFeature } from "@/lib/community-policy";
import { db } from "@/lib/postgres-db";

export const runtime = "nodejs";

export async function POST(request: Request, context: RouteContext<"/api/features/[id]/vote">) {
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  const feature = await getFeatureRequest(auth.user, id);
  if (!feature || !canVoteForFeature(feature.status)) return Response.json({ error: "Feature is not open for voting" }, { status: 409 });
  if (feature.hasVoted) await db.prepare("DELETE FROM feature_votes WHERE feature_request_id = ? AND user_id = ?").run(id, auth.user.id);
  else await db.prepare("INSERT OR IGNORE INTO feature_votes (feature_request_id, user_id, created_at) VALUES (?, ?, ?)").run(id, auth.user.id, new Date().toISOString());
  return Response.json({ feature: await getFeatureRequest(auth.user, id) });
}
