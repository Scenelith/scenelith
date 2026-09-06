import type { TaskCreditUsage } from "@/modules/usage/contracts";

export function taskCreditLabel(usage: TaskCreditUsage | undefined) {
  if (!usage) return null;
  const n = (value: number) => value.toLocaleString("en-US");
  if (usage.status === "unavailable") return "Credit usage unavailable";
  if (usage.status === "not_charged") return "0 credits spent";
  const parts = [];
  if (usage.chargedCredits > 0 || usage.status === "settled" || usage.status === "refunded") parts.push(`${n(usage.chargedCredits)} credits spent`);
  if (usage.reservedCredits > 0) parts.push(`${n(usage.reservedCredits)} credits reserved`);
  if (usage.refundedCredits > 0) parts.push(`${n(usage.refundedCredits)} returned`);
  if (usage.expiredCredits > 0) parts.push(`${n(usage.expiredCredits)} expired`);
  return parts.join(" · ") || "0 credits spent";
}
