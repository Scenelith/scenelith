import type { AutomationRetentionPolicy } from "@/editions/contracts/automation-retention";

function retentionDays(name: string, fallback: number, nullable = false) {
  const raw = String(process.env[name] || "").trim();
  if (!raw && nullable) return null;
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < 1 || value > 3_650) throw new Error(`${name} must be an integer from 1 to 3650 days`);
  return value;
}

export function automationRetentionPolicy(): AutomationRetentionPolicy {
  return {
    successfulRunDays: retentionDays("AUTOMATION_SUCCESSFUL_RUN_RETENTION_DAYS", 30)!,
    failedRunDays: retentionDays("AUTOMATION_FAILED_RUN_RETENTION_DAYS", 90)!,
    deliveryDays: retentionDays("AUTOMATION_DELIVERY_RETENTION_DAYS", 90)!,
    productEventDays: retentionDays("AUTOMATION_PRODUCT_EVENT_RETENTION_DAYS", 30)!,
    notificationDays: retentionDays("AUTOMATION_NOTIFICATION_RETENTION_DAYS", 30)!,
    fixtureDays: retentionDays("AUTOMATION_FIXTURE_RETENTION_DAYS", 0, true),
  };
}
