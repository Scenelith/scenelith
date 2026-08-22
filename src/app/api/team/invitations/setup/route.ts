import { hash } from "bcryptjs";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  attachLastAuthMethodCookie,
  attachSessionCookie,
  authRateLimitKey,
  authRateLimitStatus,
  clearAuthFailures,
  createSession,
  recordAuthFailure,
  sameOriginRequest,
} from "@/lib/auth";
import { createInvitedTeamUser, invitationSummary, TeamError } from "@/lib/team";

export const runtime = "nodejs";

const schema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(8).max(128),
  confirmPassword: z.string().min(8).max(128),
}).refine((value) => value.password === value.confirmPassword, {
  path: ["confirmPassword"],
  message: "Passwords do not match",
});

export async function POST(request: Request) {
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const mismatch = parsed.error.issues.some((issue) => issue.path.includes("confirmPassword"));
    return Response.json({ error: mismatch ? "Passwords do not match" : "Use a password of at least 8 characters" }, { status: 400 });
  }
  const invitation = await invitationSummary(parsed.data.token);
  if (!invitation) return Response.json({ error: "This invitation is invalid or has expired" }, { status: 410 });
  const rateKey = authRateLimitKey(request, invitation.invited_email);
  const rate = await authRateLimitStatus(rateKey);
  if (rate.blocked) return Response.json({ error: "Too many attempts. Try again later." }, { status: 429, headers: { "retry-after": String(rate.retryAfter) } });

  try {
    const passwordHash = await hash(parsed.data.password, 12);
    const account = await createInvitedTeamUser({ token: parsed.data.token, passwordHash });
    await clearAuthFailures(rateKey);
    const session = await createSession(account.userId);
    const response = NextResponse.json({ accepted: { workspaceId: account.workspaceId } }, { status: 201 });
    return attachLastAuthMethodCookie(attachSessionCookie(response, session.token, session.expiresAt), "email");
  } catch (error) {
    await recordAuthFailure(rateKey);
    if (error instanceof TeamError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
