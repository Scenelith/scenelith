export type AutomationRetentionPolicy = Readonly<{
  successfulRunDays: number;
  failedRunDays: number;
  deliveryDays: number;
  productEventDays: number;
  notificationDays: number;
  fixtureDays: number | null;
}>;
