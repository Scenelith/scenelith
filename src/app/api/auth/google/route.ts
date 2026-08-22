import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { baseUrl, OAUTH_RETURN_TO_COOKIE, OAUTH_STATE_COOKIE, OAUTH_VERIFIER_COOKIE, randomToken, safeReturnTo, secureCookies } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId || !process.env.GOOGLE_CLIENT_SECRET) return NextResponse.redirect(`${baseUrl(request)}/login?error=google_unavailable`);
  const state = randomToken(24);
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get("next"));
  const verifier = randomToken(48);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const redirectUri = `${baseUrl(request)}/api/auth/google/callback`;
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  const response = NextResponse.redirect(url);
  const cookieOptions = { httpOnly: true, sameSite: "lax" as const, secure: secureCookies(), path: "/api/auth/google", maxAge: 10 * 60 };
  response.cookies.set({ name: OAUTH_STATE_COOKIE, value: state, ...cookieOptions });
  response.cookies.set({ name: OAUTH_VERIFIER_COOKIE, value: verifier, ...cookieOptions });
  response.cookies.set({ name: OAUTH_RETURN_TO_COOKIE, value: returnTo, ...cookieOptions });
  return response;
}
