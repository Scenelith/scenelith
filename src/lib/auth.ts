import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import { db, rowToUser } from "@/lib/postgres-db";
import type { UserRecord } from "@/lib/types";

export const SESSION_COOKIE = "frameflow_session";
export const OAUTH_STATE_COOKIE = "frameflow_oauth_state";
export const OAUTH_VERIFIER_COOKIE = "frameflow_oauth_verifier";
export const OAUTH_RETURN_TO_COOKIE = "frameflow_oauth_return_to";
export const LAST_AUTH_METHOD_COOKIE = "scenelith_last_auth_method";
const SESSION_DAYS = 30;

export function normalizeEmail(email: string) {
  return email.trim().toLocaleLowerCase("en-US");
}

export function hashOpaqueToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function secureCookies() {
  const configured = process.env.COOKIE_SECURE?.trim().toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  return process.env.NODE_ENV === "production";
}

export function safeReturnTo(value: string | null | undefined, fallback = "/canvas") {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  try {
    const parsed = new URL(value, "https://scenelith.local");
    if (parsed.origin !== "https://scenelith.local") return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

export async function createSession(userId: string) {
  const token = randomToken(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now.toISOString());
  await db.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(crypto.randomUUID(), userId, hashOpaqueToken(token), expiresAt.toISOString(), now.toISOString(), now.toISOString());
  return { token, expiresAt };
}

export function attachSessionCookie(response: NextResponse, token: string, expiresAt: Date) {
  response.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies(),
    path: "/",
    expires: expiresAt,
    priority: "high",
  });
  return response;
}

export function attachLastAuthMethodCookie(response: NextResponse, method: "email" | "google") {
  response.cookies.set({
    name: LAST_AUTH_METHOD_COOKIE,
    value: method,
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies(),
    path: "/",
    maxAge: 365 * 24 * 60 * 60,
  });
  return response;
}

export async function getCurrentUser(): Promise<UserRecord | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const now = new Date().toISOString();
  const tokenHash = hashOpaqueToken(token);
  const row = await db.prepare(`
    SELECT u.*, s.last_seen_at AS session_last_seen_at FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(tokenHash, now) as Record<string, unknown> | undefined;
  if (!row) return null;
  const lastSeenAt = Date.parse(String(row.session_last_seen_at || ""));
  if (!Number.isFinite(lastSeenAt) || Date.now() - lastSeenAt > 5 * 60 * 1000) {
    await db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(now, tokenHash);
  }
  return rowToUser(row);
}

export async function isAuthenticated() {
  return Boolean(await getCurrentUser());
}

export async function requireApiUser(): Promise<{ user: UserRecord; response: null } | { user: null; response: Response }> {
  const user = await getCurrentUser();
  if (!user) return { user: null, response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  return { user, response: null };
}

export async function requireApiAuth() {
  const auth = await requireApiUser();
  return auth.response;
}

export async function requireApiAdmin(): Promise<{ user: UserRecord; response: null } | { user: null; response: Response }> {
  const auth = await requireApiUser();
  if (auth.response) return auth;
  if (!auth.user.isAdmin) return { user: null, response: Response.json({ error: "Not found" }, { status: 404 }) };
  return auth;
}

export async function revokeCurrentSession() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashOpaqueToken(token));
}

export function baseUrl(request?: Request) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  if (request) return new URL(request.url).origin;
  return "http://localhost:3000";
}

export function sameOriginRequest(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  return origin === new URL(baseUrl(request)).origin;
}

export function authRateLimitKey(request: Request, email: string) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  return createHash("sha256").update(`${normalizeEmail(email)}|${forwarded}`).digest("hex");
}

export async function authRateLimitStatus(identifierHash: string) {
  const row = await db.prepare("SELECT attempts, window_started_at, blocked_until FROM auth_rate_limits WHERE identifier_hash = ?").get(identifierHash) as
    | { attempts: number; window_started_at: string; blocked_until: string | null }
    | undefined;
  if (!row) return { blocked: false, retryAfter: 0 };
  const now = Date.now();
  const blockedUntil = row.blocked_until ? Date.parse(row.blocked_until) : 0;
  if (blockedUntil > now) return { blocked: true, retryAfter: Math.ceil((blockedUntil - now) / 1000) };
  return { blocked: false, retryAfter: 0 };
}

export async function recordAuthFailure(identifierHash: string) {
  const now = new Date();
  const windowMs = 15 * 60 * 1000;
  const cutoff = new Date(now.getTime() - windowMs).toISOString();
  const blockedUntil = new Date(now.getTime() + windowMs).toISOString();
  await db.prepare(`
    INSERT INTO auth_rate_limits (identifier_hash, attempts, window_started_at, blocked_until)
    VALUES (?, 1, ?, NULL)
    ON CONFLICT(identifier_hash) DO UPDATE SET
      attempts = CASE WHEN auth_rate_limits.window_started_at > ?::timestamptz THEN auth_rate_limits.attempts + 1 ELSE 1 END,
      window_started_at = CASE WHEN auth_rate_limits.window_started_at > ?::timestamptz THEN auth_rate_limits.window_started_at ELSE excluded.window_started_at END,
      blocked_until = CASE WHEN auth_rate_limits.window_started_at > ?::timestamptz AND auth_rate_limits.attempts + 1 >= 8 THEN ?::timestamptz ELSE NULL END
  `).run(identifierHash, now.toISOString(), cutoff, cutoff, cutoff, blockedUntil);
}

export async function clearAuthFailures(identifierHash: string) {
  await db.prepare("DELETE FROM auth_rate_limits WHERE identifier_hash = ?").run(identifierHash);
}
