import { z } from "zod";
import { requireApiUser, sameOriginRequest } from "@/lib/auth";
import { acceptTeamInvitation, TeamError } from "@/lib/team";

export const runtime = "nodejs";
const schema = z.object({ token: z.string().min(20).max(200) });

export async function POST(request: Request) {
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "This invitation is invalid or has expired" }, { status: 410 });
  try {
    return Response.json({ accepted: await acceptTeamInvitation({ token: parsed.data.token, userId: auth.user.id, userEmail: auth.user.email, emailVerified: auth.user.emailVerified }) });
  } catch (error) {
    if (error instanceof TeamError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
