import type { FeatureRequestRecord, FeatureRequestStatus, SupportTicketRecord, SupportTicketStatus, UserRecord } from "./types";

export const publicFeatureStatuses = new Set<FeatureRequestStatus>(["approved", "planned", "in_progress", "shipped"]);
export const votableFeatureStatuses = new Set<FeatureRequestStatus>(["approved", "planned", "in_progress"]);
export const writableTicketStatuses = new Set<SupportTicketStatus>(["open", "in_progress", "resolved"]);

export function canAccessTicket(viewer: Pick<UserRecord, "id" | "isAdmin">, ownerUserId: string) {
  return viewer.isAdmin || viewer.id === ownerUserId;
}

export function canSeeFeature(viewer: Pick<UserRecord, "id" | "isAdmin">, ownerUserId: string, status: FeatureRequestStatus, hidden = false) {
  if (hidden) return viewer.isAdmin;
  return viewer.isAdmin || viewer.id === ownerUserId || publicFeatureStatuses.has(status);
}

export function canVoteForFeature(status: FeatureRequestStatus) {
  return votableFeatureStatuses.has(status);
}

export function sanitizeFeatureForViewer(feature: FeatureRequestRecord, viewer: Pick<UserRecord, "id" | "isAdmin">) {
  const isOwner = feature.userId === viewer.id;
  if (viewer.isAdmin || isOwner) return { ...feature, isOwner };
  return { ...feature, userId: "", userName: "", isOwner: false, moderationNote: "" };
}

export function nextTicketStatusAfterReply(authorIsAdmin: boolean, currentStatus: SupportTicketStatus): SupportTicketStatus {
  if (currentStatus === "closed") return "closed";
  return authorIsAdmin ? "in_progress" : "open";
}

export function supportTierRank(tier: string) {
  return ({ community: 0, standard: 1, priority: 2 } as Record<string, number>)[tier] ?? 0;
}

export function compareSupportQueue(
  left: Pick<SupportTicketRecord, "supportRank" | "priority" | "needsReply" | "status" | "updatedAt">,
  right: Pick<SupportTicketRecord, "supportRank" | "priority" | "needsReply" | "status" | "updatedAt">,
) {
  const statusRank = (status: SupportTicketStatus) => ({ open: 0, in_progress: 1, resolved: 2, closed: 3 })[status];
  const priorityRank = (priority: SupportTicketRecord["priority"]) => ({ urgent: 0, high: 1, normal: 2 })[priority];
  return right.supportRank - left.supportRank
    || statusRank(left.status) - statusRank(right.status)
    || Number(right.needsReply) - Number(left.needsReply)
    || priorityRank(left.priority) - priorityRank(right.priority)
    || Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
}
