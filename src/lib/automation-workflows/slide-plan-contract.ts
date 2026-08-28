import { imageGenerationPromptJsonSchema, type ImageGenerationPromptContract } from "../generation-prompt-contract";
import { validateAutomationStructuredValue } from "./json-schema";

export type AutomationTextStrategy = "keep" | "rewrite" | "remove";

export type AutomationSlidePlan = {
  index: number;
  role: string;
  prompt: ImageGenerationPromptContract;
  referenceAssetIds: string[];
  text: {
    strategy: AutomationTextStrategy;
    sourceText: string;
    overlayText: string;
    instruction: string;
  };
  confidence: number;
};

export type AutomationSlidePlanCollection = {
  slides: AutomationSlidePlan[];
};

export type AutomationSlidePlanSet = {
  schemaVersion: 2;
  contract: Record<string, unknown> | null;
  decisions: {
    newOutfit: boolean;
    newLocation: boolean;
    textStrategy: AutomationTextStrategy;
  } | null;
  slides: AutomationSlidePlan[];
};

const text = { type: "string" } as const;
const strings = { type: "array", items: text } as const;

export const automationSlidePlanJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["index", "role", "prompt", "referenceAssetIds", "text", "confidence"],
  properties: {
    index: { type: "integer", minimum: 1 },
    role: text,
    prompt: imageGenerationPromptJsonSchema,
    referenceAssetIds: strings,
    text: {
      type: "object",
      additionalProperties: false,
      required: ["strategy", "sourceText", "overlayText", "instruction"],
      properties: {
        strategy: { type: "string", enum: ["keep", "rewrite", "remove"] },
        sourceText: text,
        overlayText: text,
        instruction: text,
      },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

export const automationSlidePlanCollectionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["slides"],
  properties: {
    slides: { type: "array", minItems: 1, items: automationSlidePlanJsonSchema },
  },
} as const;

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function structuredContractError(label: string, errors: string[]) {
  return new Error(`${label} does not match the one supported slide-plan contract: ${errors.slice(0, 6).join("; ")}`);
}

function nonEmpty(value: string) {
  return value.trim().length > 0;
}

function slideSemanticErrors(slide: AutomationSlidePlan, position: number) {
  const path = `slides[${position}]`;
  const errors: string[] = [];
  if (!nonEmpty(slide.role)) errors.push(`${path}.role must not be empty`);
  if (!nonEmpty(slide.prompt.title)) errors.push(`${path}.prompt.title must not be empty`);
  if (!nonEmpty(slide.prompt.task)) errors.push(`${path}.prompt.task must not be empty`);
  if (!nonEmpty(slide.prompt.output.format)) errors.push(`${path}.prompt.output.format must not be empty`);
  if (!nonEmpty(slide.text.instruction)) errors.push(`${path}.text.instruction must not be empty`);
  const emptyReferenceId = slide.referenceAssetIds.findIndex((assetId) => !nonEmpty(assetId));
  if (emptyReferenceId >= 0) errors.push(`${path}.referenceAssetIds[${emptyReferenceId}] must not be empty`);
  if (new Set(slide.referenceAssetIds).size !== slide.referenceAssetIds.length) errors.push(`${path}.referenceAssetIds must not contain duplicates`);
  if (slide.prompt.reference_plan.length !== slide.referenceAssetIds.length + 1) {
    errors.push(`${path}.prompt.reference_plan must contain the automatic source first and exactly one binding per referenceAssetIds entry`);
  }
  slide.prompt.reference_plan.forEach((binding, bindingIndex) => {
    if (!nonEmpty(binding.token) || !nonEmpty(binding.title) || !nonEmpty(binding.role) || !nonEmpty(binding.instruction)) {
      errors.push(`${path}.prompt.reference_plan[${bindingIndex}] must contain non-empty token, title, role and instruction`);
    }
  });
  if (slide.prompt.reference_plan[0]?.role !== "source composition") {
    errors.push(`${path}.prompt.reference_plan[0].role must equal source composition`);
  }
  return errors;
}

export function parseAutomationSlidePlanCollection(value: unknown, label = "Slide plans"): AutomationSlidePlanCollection {
  const errors = validateAutomationStructuredValue(value, automationSlidePlanCollectionJsonSchema as unknown as Record<string, unknown>);
  if (errors.length) throw structuredContractError(label, errors);
  const collection = value as AutomationSlidePlanCollection;
  const semanticErrors = collection.slides.flatMap(slideSemanticErrors);
  if (semanticErrors.length) throw structuredContractError(label, semanticErrors);
  return collection;
}

export function parseAutomationSlidePlanSet(value: unknown, label = "Checked slide plans"): AutomationSlidePlanSet {
  const record = recordValue(value);
  if (!record) throw structuredContractError(label, ["value must be an object"]);
  const allowedKeys = new Set(["schemaVersion", "contract", "decisions", "slides"]);
  const unknownKeys = Object.keys(record).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length) throw structuredContractError(label, [`unknown fields: ${unknownKeys.join(", ")}`]);
  if (record.schemaVersion !== 2) throw structuredContractError(label, ["schemaVersion must equal 2"]);
  if (record.contract !== null && !recordValue(record.contract)) throw structuredContractError(label, ["contract must be an object or null"]);
  if (record.decisions !== null) {
    const decisions = recordValue(record.decisions);
    const decisionKeys = decisions ? Object.keys(decisions) : [];
    if (!decisions
      || decisionKeys.length !== 3
      || !decisionKeys.every((key) => ["newOutfit", "newLocation", "textStrategy"].includes(key))
      || typeof decisions.newOutfit !== "boolean"
      || typeof decisions.newLocation !== "boolean"
      || (decisions.textStrategy !== "keep" && decisions.textStrategy !== "rewrite" && decisions.textStrategy !== "remove")) {
      throw structuredContractError(label, ["decisions must contain exactly newOutfit, newLocation and textStrategy"]);
    }
  }
  const collection = parseAutomationSlidePlanCollection({ slides: record.slides }, label);
  return { ...record, slides: collection.slides } as AutomationSlidePlanSet;
}
