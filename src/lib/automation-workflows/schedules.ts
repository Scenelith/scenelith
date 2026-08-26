import { Cron } from "croner";
import { z } from "zod";

const timezoneSchema = z.string().min(1).max(100).superRefine((timezone, context) => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date()); }
  catch { context.addIssue({ code: "custom", message: "Use a valid IANA timezone such as America/New_York" }); }
});

export const automationScheduleConfigSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("calendar"),
    cron: z.string().trim().min(1).max(160),
    timezone: timezoneSchema,
    misfirePolicy: z.enum(["skip", "catch-up-once"]).default("catch-up-once"),
  }).strict(),
  z.object({
    mode: z.literal("interval"),
    everyMinutes: z.number().int().min(1).max(525_600),
    misfirePolicy: z.enum(["skip", "catch-up-once"]).default("catch-up-once"),
  }).strict(),
]).superRefine((config, context) => {
  if (config.mode !== "calendar") return;
  if (config.cron.trim().split(/\s+/).length !== 5) {
    context.addIssue({ code: "custom", message: "Calendar schedules use five cron fields: minute hour day month weekday" });
    return;
  }
  try {
    const next = new Cron(config.cron, { timezone: config.timezone, paused: true }).nextRun(new Date());
    if (!next) context.addIssue({ code: "custom", message: "This calendar expression has no future occurrence" });
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid calendar schedule" });
  }
});

export type AutomationScheduleConfig = z.infer<typeof automationScheduleConfigSchema>;

export function parseAutomationScheduleConfig(value: unknown): AutomationScheduleConfig {
  const legacy = value && typeof value === "object" && !Array.isArray(value) && "everyMinutes" in value && !("mode" in value)
    ? { mode: "interval", everyMinutes: Number((value as { everyMinutes: unknown }).everyMinutes), misfirePolicy: "catch-up-once" }
    : value;
  return automationScheduleConfigSchema.parse(legacy);
}

export function nextAutomationScheduleAt(configValue: unknown, after: Date | string = new Date()) {
  const config = parseAutomationScheduleConfig(configValue);
  const base = typeof after === "string" ? new Date(after) : after;
  if (!Number.isFinite(base.getTime())) throw new Error("Schedule base time is invalid");
  if (config.mode === "interval") return new Date(base.getTime() + config.everyMinutes * 60_000).toISOString();
  const next = new Cron(config.cron, { timezone: config.timezone, paused: true }).nextRun(base);
  if (!next) throw new Error("This calendar schedule has no future occurrence");
  return next.toISOString();
}

export function defaultAutomationScheduleConfig(timezone = "UTC"): AutomationScheduleConfig {
  return { mode: "calendar", cron: "0 9 * * 1-5", timezone, misfirePolicy: "catch-up-once" };
}
