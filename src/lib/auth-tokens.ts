import { db } from "@/lib/postgres-db";
import { hashOpaqueToken, randomToken } from "@/lib/auth";

export type AuthTokenPurpose = "email_verification" | "password_reset";

export async function createAuthToken(userId: string, purpose: AuthTokenPurpose, lifetimeMinutes: number) {
  const token = randomToken(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + lifetimeMinutes * 60 * 1000);
  await db.transaction(async () => {
    await db.prepare("DELETE FROM auth_tokens WHERE expires_at <= ? OR (user_id = ? AND purpose = ? AND used_at IS NULL)")
      .run(now.toISOString(), userId, purpose);
    await db.prepare("INSERT INTO auth_tokens (id, user_id, purpose, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), userId, purpose, hashOpaqueToken(token), expiresAt.toISOString(), now.toISOString());
  })();
  return token;
}

export async function consumeAuthToken(token: string, purpose: AuthTokenPurpose) {
  const now = new Date().toISOString();
  return await db.transaction(async () => {
    const row = await db.prepare(`
      SELECT t.id AS token_id, t.user_id, u.email, u.name
      FROM auth_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.purpose = ? AND t.used_at IS NULL AND t.expires_at > ?
    `).get(hashOpaqueToken(token), purpose, now) as { token_id: string; user_id: string; email: string; name: string } | undefined;
    if (!row) return null;
    const updated = await db.prepare("UPDATE auth_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL").run(now, row.token_id);
    return updated.changes === 1 ? row : null;
  })();
}
