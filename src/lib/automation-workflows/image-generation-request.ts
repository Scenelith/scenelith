import { validateAutomationStructuredValue } from "./json-schema";
import { parseAutomationPortValue } from "./port-contracts";

export type AutomationImageGenerationRequest = {
  key: string;
  prompt: string;
  referenceAssetIds: string[];
  referenceRoles: string[];
  referenceLabels: string[];
  presentation: {
    index: number | null;
    role: string;
    overlayText: string;
    sourceAssetId: string | null;
  };
  metadata: Record<string, unknown>;
};

export type AutomationImageGenerationRequestBatch = {
  schemaVersion: 1;
  requests: AutomationImageGenerationRequest[];
};

const strings = { type: "array", items: { type: "string" } } as const;

export const automationImageGenerationRequestBatchSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "requests"],
  properties: {
    schemaVersion: { type: "integer", enum: [1] },
    requests: {
      type: "array",
      minItems: 1,
      maxItems: 5_000,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "prompt", "referenceAssetIds", "referenceRoles", "referenceLabels", "presentation", "metadata"],
        properties: {
          key: { type: "string", minLength: 1, maxLength: 160 },
          prompt: { type: "string", minLength: 1, maxLength: 200_000 },
          referenceAssetIds: strings,
          referenceRoles: strings,
          referenceLabels: strings,
          presentation: {
            type: "object",
            additionalProperties: false,
            required: ["index", "role", "overlayText", "sourceAssetId"],
            properties: {
              index: {},
              role: { type: "string", minLength: 1, maxLength: 240 },
              overlayText: { type: "string", maxLength: 200_000 },
              sourceAssetId: {},
            },
          },
          metadata: { type: "object" },
        },
      },
    },
  },
} as const;

export function parseAutomationImageGenerationRequestBatch(value: unknown): AutomationImageGenerationRequestBatch {
  parseAutomationPortValue("data", value);
  const errors = validateAutomationStructuredValue(value, automationImageGenerationRequestBatchSchema as unknown as Record<string, unknown>);
  if (errors.length) throw new Error(`Image requests do not match the supported contract: ${errors.slice(0, 8).join("; ")}`);
  const batch = value as AutomationImageGenerationRequestBatch;
  const keys = new Set<string>();
  for (const [index, request] of batch.requests.entries()) {
    if (!request.key.trim()) throw new Error(`Image request ${index + 1} has an empty key`);
    if (keys.has(request.key)) throw new Error(`Image request key ${request.key} appears more than once`);
    keys.add(request.key);
    if (!request.prompt.trim()) throw new Error(`Image request ${request.key} has an empty prompt`);
    const count = request.referenceAssetIds.length;
    if (request.referenceRoles.length !== count || request.referenceLabels.length !== count) {
      throw new Error(`Image request ${request.key} must provide exactly one role and label for every reference asset`);
    }
    if (new Set(request.referenceAssetIds).size !== count) throw new Error(`Image request ${request.key} contains a duplicate reference asset`);
    if (request.referenceAssetIds.some((entry) => !entry.trim()) || request.referenceRoles.some((entry) => !entry.trim()) || request.referenceLabels.some((entry) => !entry.trim())) {
      throw new Error(`Image request ${request.key} contains an empty reference id, role or label`);
    }
    if (request.presentation.index !== null && (!Number.isSafeInteger(request.presentation.index) || request.presentation.index < 1)) {
      throw new Error(`Image request ${request.key} presentation index must be a positive integer or null`);
    }
    if (!request.presentation.role.trim()) throw new Error(`Image request ${request.key} has an empty presentation role`);
    if (request.presentation.sourceAssetId !== null && (typeof request.presentation.sourceAssetId !== "string" || !request.presentation.sourceAssetId.trim())) {
      throw new Error(`Image request ${request.key} presentation source must be a non-empty asset id or null`);
    }
  }
  return batch;
}
