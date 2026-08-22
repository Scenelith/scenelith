import { db } from "./postgres-db";

export async function appendAuditEvent(input: {
  workspaceId?: string | null;
  actorUserId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const metadata = JSON.stringify(input.metadata || {});
  if (Buffer.byteLength(metadata) > 16 * 1024) throw new Error("Audit metadata is too large");
  await db.prepare(`INSERT INTO audit_events
    (id, workspace_id, actor_user_id, action, target_type, target_id, metadata_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`)
    .run(
      crypto.randomUUID(),
      input.workspaceId || null,
      input.actorUserId || null,
      input.action.slice(0, 120),
      input.targetType.slice(0, 80),
      input.targetId?.slice(0, 240) || null,
      metadata,
      new Date().toISOString(),
      new Date(Date.now() + 400 * 24 * 60 * 60 * 1_000).toISOString(),
    );
}
