import { compare, hash } from "bcryptjs";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  attachSessionCookie,
  attachLastAuthMethodCookie,
  authRateLimitKey,
  authRateLimitStatus,
  clearAuthFailures,
  createSession,
  normalizeEmail,
  recordAuthFailure,
  sameOriginRequest,
} from "@/lib/auth";
import { claimUnownedWorkspaces, db, ensureDefaultWorkspace, ensureStarterProject, isConfiguredAdminEmail, rowToUser } from "@/lib/postgres-db";
import { createAuthToken } from "@/lib/auth-tokens";
import { sendVerificationEmail } from "@/lib/email";
import { readRuntimeConfig } from "@/platform/runtime-config";

export const runtime = "nodejs";

const schema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(128),
  confirmPassword: z.string().min(8).max(128),
}).refine((value) => value.password === value.confirmPassword, { path: ["confirmPassword"], message: "Passwords do not match" });

async function matchesLegacyPassword(password: string) {
  if (process.env.APP_PASSWORD_HASH) return compare(password, process.env.APP_PASSWORD_HASH).catch(() => false);
  return Boolean(process.env.APP_PASSWORD) && password === process.env.APP_PASSWORD;
}

class RegistrationClosedError extends Error {}

export async function POST(request: Request) {
  if (!sameOriginRequest(request)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues.some((issue) => issue.path.includes("confirmPassword")) ? "Passwords do not match" : "Use your name, a valid email and a password of at least 8 characters" }, { status: 400 });
  const email = normalizeEmail(parsed.data.email);
  const rateKey = authRateLimitKey(request, email);
  const rate = await authRateLimitStatus(rateKey);
  if (rate.blocked) return Response.json({ error: "Too many attempts. Try again later." }, { status: 429, headers: { "retry-after": String(rate.retryAfter) } });
  if (await db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) {
    await recordAuthFailure(rateKey);
    return Response.json({ error: "An account with this email already exists" }, { status: 409 });
  }

  const runtimeConfig = readRuntimeConfig();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const passwordHash = await hash(parsed.data.password, 12);
  let firstAccount = false;
  try {
    await db.transaction(async () => {
      await db.prepare("SELECT pg_advisory_xact_lock(hashtextextended('scenelith-account-registration', 0))").get();
      const count = await db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
      firstAccount = Number(count.count) === 0;
      if (!firstAccount && runtimeConfig.registrationMode !== "open") throw new RegistrationClosedError();
      await db.prepare("INSERT INTO users (id, email, name, password_hash, is_admin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, email, parsed.data.name, passwordHash, isConfiguredAdminEmail(email) || (runtimeConfig.deploymentType === "selfhost" && firstAccount), now, now);
    })();
  } catch (error) {
    if (error instanceof RegistrationClosedError) {
      return Response.json({ error: "Account registration is closed. Ask the instance owner for an invitation." }, { status: 403 });
    }
    if ((error as { code?: string }).code === "23505") {
      await recordAuthFailure(rateKey);
      return Response.json({ error: "An account with this email already exists" }, { status: 409 });
    }
    throw error;
  }

  const claimed = await matchesLegacyPassword(parsed.data.password) ? await claimUnownedWorkspaces(id) : 0;
  const workspace = claimed
    ? await db.prepare(`SELECT w.* FROM workspaces w JOIN workspace_members wm ON wm.workspace_id = w.id WHERE wm.user_id = ? ORDER BY w.created_at LIMIT 1`).get(id) as Record<string, unknown>
    : null;
  const defaultWorkspace = workspace ? null : await ensureDefaultWorkspace(id);
  const workspaceId = workspace ? String(workspace.id) : defaultWorkspace!.id;
  await ensureStarterProject(workspaceId);
  await clearAuthFailures(rateKey);

  const user = rowToUser(await db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Record<string, unknown>);
  const verificationToken = await createAuthToken(id, "email_verification", 24 * 60);
  const emailResult = await sendVerificationEmail(user.email, user.name, verificationToken);
  const session = await createSession(id);
  return attachLastAuthMethodCookie(attachSessionCookie(NextResponse.json({ ok: true, user, claimedLegacyWorkspace: claimed > 0, verificationEmailSent: emailResult.ok }), session.token, session.expiresAt), "email");
}
