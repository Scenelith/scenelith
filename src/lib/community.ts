import "server-only";

import { db } from "./postgres-db";
import { supportTierProjectionSql } from "@/distribution/support-tier";
import { canAccessTicket, canSeeFeature, compareSupportQueue, sanitizeFeatureForViewer, supportTierRank } from "./community-policy";
import type {
  FeatureRequestRecord,
  FeatureRequestStatus,
  NotificationRecord,
  SupportMessageRecord,
  SupportTicketRecord,
  UserRecord,
} from "./types";

type NotificationInput = {
  recipientUserId?: string | null;
  kind: NotificationRecord["kind"];
  title: string;
  body: string;
  actionType?: NotificationRecord["actionType"];
  actionId?: string | null;
};

export async function createNotification(input: NotificationInput) {
  const id = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO notifications (id, recipient_user_id, kind, title, body, action_type, action_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.recipientUserId || null, input.kind, input.title, input.body, input.actionType || null, input.actionId || null, new Date().toISOString());
  return id;
}

export async function notifyAdmins(input: Omit<NotificationInput, "recipientUserId">) {
  const admins = await db.prepare("SELECT id FROM users WHERE is_admin = true").all() as Array<{ id: string }>;
  const insert = db.prepare(`
    INSERT INTO notifications (id, recipient_user_id, kind, title, body, action_type, action_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  await db.transaction(async () => {
    for (const admin of admins) {
      await insert.run(crypto.randomUUID(), admin.id, input.kind, input.title, input.body, input.actionType || null, input.actionId || null, now);
    }
  })();
}

function rowToTicket(row: Record<string, unknown>): SupportTicketRecord {
  const supportTier = (["standard", "priority"].includes(String(row.support_tier)) ? String(row.support_tier) : "community") as SupportTicketRecord["supportTier"];
  const supportTierName = ({ community: "Community", standard: "Standard", priority: "Priority" } as const)[supportTier];
  const lastAuthorIsAdmin = Boolean(row.last_author_is_admin);
  const status = String(row.status) as SupportTicketRecord["status"];
  return {
    id: String(row.id),
    userId: String(row.user_id),
    userName: String(row.user_name || "Scenelith creator"),
    userEmail: String(row.user_email || ""),
    workspaceId: row.workspace_id ? String(row.workspace_id) : null,
    workspaceName: row.workspace_name ? String(row.workspace_name) : null,
    supportTier,
    supportTierName,
    supportRank: supportTierRank(supportTier),
    needsReply: ["open", "in_progress"].includes(status) && !lastAuthorIsAdmin,
    subject: String(row.subject),
    category: (["bug", "generation", "account", "other"].includes(String(row.category)) ? String(row.category) : "account") as SupportTicketRecord["category"],
    status,
    priority: String(row.priority) as SupportTicketRecord["priority"],
    messageCount: Number(row.message_count || 0),
    lastMessage: row.last_message ? String(row.last_message) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function listSupportTickets(viewer: UserRecord, adminView = false) {
  const where = adminView && viewer.isAdmin ? "1 = 1" : "t.user_id = @userId";
  const now = new Date().toISOString();
  const rows = await db.prepare(`
    SELECT t.*, u.name AS user_name, u.email AS user_email, w.name AS workspace_name,
      (SELECT COUNT(*) FROM support_messages sm WHERE sm.ticket_id = t.id) AS message_count,
      (SELECT sm.body FROM support_messages sm WHERE sm.ticket_id = t.id ORDER BY sm.created_at DESC, sm.id DESC LIMIT 1) AS last_message,
      COALESCE((SELECT au.is_admin FROM support_messages sm JOIN users au ON au.id = sm.author_user_id WHERE sm.ticket_id = t.id ORDER BY sm.created_at DESC, sm.id DESC LIMIT 1), false) AS last_author_is_admin,
      ${supportTierProjectionSql}
    FROM support_tickets t
    JOIN users u ON u.id = t.user_id
    LEFT JOIN workspaces w ON w.id = t.workspace_id
    WHERE ${where}
    ORDER BY t.updated_at DESC
  `).all({ userId: viewer.id, now }) as Record<string, unknown>[];
  const tickets = rows.map(rowToTicket);
  return adminView && viewer.isAdmin ? tickets.sort(compareSupportQueue) : tickets;
}

export async function getSupportTicket(viewer: UserRecord, ticketId: string) {
  const now = new Date().toISOString();
  const row = await db.prepare(`
    SELECT t.*, u.name AS user_name, u.email AS user_email, w.name AS workspace_name,
      (SELECT COUNT(*) FROM support_messages sm WHERE sm.ticket_id = t.id) AS message_count,
      (SELECT sm.body FROM support_messages sm WHERE sm.ticket_id = t.id ORDER BY sm.created_at DESC, sm.id DESC LIMIT 1) AS last_message,
      COALESCE((SELECT au.is_admin FROM support_messages sm JOIN users au ON au.id = sm.author_user_id WHERE sm.ticket_id = t.id ORDER BY sm.created_at DESC, sm.id DESC LIMIT 1), false) AS last_author_is_admin,
      ${supportTierProjectionSql}
    FROM support_tickets t
    JOIN users u ON u.id = t.user_id
    LEFT JOIN workspaces w ON w.id = t.workspace_id
    WHERE t.id = @ticketId
  `).get({ ticketId, now }) as Record<string, unknown> | undefined;
  if (!row || !canAccessTicket(viewer, String(row.user_id))) return null;
  const messages = await db.prepare(`
    SELECT m.*, u.name AS author_name, u.email AS author_email, u.is_admin AS author_is_admin
    FROM support_messages m
    JOIN users u ON u.id = m.author_user_id
    WHERE m.ticket_id = ?
    ORDER BY m.created_at, m.id
  `).all(ticketId) as Record<string, unknown>[];
  return {
    ...rowToTicket(row),
    messages: messages.map((message): SupportMessageRecord => ({
      id: String(message.id),
      ticketId: String(message.ticket_id),
      authorUserId: String(message.author_user_id),
      authorName: String(message.author_name || message.author_email || "Scenelith creator"),
      isAdmin: Boolean(message.author_is_admin),
      body: String(message.body),
      createdAt: String(message.created_at),
    })),
  };
}

function rowToFeature(row: Record<string, unknown>): FeatureRequestRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    userName: String(row.user_name || "Scenelith creator"),
    isOwner: false,
    title: String(row.title),
    description: String(row.description),
    status: String(row.status) as FeatureRequestStatus,
    hidden: Boolean(row.is_hidden),
    moderationNote: String(row.moderation_note || ""),
    voteCount: Number(row.vote_count || 0),
    hasVoted: Boolean(row.has_voted),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function listFeatureRequests(viewer: UserRecord, adminView = false) {
  const rows = await db.prepare(`
    SELECT f.*, u.name AS user_name,
      (SELECT COUNT(*) FROM feature_votes fv WHERE fv.feature_request_id = f.id) AS vote_count,
      EXISTS(SELECT 1 FROM feature_votes own_vote WHERE own_vote.feature_request_id = f.id AND own_vote.user_id = @viewerId) AS has_voted
    FROM feature_requests f
    JOIN users u ON u.id = f.user_id
    WHERE @adminView = true
      OR (f.is_hidden = false AND (
        f.status IN ('approved', 'planned', 'in_progress', 'shipped')
        OR f.user_id = @viewerId
      ))
    ORDER BY
      CASE f.status WHEN 'approved' THEN 0 WHEN 'planned' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'shipped' THEN 3 WHEN 'pending' THEN 4 ELSE 5 END,
      vote_count DESC,
      f.updated_at DESC
  `).all({ viewerId: viewer.id, adminView: adminView && viewer.isAdmin }) as Record<string, unknown>[];
  return rows
    .map(rowToFeature)
    .filter((feature) => canSeeFeature(viewer, feature.userId, feature.status, feature.hidden))
    .map((feature) => sanitizeFeatureForViewer(feature, viewer));
}

export async function getFeatureRequest(viewer: UserRecord, featureId: string) {
  const row = await db.prepare(`
    SELECT f.*, u.name AS user_name,
      (SELECT COUNT(*) FROM feature_votes fv WHERE fv.feature_request_id = f.id) AS vote_count,
      EXISTS(SELECT 1 FROM feature_votes own_vote WHERE own_vote.feature_request_id = f.id AND own_vote.user_id = ?) AS has_voted
    FROM feature_requests f JOIN users u ON u.id = f.user_id WHERE f.id = ?
  `).get(viewer.id, featureId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const feature = rowToFeature(row);
  return canSeeFeature(viewer, feature.userId, feature.status, feature.hidden) ? sanitizeFeatureForViewer(feature, viewer) : null;
}

export async function listNotifications(userId: string, limit = 40) {
  const rows = await db.prepare(`
    SELECT n.*, CASE WHEN nr.notification_id IS NULL THEN 0 ELSE 1 END AS is_read
    FROM notifications n
    JOIN users viewer ON viewer.id = @userId
    LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = @userId
    WHERE n.recipient_user_id = @userId
      OR (n.recipient_user_id IS NULL AND n.created_at >= viewer.created_at)
    ORDER BY n.created_at DESC, n.id DESC
    LIMIT @limit
  `).all({ userId, limit }) as Record<string, unknown>[];
  const notifications = rows.map((row): NotificationRecord => ({
    id: String(row.id),
    recipientUserId: row.recipient_user_id ? String(row.recipient_user_id) : null,
    kind: String(row.kind) as NotificationRecord["kind"],
    title: String(row.title),
    body: String(row.body),
    actionType: row.action_type ? String(row.action_type) as NotificationRecord["actionType"] : null,
    actionId: row.action_id ? String(row.action_id) : null,
    isRead: Boolean(row.is_read),
    createdAt: String(row.created_at),
  }));
  const unread = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM notifications n
    JOIN users viewer ON viewer.id = @userId
    LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = @userId
    WHERE (n.recipient_user_id = @userId
        OR (n.recipient_user_id IS NULL AND n.created_at >= viewer.created_at))
      AND nr.notification_id IS NULL
  `).get({ userId }) as { count: number };
  return { notifications, unreadCount: Number(unread.count || 0) };
}

export async function markNotificationRead(userId: string, notificationId: string) {
  const visible = await db.prepare(`
    SELECT 1
    FROM notifications n
    JOIN users viewer ON viewer.id = ?
    WHERE n.id = ?
      AND (n.recipient_user_id = viewer.id
        OR (n.recipient_user_id IS NULL AND n.created_at >= viewer.created_at))
  `).get(userId, notificationId);
  if (!visible) return false;
  await db.prepare("INSERT OR IGNORE INTO notification_reads (notification_id, user_id, read_at) VALUES (?, ?, ?)").run(notificationId, userId, new Date().toISOString());
  return true;
}

export async function markActionNotificationsRead(userId: string, actionType: NonNullable<NotificationRecord["actionType"]>, actionId: string) {
  const now = new Date().toISOString();
  return (await db.prepare(`
    INSERT OR IGNORE INTO notification_reads (notification_id, user_id, read_at)
    SELECT id, @userId, @now FROM notifications
    WHERE recipient_user_id = @userId
      AND action_type = @actionType
      AND action_id = @actionId
  `).run({ userId, now, actionType, actionId })).changes;
}

export async function markAllNotificationsRead(userId: string) {
  const now = new Date().toISOString();
  return (await db.prepare(`
    INSERT OR IGNORE INTO notification_reads (notification_id, user_id, read_at)
    SELECT n.id, @userId, @now
    FROM notifications n
    JOIN users viewer ON viewer.id = @userId
    WHERE n.recipient_user_id = @userId
      OR (n.recipient_user_id IS NULL AND n.created_at >= viewer.created_at)
  `).run({ userId, now })).changes;
}
