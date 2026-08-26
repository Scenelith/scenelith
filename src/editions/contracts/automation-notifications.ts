export type AutomationNotificationEvent = Readonly<{
  id: string;
  workspaceId: string;
  type: "trigger-delivery-failed" | "trigger-delivery-recovered";
  payload: Readonly<{
    alertId: string;
    deliveryId: string;
    workflowId: string;
    projectId: string;
    triggerName: string;
    code: string;
    message: string;
  }>;
}>;

export interface AutomationNotificationAdapter {
  deliver(event: AutomationNotificationEvent, signal: AbortSignal): Promise<{ channel: string }>;
}
