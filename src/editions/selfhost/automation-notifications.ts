import type { AutomationNotificationAdapter, AutomationNotificationEvent } from "@/editions/contracts/automation-notifications";

export const automationNotificationAdapter: AutomationNotificationAdapter = Object.freeze({
  async deliver(event: AutomationNotificationEvent, signal: AbortSignal) {
    const endpoint = String(process.env.AUTOMATION_ALERT_WEBHOOK_URL || "").trim();
    if (!endpoint) return { channel: "in-app" };
    const url = new URL(endpoint);
    if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) {
      throw new Error("AUTOMATION_ALERT_WEBHOOK_URL must be an HTTP(S) URL without embedded credentials");
    }
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "Scenelith-Automation-Alerts/1" },
      body: JSON.stringify({ schemaVersion: 1, ...event }),
      signal,
    });
    if (!response.ok) throw new Error(`Automation alert webhook returned ${response.status}`);
    return { channel: "webhook" };
  },
});
