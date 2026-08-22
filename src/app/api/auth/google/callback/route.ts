import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  attachSessionCookie,
  attachLastAuthMethodCookie,
  baseUrl,
  createSession,
  normalizeEmail,
  OAUTH_RETURN_TO_COOKIE,
  OAUTH_STATE_COOKIE,
  OAUTH_VERIFIER_COOKIE,
  safeReturnTo,
} from "@/lib/auth";
import { db, ensureDefaultWorkspace, ensureStarterProject, isConfiguredAdminEmail } from "@/lib/postgres-db";

export const runtime = "nodejs";

type GoogleProfile = { sub?: string; email?: string; email_verified?: boolean; name?: string };

function clearOAuthCookies(response: NextResponse) {
  response.cookies.delete(OAUTH_STATE_COOKIE);
  response.cookies.delete(OAUTH_VERIFIER_COOKIE);
  response.cookies.delete(OAUTH_RETURN_TO_COOKIE);
  return response;
}

function loginError(request: Request, code: string) {
  return clearOAuthCookies(NextResponse.redirect(`${baseUrl(request)}/login?error=${encodeURIComponent(code)}`));
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieStore = await cookies();
  const expectedState = cookieStore.get(OAUTH_STATE_COOKIE)?.value;
  const verifier = cookieStore.get(OAUTH_VERIFIER_COOKIE)?.value;
  const returnTo = safeReturnTo(cookieStore.get(OAUTH_RETURN_TO_COOKIE)?.value);
  if (!code || !state || !expectedState || !verifier || state !== expectedState) return loginError(request, "google_state");
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return loginError(request, "google_unavailable");

  const redirectUri = `${baseUrl(request)}/api/auth/google/callback`;
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: verifier }),
    cache: "no-store",
  });
  const tokenBody = (await tokenResponse.json().catch(() => ({}))) as { access_token?: string };
  if (!tokenResponse.ok || !tokenBody.access_token) return loginError(request, "google_exchange");

  const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${tokenBody.access_token}` },
    cache: "no-store",
  });
  const profile = (await profileResponse.json().catch(() => ({}))) as GoogleProfile;
  if (!profileResponse.ok || !profile.sub || !profile.email || profile.email_verified !== true) return loginError(request, "google_profile");

  const existingAccount = await db.prepare(`
    SELECT u.id FROM auth_accounts a JOIN users u ON u.id = a.user_id
    WHERE a.provider = 'google' AND a.provider_account_id = ?
  `).get(profile.sub) as { id: string } | undefined;
  let userId = existingAccount?.id;
  if (!userId) {
    const email = normalizeEmail(profile.email);
    const existingUser = await db.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string } | undefined;
    userId = existingUser?.id || crypto.randomUUID();
    const now = new Date().toISOString();
    await db.transaction(async () => {
      if (existingUser) {
        await db.prepare("UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?), is_admin = CASE WHEN ? = true THEN true ELSE is_admin END, updated_at = ? WHERE id = ?")
          .run(now, isConfiguredAdminEmail(email), now, userId);
      } else {
        await db.prepare("INSERT INTO users (id, email, name, email_verified_at, is_admin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(userId, email, String(profile.name || "").slice(0, 80), now, isConfiguredAdminEmail(email), now, now);
      }
      await db.prepare("INSERT INTO auth_accounts (id, user_id, provider, provider_account_id, created_at) VALUES (?, ?, 'google', ?, ?)")
        .run(crypto.randomUUID(), userId, profile.sub, now);
    })();
    if (!existingUser) {
      const workspace = await ensureDefaultWorkspace(userId);
      if (workspace) await ensureStarterProject(workspace.id);
    }
  }

  const session = await createSession(userId);
  const response = clearOAuthCookies(attachSessionCookie(NextResponse.redirect(`${baseUrl(request)}${returnTo}`), session.token, session.expiresAt));
  return attachLastAuthMethodCookie(response, "google");
}
