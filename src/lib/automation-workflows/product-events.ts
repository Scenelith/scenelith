import { z } from "zod";

export const AUTOMATION_PRODUCT_EVENT_NAMES = ["tiktok.imported", "generation.completed"] as const;
export type AutomationProductEventName = (typeof AUTOMATION_PRODUCT_EVENT_NAMES)[number];

const eventContracts = {
  "tiktok.imported": {
    1: z.object({
      sourceUrl: z.string().url().max(2_000),
      assetIds: z.array(z.string().min(1).max(200)).min(1).max(500),
      title: z.string().max(1_000).default(""),
    }).strict(),
  },
  "generation.completed": {
    1: z.object({
      generationId: z.string().min(1).max(200),
      nodeId: z.string().min(1).max(200),
      assetId: z.string().min(1).max(200),
      mediaType: z.enum(["image", "video"]),
      operation: z.enum(["generation", "edit"]),
    }).strict(),
  },
} satisfies Record<AutomationProductEventName, Record<number, z.ZodType>>;

export type AutomationProductEventVersion = 1;

export function latestAutomationProductEventVersion(name: AutomationProductEventName): AutomationProductEventVersion {
  void name;
  return 1;
}

export function assertAutomationProductEventVersion(name: string, version: number) {
  if (!AUTOMATION_PRODUCT_EVENT_NAMES.includes(name as AutomationProductEventName)) {
    throw Object.assign(new Error(`Unsupported product event ${name}`), { code: "PRODUCT_EVENT_UNSUPPORTED" });
  }
  if (!eventContracts[name as AutomationProductEventName][version as AutomationProductEventVersion]) {
    throw Object.assign(new Error(`Unsupported ${name} event version ${version}`), { code: "PRODUCT_EVENT_VERSION_UNSUPPORTED" });
  }
}

export function parseAutomationProductEvent(input: { name: string; version?: number; payload: unknown }) {
  if (!AUTOMATION_PRODUCT_EVENT_NAMES.includes(input.name as AutomationProductEventName)) {
    throw Object.assign(new Error(`Unsupported product event ${input.name}`), { code: "PRODUCT_EVENT_UNSUPPORTED" });
  }
  const name = input.name as AutomationProductEventName;
  const version = input.version ?? latestAutomationProductEventVersion(name);
  const schema = eventContracts[name][version as AutomationProductEventVersion];
  if (!schema) throw Object.assign(new Error(`Unsupported ${name} event version ${version}`), { code: "PRODUCT_EVENT_VERSION_UNSUPPORTED" });
  const parsed = schema.safeParse(input.payload);
  if (!parsed.success) {
    throw Object.assign(new Error(`Invalid ${name}@${version} payload: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`), { code: "PRODUCT_EVENT_PAYLOAD_INVALID" });
  }
  return { name, version: version as AutomationProductEventVersion, payload: parsed.data as Record<string, unknown> };
}
