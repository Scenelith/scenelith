import { z } from "zod";
import { parseAutomationPortValue } from "./port-contracts";

const jsonObjectSchema = z.record(z.string(), z.unknown());

export const automationTriggerEnvelopeSchema = z.discriminatedUnion("type", [
  z.object({
    contractVersion: z.literal(1),
    type: z.literal("webhook"),
    payload: jsonObjectSchema,
  }).strict(),
  z.object({
    contractVersion: z.literal(1),
    type: z.literal("schedule"),
    payload: z.object({ scheduledAt: z.iso.datetime() }).strict(),
  }).strict(),
  z.object({
    contractVersion: z.literal(1),
    type: z.literal("canvas-event"),
    event: z.string().trim().min(1).max(120),
    eventVersion: z.number().int().positive(),
    payload: jsonObjectSchema,
  }).strict(),
  z.object({
    contractVersion: z.literal(1),
    type: z.literal("subworkflow"),
    payload: z.unknown(),
  }).strict(),
]);

export type AutomationTriggerEnvelope = z.infer<typeof automationTriggerEnvelopeSchema>;

export function parseAutomationTriggerEnvelope(value: unknown): AutomationTriggerEnvelope {
  parseAutomationPortValue("data", value);
  return automationTriggerEnvelopeSchema.parse(value);
}

export function webhookTriggerEnvelope(payload: Record<string, unknown>): AutomationTriggerEnvelope {
  return parseAutomationTriggerEnvelope({ contractVersion: 1, type: "webhook", payload });
}

export function scheduleTriggerEnvelope(scheduledAt: string): AutomationTriggerEnvelope {
  return parseAutomationTriggerEnvelope({ contractVersion: 1, type: "schedule", payload: { scheduledAt } });
}

export function canvasEventTriggerEnvelope(input: { event: string; eventVersion: number; payload: Record<string, unknown> }): AutomationTriggerEnvelope {
  return parseAutomationTriggerEnvelope({ contractVersion: 1, type: "canvas-event", ...input });
}

export function subworkflowTriggerEnvelope(payload: unknown): AutomationTriggerEnvelope {
  return parseAutomationTriggerEnvelope({ contractVersion: 1, type: "subworkflow", payload });
}
