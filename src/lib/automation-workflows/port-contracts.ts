import { z } from "zod";
import type { AutomationPortType } from "./types";

const boundedText = z.string().max(200_000);
const idText = z.string().min(1).max(240);
const jsonPrimitive = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
type AutomationJson = string | number | boolean | null | AutomationJson[] | { [key: string]: AutomationJson };
const jsonValue: z.ZodType<AutomationJson> = z.lazy(() => z.union([
  jsonPrimitive,
  z.array(jsonValue).max(100_000),
  z.record(z.string().max(240), jsonValue),
]));

const storedImageSchema = z.object({
  id: idText,
  filename: boundedText,
  role: boundedText,
  path: boundedText,
  mimeType: z.string().regex(/^image\//),
  analysisPath: boundedText,
  analysisMimeType: z.string().regex(/^image\//),
}).strict();

const creativeControlValueSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const creativeControlSchema = z.object({
  id: idText,
  label: boundedText,
  path: idText,
  options: z.array(z.object({ id: idText, label: boundedText, value: creativeControlValueSchema, meaning: boundedText }).strict()).min(2).max(12),
}).strict();
const creativeRequirementOptionSchema = z.object({ id: idText, label: boundedText, meaning: boundedText }).strict();
const creativeClauseSchema = z.object({ id: idText, text: boundedText, start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).strict();
const creativeDirectionRequestSchemaV4 = z.object({
  contractVersion: z.literal(4),
  briefHash: z.string().length(64),
  rawBrief: boundedText,
  clauses: z.array(creativeClauseSchema).max(1),
  settings: z.record(z.string(), jsonValue),
  settingsNodeId: z.string().max(240),
  briefPath: idText,
  policyPath: idText,
  resultPath: idText,
  controls: z.array(creativeControlSchema).min(1).max(24),
  requirementCategories: z.array(creativeRequirementOptionSchema).min(1).max(24),
  requirementPlacements: z.array(creativeRequirementOptionSchema).min(1).max(24),
  policy: z.enum(["strict", "propose", "auto-explicit"]),
  sourceSlideIndexes: z.array(z.number().int().positive()).min(1).max(5_000),
  minConfidence: z.number().finite().min(0.5).max(1),
  maxRequirements: z.number().int().min(1).max(80),
  allowIgnoredClauses: z.boolean(),
}).strict();
const creativeDirectionRequestSchemaV3 = z.object({
  contractVersion: z.literal(3),
  briefHash: z.string().length(64),
  rawBrief: boundedText,
  clauses: z.array(creativeClauseSchema).max(1),
  settings: z.record(z.string(), jsonValue),
  settingsNodeId: z.string().max(240),
  controls: z.array(creativeControlSchema).min(1).max(24),
  requirementCategories: z.array(creativeRequirementOptionSchema).min(1).max(24),
  requirementPlacements: z.array(creativeRequirementOptionSchema).min(1).max(24),
  policy: z.enum(["strict", "propose", "auto-explicit"]),
  sourceSlideIndexes: z.array(z.number().int().positive()).min(1).max(5_000),
  minConfidence: z.number().finite().min(0.5).max(1),
  maxRequirements: z.number().int().min(1).max(80),
  allowIgnoredClauses: z.boolean(),
}).strict();
const legacyCreativeDirectionRequestSchema = z.object({
  contractVersion: z.literal(2),
  briefHash: z.string().length(64),
  rawBrief: boundedText,
  clauses: z.array(creativeClauseSchema).max(40),
  settings: z.record(z.string(), jsonValue),
  controls: z.array(creativeControlSchema).min(1).max(24),
  policy: z.enum(["strict", "propose", "auto-explicit"]),
  sourceSlideIndexes: z.array(z.number().int().positive()).min(1).max(5_000),
  minConfidence: z.number().finite().min(0.5).max(1),
  maxRequirements: z.number().int().min(1).max(80),
  maxClauseCharacters: z.number().int().min(100).max(2_000),
  allowIgnoredClauses: z.boolean(),
}).strict();
const creativeDirectionAnalysisSchema = z.object({
  briefHash: z.string().length(64),
  clauseResults: z.array(z.object({
    clauseId: idText,
    items: z.array(z.object({
      kind: z.enum(["choice", "requirement", "ambiguity", "ignore"]),
      evidence: z.string().min(1).max(20_000),
      evidenceStart: z.number().int().nonnegative(),
      evidenceEnd: z.number().int().positive(),
      controlId: z.string().max(240),
      optionId: z.string().max(240),
      instruction: boundedText,
      category: z.string().max(240),
      placement: z.string().max(240),
      slideIndexes: z.array(z.number().int().positive()).max(5_000),
      confidence: z.number().finite().min(0).max(1),
      reason: boundedText,
    }).strict()).min(1).max(16),
  }).strict()).max(40),
}).strict();

const generatedAssetsSchema = z.object({
  items: z.array(z.object({
    requestKey: idText,
    prompt: z.string().min(1).max(200_000),
    referenceAssetIds: z.array(idText).max(64),
    referenceRoles: z.array(idText).max(64),
    referenceLabels: z.array(z.string().min(1).max(240)).max(64),
    presentation: z.object({
      index: z.union([z.number().int().positive(), z.null()]),
      role: z.string().min(1).max(240),
      overlayText: boundedText,
      sourceAssetId: z.union([idText, z.null()]),
    }).strict(),
    metadata: z.record(z.string(), jsonValue),
    nodeId: idText,
    generationId: idText,
    modelId: idText,
    aspectRatio: idText,
    resolution: idText,
    outputUrl: z.string().min(1).max(4_000),
    assetId: idText,
    creditCost: z.number().finite().nonnegative(),
  }).strict().superRefine((item, context) => {
    if (item.referenceRoles.length !== item.referenceAssetIds.length) context.addIssue({ code: "custom", path: ["referenceRoles"], message: "must contain one role for every reference asset" });
    if (item.referenceLabels.length !== item.referenceAssetIds.length) context.addIssue({ code: "custom", path: ["referenceLabels"], message: "must contain one label for every reference asset" });
  })).min(1).max(5_000),
  failures: z.array(z.object({ key: idText, error: boundedText }).strict()).max(5_000),
  model: z.object({ id: idText, label: boundedText }).strict(),
  effectiveSettings: z.object({
    aspectRatio: idText,
    resolution: idText,
    concurrency: z.number().int().positive().max(32),
    attempts: z.number().int().positive().max(8),
  }).strict(),
}).strict();

const legacyGeneratedAssetsSchema = z.object({
  items: z.array(z.object({
    index: z.number().int().positive(),
    role: boundedText,
    prompt: z.string().min(1).max(200_000),
    referenceAssetIds: z.array(idText).max(64),
    overlayText: boundedText,
    sourceAssetId: idText,
    nodeId: idText,
    generationId: idText,
    modelId: idText,
    aspectRatio: idText,
    resolution: idText,
    outputUrl: z.string().min(1).max(4_000),
    assetId: idText,
    creditCost: z.number().finite().nonnegative(),
  }).passthrough()).min(1).max(5_000),
  failures: z.array(z.object({ index: z.number().int().positive(), error: boundedText }).strict()).max(5_000),
  model: z.object({
    id: idText,
    label: boundedText,
    defaultRatio: idText,
    defaultResolution: idText,
  }).strict(),
}).strict();

const contracts: Partial<Record<AutomationPortType, z.ZodTypeAny>> = {
  "run-context": z.object({
    runId: idText,
    projectId: idText,
    startedBy: idText,
    trigger: jsonValue,
  }).strict(),
  "tiktok-source": z.object({
    sourceNodeId: idText,
    label: boundedText,
    caption: boundedText,
    slides: z.array(z.object({
      index: z.number().int().positive(),
      assetId: idText,
      filename: boundedText,
      path: boundedText,
      mimeType: z.string().regex(/^image\//),
      analysisPath: boundedText,
      analysisMimeType: z.string().regex(/^image\//),
      title: boundedText,
    }).strict()).min(1).max(5_000),
  }).strict(),
  identity: z.union([z.null(), z.object({
    id: idText,
    name: boundedText,
    notes: boundedText,
    assets: z.array(storedImageSchema).max(5_000),
  }).strict()]),
  "visual-references": z.object({
    assetIds: z.array(idText).max(5_000),
    assets: z.array(storedImageSchema).max(5_000),
  }).strict().superRefine((value, context) => {
    if (value.assetIds.length !== value.assets.length || value.assetIds.some((id, index) => value.assets[index]?.id !== id)) {
      context.addIssue({ code: "custom", message: "assetIds and assets must describe the same ordered references" });
    }
    if (new Set(value.assetIds).size !== value.assetIds.length) context.addIssue({ code: "custom", message: "reference ids must be unique" });
  }),
  "creative-settings": z.object({
    mode: z.enum(["concept", "identity"]),
    newOutfit: z.boolean(),
    newLocation: z.boolean(),
    textStrategy: z.enum(["keep", "rewrite", "remove"]),
    creativeBrief: boundedText,
    creativeDirectionPolicy: z.enum(["strict", "propose", "auto-explicit"]),
  }).strict(),
  "creative-direction-request": z.union([creativeDirectionRequestSchemaV4, creativeDirectionRequestSchemaV3, legacyCreativeDirectionRequestSchema]),
  "creative-direction-analysis": creativeDirectionAnalysisSchema,
  "resolved-creative-settings": z.record(z.string(), jsonValue),
  "generated-assets": z.union([generatedAssetsSchema, legacyGeneratedAssetsSchema]),
  "canvas-result": z.union([
    z.object({ preview: z.literal(true), sourceNodeId: z.string().max(240), added: z.number().int().positive(), failures: z.array(jsonValue), message: boundedText }).strict(),
    z.object({ nodeIds: z.array(idText).min(1), noteId: z.union([idText, z.null()]), sourceNodeId: z.string().max(240), added: z.number().int().positive(), failures: z.array(jsonValue) }).strict(),
  ]),
  "workflow-result": z.object({ outcome: z.literal("completed"), message: boundedText, data: jsonValue }).strict(),
  error: z.object({
    message: z.string().min(1).max(20_000),
    nodeId: idText.optional(),
    code: z.string().min(1).max(160).optional(),
    response: jsonValue.optional(),
  }).catchall(jsonValue),
};

export type AutomationGeneratedAssets = z.infer<typeof generatedAssetsSchema>;

function rawJsonIssue(value: unknown, path = "value", depth = 0, counter = { entries: 0 }): string | null {
  counter.entries += 1;
  if (counter.entries > 200_000) return "contains more than 200,000 JSON values";
  if (depth > 100) return `${path} is nested more than 100 levels`;
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? null : `${path} contains a non-finite number`;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const issue = rawJsonIssue(item, `${path}.${index}`, depth + 1, counter);
      if (issue) return issue;
    }
    return null;
  }
  if (!value || typeof value !== "object") return `${path} is not a JSON value`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return `${path} is not a plain JSON object`;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) return `${path}.${key} uses a reserved object key`;
    const issue = rawJsonIssue(item, `${path}.${key}`, depth + 1, counter);
    if (issue) return issue;
  }
  return null;
}

function formatIssues(error: z.ZodError) {
  return error.issues.slice(0, 8).map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`).join("; ");
}

export function parseAutomationPortValue(type: AutomationPortType, value: unknown) {
  const rawIssue = rawJsonIssue(value);
  if (rawIssue) throw new Error(`${type} does not match its port contract: ${rawIssue}`);
  const schema = contracts[type] || jsonValue;
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`${type} does not match its port contract: ${formatIssues(result.error)}`);
  return result.data;
}

export function parseAutomationGeneratedAssets(value: unknown) {
  const parsed = parseAutomationPortValue("generated-assets", value) as z.infer<typeof generatedAssetsSchema> | z.infer<typeof legacyGeneratedAssetsSchema>;
  if ("effectiveSettings" in parsed) return parsed as AutomationGeneratedAssets;
  const first = parsed.items[0];
  return {
    items: parsed.items.map((item) => {
      const promptContract = item.promptContract && typeof item.promptContract === "object" && !Array.isArray(item.promptContract)
        ? item.promptContract as Record<string, unknown>
        : {};
      const referencePlan = Array.isArray(promptContract.reference_plan) ? promptContract.reference_plan : [];
      const referenceLabels = item.referenceAssetIds.map((_, index) => {
        const binding = referencePlan[index];
        return binding && typeof binding === "object" && !Array.isArray(binding) && typeof (binding as Record<string, unknown>).token === "string"
          ? String((binding as Record<string, unknown>).token)
          : `@reference_${index + 1}`;
      });
      return {
        requestKey: String(item.index),
        prompt: item.prompt,
        referenceAssetIds: item.referenceAssetIds,
        referenceRoles: item.referenceAssetIds.map(() => "reference-image"),
        referenceLabels,
        presentation: { index: item.index, role: item.role, overlayText: item.overlayText, sourceAssetId: item.sourceAssetId },
        metadata: item as unknown as Record<string, AutomationJson>,
        nodeId: item.nodeId,
        generationId: item.generationId,
        modelId: item.modelId,
        aspectRatio: item.aspectRatio,
        resolution: item.resolution,
        outputUrl: item.outputUrl,
        assetId: item.assetId,
        creditCost: item.creditCost,
      };
    }),
    failures: parsed.failures.map((failure) => ({ key: String(failure.index), error: failure.error })),
    model: { id: parsed.model.id, label: parsed.model.label },
    effectiveSettings: {
      aspectRatio: first.aspectRatio || parsed.model.defaultRatio,
      resolution: first.resolution || parsed.model.defaultResolution,
      concurrency: 1,
      attempts: 1,
    },
  } satisfies AutomationGeneratedAssets;
}

export function parseCurrentAutomationGeneratedAssets(value: unknown): AutomationGeneratedAssets {
  const rawIssue = rawJsonIssue(value);
  if (rawIssue) throw new Error(`generated-assets does not match its current contract: ${rawIssue}`);
  const result = generatedAssetsSchema.safeParse(value);
  if (!result.success) throw new Error(`generated-assets does not match its current contract: ${formatIssues(result.error)}`);
  return result.data;
}
