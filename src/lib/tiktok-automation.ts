import { requestOpenRouter } from "./openrouter";
import { readStorageObject, signedStorageReadUrl } from "./storage";
import type {
  TikTokAutomationAnalysis,
  TikTokAutomationDirection,
  TikTokAutomationIntentContract,
  TikTokAutomationMode,
  TikTokAutomationPreferences,
  TikTokAutomationReferenceBindingPlan,
  TikTokAutomationSemanticContract,
  TikTokAutomationSlideContract,
  TikTokAutomationSlideIntent,
  TikTokAutomationSlidePlan,
  TikTokReferenceObservation,
} from "./tiktok-automation-types";

export const TIKTOK_AUTOMATION_PIPELINE_VERSION = "15";

export type TikTokAutomationSourceSlide = {
  index: number;
  assetId: string;
  path: string;
  mimeType: string;
  analysisPath?: string;
  analysisMimeType?: string;
  title: string;
};

export type TikTokAutomationPersonaContext = {
  name: string;
  notes: string;
  hasReference: boolean;
  hasBefore: boolean;
  hasAfter: boolean;
};

export type TikTokAutomationPersonaAsset = {
  id: string;
  filename: string;
  role: "reference" | "before" | "after";
  path: string;
  mimeType: string;
  analysisPath?: string;
  analysisMimeType?: string;
};

type OpenRouterContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

const formatValues = ["transformation", "story", "list", "tutorial", "comparison", "aesthetic", "other"] as const;
const roleValues = ["hook", "context", "before", "turn", "after", "payoff", "cta", "other"] as const;
const variantValues = ["reference", "before", "after", "none"] as const;
const faceVisibilityValues = ["clear", "partial", "not_visible"] as const;
const faceAngleValues = ["front", "three_quarter", "profile", "rear_or_obscured"] as const;
const faceDetailValues = ["high", "medium", "low", "none"] as const;
const bodyFramingValues = ["face_closeup", "upper_body", "three_quarter_body", "full_body", "other"] as const;
const identitySignalValues = ["face", "profile", "hair", "body", "pose_or_form"] as const;
const plannedFaceVisibilityValues = ["prominent", "visible", "incidental", "hidden"] as const;
const identityEvidenceNeedValues = ["face_identity", "profile_identity", "body_identity", "pose_or_form"] as const;

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.map((item) => stringValue(item)).filter(Boolean) : [];
}

function numberList(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0)
    : [];
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const transientProviderError = /\b(?:429|500|502|503|504)\b|timeout|timed out|fetch failed|temporar|overload|rate.?limit|network/i;

export function tiktokAutomationRetryDelayMs(error: unknown, attempt: number, jitter = Math.random()) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (!transientProviderError.test(message)) return 0;
  const base = Math.min(8_000, 1_000 * (2 ** Math.max(0, attempt)));
  return base + Math.floor(base * 0.2 * Math.max(0, Math.min(1, jitter)));
}

async function waitForAutomationRetry(error: unknown, attempt: number, maxAttempts: number) {
  if (attempt >= maxAttempts - 1) return;
  const delay = tiktokAutomationRetryDelayMs(error, attempt);
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

async function imageContent(path: string, mimeType: string): Promise<OpenRouterContent> {
  // Keep multimodal requests small in production. Sending several original
  // images as base64 can exceed an upstream model host's request-body limit
  // before vision processing even starts. R2 URLs remain private and expire;
  // local development retains the data-URL fallback.
  const signedUrl = await signedStorageReadUrl(path, { expiresIn: 20 * 60 }).catch(() => null);
  if (signedUrl) return { type: "image_url", image_url: { url: signedUrl } };
  const bytes = await readStorageObject(path);
  return { type: "image_url", image_url: { url: `data:${mimeType};base64,${bytes.toString("base64")}` } };
}

function structuredResponse(name: string, schema: Record<string, unknown>) {
  return { type: "json_schema", json_schema: { name, strict: true, schema } };
}

function sameIntegerSet(actual: number[], expected: number[]) {
  const left = [...new Set(actual)].sort((a, b) => a - b);
  const right = [...new Set(expected)].sort((a, b) => a - b);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStringSet(actual: string[], expected: string[]) {
  const left = [...new Set(actual)].sort();
  const right = [...new Set(expected)].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

const PRESERVE_SOURCE_WARDROBE_INSTRUCTION = "Preserve the exact wardrobe, clothing, accessories, and styling visible in this slide's imported TikTok source image. Change only the person's identity; target identity references must not contribute or replace wardrobe.";
const PRESERVE_SOURCE_LOCATION_INSTRUCTION = "Preserve the exact location, background, environment, room layout, and visible setting details from this slide's imported TikTok source image. Change only the person's identity; target identity references must not contribute or replace location.";

function appendUnique(values: string[], value: string) {
  return values.includes(value) ? values : [...values, value];
}

export function enforceTikTokAutomationPreferenceContract(
  contract: TikTokAutomationIntentContract,
  preferences: TikTokAutomationPreferences,
): TikTokAutomationIntentContract {
  if (preferences.mode !== "identity") return contract;
  const slideIndexes = contract.slides.map((slide) => slide.index);
  const applicationPreferenceRequirementIds = new Set([
    "ui-preserve-source-wardrobe",
    "ui-preserve-source-location",
  ]);
  // The planner may describe the UI choices, but it cannot grant itself
  // ui_choices authority. Only deterministic requirements created here may
  // use that source of truth; otherwise a paraphrased, contradictory rule can
  // survive beside the real toggle state.
  const requirements = contract.requirements.filter((requirement) => (
    requirement.sourceOfTruth !== "ui_choices" || applicationPreferenceRequirementIds.has(requirement.id)
  ));
  const retainedRequirementIds = new Set(requirements.map((requirement) => requirement.id));
  const globalRules = [...contract.globalRules];
  const consistencyRules = [...contract.campaign.consistencyRules];
  let wardrobeDirection = contract.campaign.wardrobeDirection;
  let locationDirection = contract.campaign.locationDirection;
  const requiredBySlide = new Map(contract.slides.map((slide) => [
    slide.index,
    slide.requirementIds.filter((id) => retainedRequirementIds.has(id)),
  ]));
  const visualBySlide = new Map(contract.slides.map((slide) => [slide.index, [...slide.visualRequirements]]));
  const directiveBySlide = new Map(contract.slides.map((slide) => [slide.index, slide.directive]));

  const addPreservationRequirement = (input: { id: string; instruction: string; acceptanceCriteria: string[] }) => {
    const requirement = {
      id: input.id,
      instruction: input.instruction,
      appliesToSlideIndexes: slideIndexes,
      priority: "required" as const,
      sourceOfTruth: "ui_choices" as const,
      acceptanceCriteria: input.acceptanceCriteria,
    };
    const existingIndex = requirements.findIndex((item) => item.id === input.id);
    if (existingIndex >= 0) requirements[existingIndex] = requirement;
    else requirements.push(requirement);
    for (const index of slideIndexes) {
      requiredBySlide.set(index, appendUnique(requiredBySlide.get(index) || [], input.id));
      visualBySlide.set(index, appendUnique(visualBySlide.get(index) || [], input.instruction));
      const current = directiveBySlide.get(index) || "";
      directiveBySlide.set(index, current.includes(input.instruction) ? current : `${current} ${input.instruction}`.trim());
    }
    if (!globalRules.includes(input.instruction)) globalRules.push(input.instruction);
    if (!consistencyRules.includes(input.instruction)) consistencyRules.push(input.instruction);
  };

  if (!preferences.newOutfit) {
    wardrobeDirection = PRESERVE_SOURCE_WARDROBE_INSTRUCTION;
    addPreservationRequirement({
      id: "ui-preserve-source-wardrobe",
      instruction: PRESERVE_SOURCE_WARDROBE_INSTRUCTION,
      acceptanceCriteria: [
        "Every generated slide keeps the exact clothing, accessories, and styling visible in its own imported TikTok source slide.",
        "Target identity references affect identity only and do not supply wardrobe.",
      ],
    });
  }
  if (!preferences.newLocation) {
    locationDirection = PRESERVE_SOURCE_LOCATION_INSTRUCTION;
    addPreservationRequirement({
      id: "ui-preserve-source-location",
      instruction: PRESERVE_SOURCE_LOCATION_INSTRUCTION,
      acceptanceCriteria: [
        "Every generated slide keeps the exact background, environment, room layout, and setting visible in its own imported TikTok source slide.",
        "Target identity references affect identity only and do not supply location or background.",
      ],
    });
  }
  const preservation = [
    !preferences.newOutfit ? PRESERVE_SOURCE_WARDROBE_INSTRUCTION : "",
    !preferences.newLocation ? PRESERVE_SOURCE_LOCATION_INSTRUCTION : "",
  ].filter(Boolean).join(" ");
  return {
    ...contract,
    requirements,
    globalRules,
    campaign: { ...contract.campaign, wardrobeDirection, locationDirection, consistencyRules },
    sequence: {
      ...contract.sequence,
      slideDifferences: contract.sequence.slideDifferences.map((difference) => ({
        ...difference,
        instruction: preservation && !difference.instruction.includes(preservation)
          ? `${difference.instruction} ${preservation}`.trim()
          : difference.instruction,
      })),
    },
    slides: contract.slides.map((slide) => ({
      ...slide,
      requirementIds: requiredBySlide.get(slide.index) || slide.requirementIds,
      directive: directiveBySlide.get(slide.index) || slide.directive,
      visualRequirements: visualBySlide.get(slide.index) || slide.visualRequirements,
    })),
  };
}

export function buildTikTokAnalysisSchema(slideIndexes: number[]) {
  const minimum = Math.min(...slideIndexes);
  const maximum = Math.max(...slideIndexes);
  return {
  type: "object",
  additionalProperties: false,
  required: ["format", "summary", "theme", "narrativeArc", "language", "transformationBoundary", "slides"],
  properties: {
    format: { type: "string", enum: formatValues },
    summary: { type: "string" },
    theme: { type: "string" },
    narrativeArc: { type: "string" },
    language: { type: "string" },
    transformationBoundary: { type: "integer" },
    slides: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "role", "personaVariant", "visibleText", "visibleTextStyle", "visualBrief", "faceVisibility", "faceAngle", "faceDetail", "bodyFraming", "confidence"],
        properties: {
          index: { type: "integer", minimum, maximum },
          role: { type: "string", enum: roleValues },
          personaVariant: { type: "string", enum: variantValues },
          visibleText: { type: "string" },
          visibleTextStyle: { type: "string" },
          visualBrief: { type: "string" },
          faceVisibility: { type: "string", enum: faceVisibilityValues },
          faceAngle: { type: "string", enum: faceAngleValues },
          faceDetail: { type: "string", enum: faceDetailValues },
          bodyFraming: { type: "string", enum: bodyFramingValues },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
      minItems: slideIndexes.length,
      maxItems: slideIndexes.length,
    },
  },
  };
}

function parseAnalysis(payload: Record<string, unknown>, expectedIndexes: number[]): TikTokAutomationAnalysis {
  const slides = Array.isArray(payload.slides) ? payload.slides.map((entry) => {
    const item = objectValue(entry);
    return {
      index: Number(item.index),
      role: roleValues.includes(item.role as never) ? item.role as TikTokAutomationAnalysis["slides"][number]["role"] : "other",
      personaVariant: variantValues.includes(item.personaVariant as never) ? item.personaVariant as TikTokAutomationAnalysis["slides"][number]["personaVariant"] : "reference",
      visibleText: stringValue(item.visibleText),
      visibleTextStyle: stringValue(item.visibleTextStyle),
      visualBrief: stringValue(item.visualBrief),
      faceVisibility: faceVisibilityValues.includes(item.faceVisibility as never) ? item.faceVisibility as TikTokAutomationAnalysis["slides"][number]["faceVisibility"] : "not_visible",
      faceAngle: faceAngleValues.includes(item.faceAngle as never) ? item.faceAngle as TikTokAutomationAnalysis["slides"][number]["faceAngle"] : "rear_or_obscured",
      faceDetail: faceDetailValues.includes(item.faceDetail as never) ? item.faceDetail as TikTokAutomationAnalysis["slides"][number]["faceDetail"] : "none",
      bodyFraming: bodyFramingValues.includes(item.bodyFraming as never) ? item.bodyFraming as TikTokAutomationAnalysis["slides"][number]["bodyFraming"] : "other",
      confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0)),
    };
  }) : [];
  if (!sameIntegerSet(slides.map((slide) => slide.index), expectedIndexes)) throw new Error("analysis must contain every source slide exactly once");
  if (slides.some((slide) => !slide.visualBrief || (slide.visibleText && !slide.visibleTextStyle))) throw new Error("analysis is missing a visual or visible-text style brief");
  return {
    format: formatValues.includes(payload.format as never) ? payload.format as TikTokAutomationAnalysis["format"] : "other",
    summary: stringValue(payload.summary),
    theme: stringValue(payload.theme),
    narrativeArc: stringValue(payload.narrativeArc),
    language: stringValue(payload.language, "unknown"),
    transformationBoundary: Number.isInteger(Number(payload.transformationBoundary)) ? Number(payload.transformationBoundary) : 0,
    slides: slides.sort((a, b) => a.index - b.index),
  };
}

export async function analyzeTikTokSlideshow(input: { slides: TikTokAutomationSourceSlide[]; caption: string; onProgress?: (fraction: number, label: string) => void }) {
  const content: OpenRouterContent[] = [{
    type: "text",
    text: `Analyze this TikTok slideshow as source material. Caption: ${input.caption || "(none)"}\n\nFor every following image, use only the supplied slide index. Describe observable content and narrative function neutrally. Transcribe visibleText exactly. When text exists, visibleTextStyle must factually describe its typography category, weight, case, color, outline or shadow, alignment, placement, relative scale, and line treatment so a later stage can replace the wording without redesigning the text. When no text exists, visibleTextStyle is empty. Record the source subject's observable face visibility, angle, usable facial detail, and body framing conservatively. These fields describe composition evidence only and never authorize copying the source person's identity. A before/after label is sequencing metadata, never a quality judgement and never permission to degrade or improve any person, object, scene, visible state, styling, or image quality. Do not design the target recreation yet.`,
  }];
  for (const slide of input.slides) {
    content.push({ type: "text", text: `SOURCE SLIDE ${slide.index} — ${slide.title}` });
    content.push(await imageContent(slide.analysisPath || slide.path, slide.analysisMimeType || slide.mimeType));
  }
  let feedback = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    input.onProgress?.(Math.min(0.25, 0.08 + attempt * 0.08), attempt ? `Checking source analysis · retry ${attempt + 1}/3` : "Reading source slides");
    try {
      const payload = await requestOpenRouter({
        temperature: attempt === 2 ? 0 : 0.1,
        response_format: structuredResponse("tiktok_source_analysis", buildTikTokAnalysisSchema(input.slides.map((slide) => slide.index))),
        messages: [
          { role: "system", content: "You are the source-analysis stage in a multi-stage creative system. Report observable evidence and narrative mechanics only. Do not infer the target user's intent, do not write generation prompts, and do not turn Before/After into quality rankings." },
          { role: "user", content: feedback ? [...content, { type: "text", text: `Previous attempt failed: ${feedback}. Return a complete corrected analysis.` }] : content },
        ],
      });
      const parsed = parseAnalysis(payload, input.slides.map((slide) => slide.index));
      input.onProgress?.(1, "Source slides analyzed");
      return parsed;
    } catch (error) {
      feedback = error instanceof Error ? error.message : "invalid analysis";
      console.warn("TikTok source analysis attempt failed", { attempt: attempt + 1, error: feedback });
      await waitForAutomationRetry(error, attempt, 3);
    }
  }
  throw new Error("Source analysis could not be completed");
}

function buildObservationSchema(assets: TikTokAutomationPersonaAsset[]) {
  return {
  type: "object",
  additionalProperties: false,
  required: ["observations"],
  properties: {
    observations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["assetId", "role", "visualSummary", "observableAttributes", "usefulFor", "faceVisibility", "faceAngle", "faceDetail", "bodyFraming", "identitySignals", "captureStyle"],
        properties: {
          assetId: { type: "string", enum: assets.map((asset) => asset.id) },
          role: { type: "string", enum: ["reference", "before", "after"] },
          visualSummary: { type: "string" },
          observableAttributes: { type: "array", items: { type: "string" } },
          usefulFor: { type: "array", items: { type: "string" } },
          faceVisibility: { type: "string", enum: faceVisibilityValues },
          faceAngle: { type: "string", enum: faceAngleValues },
          faceDetail: { type: "string", enum: faceDetailValues },
          bodyFraming: { type: "string", enum: bodyFramingValues },
          identitySignals: { type: "array", items: { type: "string", enum: identitySignalValues } },
          captureStyle: { type: "string" },
        },
      },
      minItems: assets.length,
      maxItems: assets.length,
    },
  },
  };
}

function parseObservations(payload: Record<string, unknown>, assets: TikTokAutomationPersonaAsset[]) {
  const expected = new Map(assets.map((asset) => [asset.id, asset]));
  const observations = Array.isArray(payload.observations) ? payload.observations.map((entry) => {
    const item = objectValue(entry);
    const assetId = stringValue(item.assetId);
    const asset = expected.get(assetId);
    if (!asset) throw new Error(`unknown identity asset ${assetId || "(missing)"}`);
    if (item.role !== asset.role) throw new Error(`wrong role for identity asset ${assetId}`);
    return {
      assetId,
      role: asset.role,
      visualSummary: stringValue(item.visualSummary),
      observableAttributes: stringList(item.observableAttributes),
      usefulFor: stringList(item.usefulFor),
      faceVisibility: faceVisibilityValues.includes(item.faceVisibility as never) ? item.faceVisibility as TikTokReferenceObservation["faceVisibility"] : "not_visible",
      faceAngle: faceAngleValues.includes(item.faceAngle as never) ? item.faceAngle as TikTokReferenceObservation["faceAngle"] : "rear_or_obscured",
      faceDetail: faceDetailValues.includes(item.faceDetail as never) ? item.faceDetail as TikTokReferenceObservation["faceDetail"] : "none",
      bodyFraming: bodyFramingValues.includes(item.bodyFraming as never) ? item.bodyFraming as TikTokReferenceObservation["bodyFraming"] : "other",
      identitySignals: stringList(item.identitySignals).filter((signal): signal is TikTokReferenceObservation["identitySignals"][number] => identitySignalValues.includes(signal as never)),
      captureStyle: stringValue(item.captureStyle),
    } satisfies TikTokReferenceObservation;
  }) : [];
  if (observations.length !== assets.length || new Set(observations.map((item) => item.assetId)).size !== assets.length) {
    throw new Error("every identity image must be observed exactly once");
  }
  if (observations.some((item) => !item.captureStyle)) throw new Error("every identity image must describe its visible capture style");
  return observations;
}

export async function inspectTikTokPersonaReferences(input: { persona: TikTokAutomationPersonaContext; assets: TikTokAutomationPersonaAsset[]; onProgress?: (fraction: number, label: string) => void }) {
  const result: TikTokReferenceObservation[] = [];
  for (let offset = 0; offset < input.assets.length; offset += 8) {
    const batch = input.assets.slice(offset, offset + 8);
    const content: OpenRouterContent[] = [{
      type: "text",
      text: `Inspect these selected reference images for identity “${input.persona.name}”. Notes supplied by the user: ${input.persona.notes || "(none)"}. Record only visible, factual evidence. Explain which visible properties each view can reliably anchor for later reasoning. Classify face visibility, angle, usable detail, body framing, and supported identity signals conservatively so a later planner can assemble complementary identity evidence for a specific shot. For captureStyle, describe only the visible photographic genre and production character: camera authenticity, degree of staging or polish, lighting character, setting realism, and casual/formal register. Do not upgrade or normalize it. A distant or obscured face is not a strong facial-identity anchor. Do not rank attractiveness, invent a project goal, or infer improvement. The role Before/After is a neutral library grouping, not permission to degrade or improve anything. Preserve every assetId exactly.`,
    }];
    for (const asset of batch) {
      content.push({ type: "text", text: `ASSET ID: ${asset.id}\nLIBRARY ROLE: ${asset.role}\nFILENAME: ${asset.filename}` });
      content.push(await imageContent(asset.analysisPath || asset.path, asset.analysisMimeType || asset.mimeType));
    }
    let feedback = "";
    let completed = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const completedFraction = offset / Math.max(1, input.assets.length);
      input.onProgress?.(completedFraction, attempt ? `Checking identity evidence · retry ${attempt + 1}/3` : `Reading identity evidence · ${Math.min(offset + batch.length, input.assets.length)}/${input.assets.length}`);
      try {
        const payload = await requestOpenRouter({
          temperature: attempt === 2 ? 0 : 0.1,
          response_format: structuredResponse("tiktok_reference_observations", buildObservationSchema(batch)),
          messages: [
            { role: "system", content: "You are a visual evidence extractor. Describe what is visibly supported by each target reference. Never decide the user's creative intent and never turn library group names into quality or mood instructions." },
            { role: "user", content: feedback ? [...content, { type: "text", text: `Previous attempt failed: ${feedback}. Return all observations again.` }] : content },
          ],
        });
        const observations = parseObservations(payload, batch);
        result.push(...observations);
        input.onProgress?.((offset + batch.length) / Math.max(1, input.assets.length), `Identity evidence analyzed · ${Math.min(offset + batch.length, input.assets.length)}/${input.assets.length}`);
        completed = true;
        break;
      } catch (error) {
        feedback = error instanceof Error ? error.message : "invalid observations";
        console.warn("TikTok reference inspection attempt failed", { offset, attempt: attempt + 1, error: feedback });
        await waitForAutomationRetry(error, attempt, 3);
      }
    }
    if (!completed) throw new Error("Identity references could not be inspected");
  }
  return input.assets.map((asset) => result.find((item) => item.assetId === asset.id)!).filter(Boolean);
}

export function buildTikTokIntentContractSchema(slideIndexes: number[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["userIntentSummary", "requirements", "globalRules", "ambiguitiesResolved", "campaign", "sequence", "slides"],
    properties: {
      userIntentSummary: { type: "string" },
      requirements: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "instruction", "appliesToSlideIndexes", "priority", "sourceOfTruth", "acceptanceCriteria"],
          properties: {
            id: { type: "string" }, instruction: { type: "string" },
            appliesToSlideIndexes: { type: "array", items: { type: "integer", minimum: Math.min(...slideIndexes), maximum: Math.max(...slideIndexes) } },
            priority: { type: "string", enum: ["required", "preferred"] },
            sourceOfTruth: { type: "string", enum: ["user_brief", "target_references", "source_slides", "ui_choices"] },
            acceptanceCriteria: { type: "array", minItems: 1, items: { type: "string" } },
          },
        },
      },
      globalRules: { type: "array", minItems: 1, items: { type: "string" } },
      ambiguitiesResolved: { type: "array", items: { type: "string" } },
      campaign: {
        type: "object",
        additionalProperties: false,
        required: ["campaignName", "creativeThesis", "wardrobeDirection", "locationDirection", "visualTreatmentMode", "visualTreatment", "consistencyRules", "rewrittenHook", "commentAngle", "endingInstruction"],
        properties: {
          campaignName: { type: "string" }, creativeThesis: { type: "string" },
          wardrobeDirection: { type: "string" }, locationDirection: { type: "string" },
          visualTreatmentMode: { type: "string", enum: ["preserve_target_genre", "change_requested"] },
          visualTreatment: { type: "string" },
          consistencyRules: { type: "array", items: { type: "string" } },
          rewrittenHook: { type: "string" }, commentAngle: { type: "string" }, endingInstruction: { type: "string" },
        },
      },
      sequence: {
        type: "object",
        additionalProperties: false,
        required: ["mode", "comparisonFeature", "comparisonVisibilityRule", "sharedCameraAngle", "sharedFraming", "sharedSubjectScale", "sharedVisualConstraints", "slideDifferences"],
        properties: {
          mode: { type: "string", enum: ["independent", "progression", "comparison"] },
          comparisonFeature: { type: "string" },
          comparisonVisibilityRule: { type: "string" },
          sharedCameraAngle: { type: "string" },
          sharedFraming: { type: "string" },
          sharedSubjectScale: { type: "string" },
          sharedVisualConstraints: { type: "array", minItems: 1, items: { type: "string" } },
          slideDifferences: {
            type: "array",
            minItems: slideIndexes.length,
            maxItems: slideIndexes.length,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["index", "instruction"],
              properties: {
                index: { type: "integer", minimum: Math.min(...slideIndexes), maximum: Math.max(...slideIndexes) },
                instruction: { type: "string" },
              },
            },
          },
        },
      },
      slides: {
        type: "array",
        minItems: slideIndexes.length,
        maxItems: slideIndexes.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["index", "interpretation", "requirementIds", "directive", "sourceText", "overlayText", "textRelation", "textStyleMode", "textStyleInstruction", "expressionInstruction", "visualRequirements"],
          properties: {
            index: { type: "integer", minimum: Math.min(...slideIndexes), maximum: Math.max(...slideIndexes) }, interpretation: { type: "string" },
            requirementIds: { type: "array", items: { type: "string" } },
            directive: { type: "string" },
            sourceText: { type: "string" },
            overlayText: { type: "string" },
            textRelation: { type: "string" },
            textStyleMode: { type: "string", enum: ["preserve_source", "change_requested", "remove"] },
            textStyleInstruction: { type: "string" },
            expressionInstruction: { type: "string" },
            visualRequirements: { type: "array", minItems: 1, items: { type: "string" } },
          },
        },
      },
    },
  };
}

export function validateTikTokIntentContract(
  payload: unknown,
  slideIndexes: number[],
  textOptions?: { strategy: TikTokAutomationPreferences["textStrategy"]; sourceTextBySlide: Record<number, string> },
): TikTokAutomationIntentContract {
  const root = objectValue(payload);
  const requirements = Array.isArray(root.requirements) ? root.requirements.map((entry) => {
    const item = objectValue(entry);
    return {
      id: stringValue(item.id), instruction: stringValue(item.instruction),
      appliesToSlideIndexes: numberList(item.appliesToSlideIndexes),
      priority: item.priority === "preferred" ? "preferred" as const : "required" as const,
      sourceOfTruth: ["user_brief", "target_references", "source_slides", "ui_choices"].includes(String(item.sourceOfTruth))
        ? item.sourceOfTruth as TikTokAutomationIntentContract["requirements"][number]["sourceOfTruth"] : "user_brief" as const,
      acceptanceCriteria: stringList(item.acceptanceCriteria),
    };
  }) : [];
  if (!requirements.length || requirements.some((item) => !item.id || !item.instruction || !item.acceptanceCriteria.length)) {
    throw new Error("intent requirements are incomplete");
  }
  const requirementIds = new Set(requirements.map((item) => item.id));
  if (requirementIds.size !== requirements.length) throw new Error("intent requirement IDs must be unique");
  if (requirements.some((item) => item.appliesToSlideIndexes.some((index) => !slideIndexes.includes(index)))) {
    throw new Error("an intent requirement targets an unknown slide");
  }
  const slides = Array.isArray(root.slides) ? root.slides.map((entry) => {
    const item = objectValue(entry);
    const index = Number(item.index);
    const requirementIdsForSlide = stringList(item.requirementIds);
    if (requirementIdsForSlide.some((id) => !requirementIds.has(id))) throw new Error(`slide ${index} cites an unknown intent requirement`);
    return {
      index,
      interpretation: stringValue(item.interpretation),
      requirementIds: requirementIdsForSlide,
      directive: stringValue(item.directive),
      sourceText: stringValue(item.sourceText),
      overlayText: stringValue(item.overlayText),
      textRelation: stringValue(item.textRelation),
      textStyleMode: ["preserve_source", "change_requested", "remove"].includes(String(item.textStyleMode))
        ? item.textStyleMode as TikTokAutomationSlideIntent["textStyleMode"] : "preserve_source" as const,
      textStyleInstruction: stringValue(item.textStyleInstruction),
      expressionInstruction: stringValue(item.expressionInstruction),
      visualRequirements: stringList(item.visualRequirements),
    };
  }) : [];
  if (!sameIntegerSet(slides.map((slide) => slide.index), slideIndexes)) {
    const actual = slides.map((slide) => slide.index).join(", ") || "none";
    throw new Error(`intent contract must contain every slide exactly once; expected indexes ${slideIndexes.join(", ")}; received ${actual}`);
  }
  if (slides.some((slide) => !slide.interpretation || !slide.directive || !slide.textRelation || !slide.textStyleInstruction || !slide.expressionInstruction || !slide.visualRequirements.length)) throw new Error("slide intent directives are incomplete");
  if (textOptions) {
    for (const slide of slides) {
      const sourceText = stringValue(textOptions.sourceTextBySlide[slide.index]);
      if (slide.sourceText !== sourceText) throw new Error(`slide ${slide.index} must preserve its exact sourceText in the text contract`);
      if (textOptions.strategy === "keep" && slide.overlayText !== sourceText) throw new Error(`slide ${slide.index} must keep its exact original overlay text`);
      if (textOptions.strategy === "remove" && slide.overlayText) throw new Error(`slide ${slide.index} must remove overlay text`);
      if (textOptions.strategy === "remove" && slide.textStyleMode !== "remove") throw new Error(`slide ${slide.index} must remove its text style with its overlay text`);
      if (textOptions.strategy !== "remove" && slide.textStyleMode === "remove") throw new Error(`slide ${slide.index} cannot remove text styling while text remains`);
      if (textOptions.strategy === "rewrite") {
        if (!sourceText && slide.overlayText) throw new Error(`slide ${slide.index} has no source text and must not invent overlay text`);
        if (sourceText && !slide.overlayText) throw new Error(`slide ${slide.index} must provide its own rewritten overlay text`);
        if (sourceText && slide.overlayText === sourceText) throw new Error(`slide ${slide.index} must rewrite rather than copy its source text`);
        if (sourceText && (slide.textRelation.length < 12 || slide.textRelation.toLocaleLowerCase() === "rewrite")) {
          throw new Error(`slide ${slide.index} textRelation must explain how the rewrite preserves this source line's meaning, tone, or rhetorical role`);
        }
      }
    }
    if (textOptions.strategy === "rewrite") {
      const rewritten = slides.filter((slide) => slide.sourceText).map((slide) => slide.overlayText.toLocaleLowerCase());
      if (new Set(rewritten).size !== rewritten.length) throw new Error("rewrite mode requires distinct overlay text for each source slide that contains text");
    }
  }
  for (const requirement of requirements) {
    for (const index of requirement.appliesToSlideIndexes) {
      const slide = slides.find((item) => item.index === index);
      if (!slide?.requirementIds.includes(requirement.id)) throw new Error(`slide ${index} does not cite applicable intent requirement ${requirement.id}`);
    }
  }
  const campaignRoot = objectValue(root.campaign);
  const campaign = {
    campaignName: stringValue(campaignRoot.campaignName),
    creativeThesis: stringValue(campaignRoot.creativeThesis),
    wardrobeDirection: stringValue(campaignRoot.wardrobeDirection),
    locationDirection: stringValue(campaignRoot.locationDirection),
    visualTreatmentMode: campaignRoot.visualTreatmentMode === "change_requested" ? "change_requested" as const : "preserve_target_genre" as const,
    visualTreatment: stringValue(campaignRoot.visualTreatment),
    consistencyRules: stringList(campaignRoot.consistencyRules),
    rewrittenHook: stringValue(campaignRoot.rewrittenHook),
    commentAngle: stringValue(campaignRoot.commentAngle),
    endingInstruction: stringValue(campaignRoot.endingInstruction),
  };
  const sequenceRoot = objectValue(root.sequence);
  const mode = ["independent", "progression", "comparison"].includes(String(sequenceRoot.mode))
    ? sequenceRoot.mode as TikTokAutomationIntentContract["sequence"]["mode"] : "independent";
  const slideDifferences = Array.isArray(sequenceRoot.slideDifferences) ? sequenceRoot.slideDifferences.map((entry) => {
    const item = objectValue(entry);
    return { index: Number(item.index), instruction: stringValue(item.instruction) };
  }) : [];
  if (!sameIntegerSet(slideDifferences.map((item) => item.index), slideIndexes) || slideDifferences.some((item) => !item.instruction)) {
    throw new Error("sequence slide differences must cover every slide exactly once");
  }
  const sequence = {
    mode,
    comparisonFeature: stringValue(sequenceRoot.comparisonFeature),
    comparisonVisibilityRule: stringValue(sequenceRoot.comparisonVisibilityRule),
    sharedCameraAngle: stringValue(sequenceRoot.sharedCameraAngle),
    sharedFraming: stringValue(sequenceRoot.sharedFraming),
    sharedSubjectScale: stringValue(sequenceRoot.sharedSubjectScale),
    sharedVisualConstraints: stringList(sequenceRoot.sharedVisualConstraints),
    slideDifferences: slideDifferences.sort((a, b) => a.index - b.index),
  };
  if (!sequence.sharedVisualConstraints.length) throw new Error("sequence must declare shared visual constraints");
  if ((mode === "comparison" || mode === "progression") && (!sequence.comparisonFeature || !sequence.comparisonVisibilityRule || !sequence.sharedCameraAngle || !sequence.sharedFraming || !sequence.sharedSubjectScale)) {
    throw new Error(`${mode} sequence must declare its comparison feature and visibility rule`);
  }
  const userIntentSummary = stringValue(root.userIntentSummary);
  const globalRules = stringList(root.globalRules);
  if (!userIntentSummary || !globalRules.length || !campaign.campaignName || !campaign.creativeThesis || !campaign.visualTreatment) {
    throw new Error("intent summary, campaign, or global rules are incomplete");
  }
  return {
    userIntentSummary,
    requirements,
    globalRules,
    ambiguitiesResolved: stringList(root.ambiguitiesResolved),
    campaign,
    sequence,
    slides: slides.sort((a, b) => a.index - b.index),
  };
}

export function validateTikTokSemanticContract(
  payload: unknown,
  options: { slideIndexes: number[]; assetIds: string[]; maxPersonaReferences: number },
): TikTokAutomationSemanticContract {
  const root = objectValue(payload);
  const requirements = Array.isArray(root.requirements) ? root.requirements.map((entry) => {
    const item = objectValue(entry);
    return {
      id: stringValue(item.id), instruction: stringValue(item.instruction),
      appliesToSlideIndexes: numberList(item.appliesToSlideIndexes),
      priority: item.priority === "preferred" ? "preferred" as const : "required" as const,
      sourceOfTruth: ["user_brief", "target_references", "source_slides", "ui_choices"].includes(String(item.sourceOfTruth))
        ? item.sourceOfTruth as TikTokAutomationSemanticContract["requirements"][number]["sourceOfTruth"] : "user_brief" as const,
      acceptanceCriteria: stringList(item.acceptanceCriteria),
    };
  }) : [];
  if (!requirements.length || requirements.some((item) => !item.id || !item.instruction || !item.acceptanceCriteria.length)) throw new Error("semantic requirements are incomplete");
  const requirementIds = new Set(requirements.map((item) => item.id));
  if (requirementIds.size !== requirements.length) throw new Error("semantic requirement IDs must be unique");
  if (requirements.some((item) => item.appliesToSlideIndexes.some((index) => !options.slideIndexes.includes(index)))) throw new Error("a requirement targets an unknown slide");

  const allowedAssets = new Set(options.assetIds);
  const slides = Array.isArray(root.slides) ? root.slides.map((entry) => {
    const item = objectValue(entry);
    const index = Number(item.index);
    if (typeof item.usesPersona !== "boolean") throw new Error(`slide ${index} is missing usesPersona`);
    const usesPersona = item.usesPersona;
    const selectedPersonaAssetIds = stringList(item.selectedPersonaAssetIds);
    const requirementIdsForSlide = stringList(item.requirementIds);
    const targetReferenceResponsibilities = stringList(item.targetReferenceResponsibilities);
    const plannedFaceVisibility = plannedFaceVisibilityValues.includes(item.plannedFaceVisibility as never)
      ? item.plannedFaceVisibility as TikTokAutomationSlideContract["plannedFaceVisibility"]
      : "hidden";
    const requiredIdentityEvidence = stringList(item.requiredIdentityEvidence)
      .filter((need): need is TikTokAutomationSlideContract["requiredIdentityEvidence"][number] => identityEvidenceNeedValues.includes(need as never));
    const identityCoverage = Array.isArray(item.identityCoverage) ? item.identityCoverage.map((entry) => {
      const coverage = objectValue(entry);
      return {
        need: stringValue(coverage.need) as TikTokAutomationSlideContract["identityCoverage"][number]["need"],
        assetIds: stringList(coverage.assetIds),
      };
    }).filter((coverage) => identityEvidenceNeedValues.includes(coverage.need)) : [];
    if (usesPersona && !selectedPersonaAssetIds.length) throw new Error(`slide ${index} uses a persona but has no selected visual evidence`);
    if (!usesPersona && selectedPersonaAssetIds.length) throw new Error(`slide ${index} does not use a persona but binds identity evidence`);
    if (usesPersona && !targetReferenceResponsibilities.length) throw new Error(`slide ${index} uses a persona but does not assign target-reference responsibilities`);
    if (usesPersona && !targetReferenceResponsibilities.some((responsibility) => /identity/i.test(responsibility))) {
      throw new Error(`slide ${index} uses persona references but does not assign their mandatory identity responsibility`);
    }
    if (!usesPersona && targetReferenceResponsibilities.length) throw new Error(`slide ${index} does not use a persona but assigns target-reference responsibilities`);
    if (selectedPersonaAssetIds.length > options.maxPersonaReferences) throw new Error(`slide ${index} exceeds the model reference limit`);
    if (new Set(selectedPersonaAssetIds).size !== selectedPersonaAssetIds.length) throw new Error(`slide ${index} repeats an identity image`);
    if (selectedPersonaAssetIds.some((id) => !allowedAssets.has(id))) throw new Error(`slide ${index} selects an unknown identity image`);
    if (requirementIdsForSlide.some((id) => !requirementIds.has(id))) throw new Error(`slide ${index} cites an unknown requirement`);
    return {
      index, usesPersona, interpretation: stringValue(item.interpretation), requirementIds: requirementIdsForSlide,
      sourceResponsibilities: stringList(item.sourceResponsibilities),
      targetReferenceResponsibilities,
      plannedFaceVisibility,
      requiredIdentityEvidence,
      identityCoverage,
      sourceText: stringValue(item.sourceText),
      overlayText: stringValue(item.overlayText),
      textRelation: stringValue(item.textRelation),
      textStyleMode: ["preserve_source", "change_requested", "remove"].includes(String(item.textStyleMode))
        ? item.textStyleMode as TikTokAutomationSlideContract["textStyleMode"] : "preserve_source" as const,
      textStyleInstruction: stringValue(item.textStyleInstruction),
      expressionInstruction: stringValue(item.expressionInstruction),
      visualRequirements: stringList(item.visualRequirements),
      selectedPersonaAssetIds, directive: stringValue(item.directive),
    } satisfies TikTokAutomationSlideContract;
  }) : [];
  if (!sameIntegerSet(slides.map((slide) => slide.index), options.slideIndexes)) {
    const actual = slides.map((slide) => slide.index).join(", ") || "none";
    throw new Error(`semantic contract must contain every slide exactly once; expected indexes ${options.slideIndexes.join(", ")}; received ${actual}`);
  }
  if (slides.some((slide) => !slide.interpretation || !slide.directive || !slide.sourceResponsibilities.length)) {
    throw new Error("slide contracts are incomplete");
  }
  for (const requirement of requirements) {
    for (const index of requirement.appliesToSlideIndexes) {
      const slide = slides.find((item) => item.index === index);
      if (!slide?.requirementIds.includes(requirement.id)) {
        throw new Error(`slide ${index} does not cite applicable requirement ${requirement.id}`);
      }
    }
  }
  const userIntentSummary = stringValue(root.userIntentSummary);
  const globalRules = stringList(root.globalRules);
  if (!userIntentSummary || !globalRules.length) throw new Error("semantic contract summary or global rules are incomplete");
  const sequenceRoot = objectValue(root.sequence);
  const sequence = {
    mode: ["independent", "progression", "comparison"].includes(String(sequenceRoot.mode))
      ? sequenceRoot.mode as TikTokAutomationSemanticContract["sequence"]["mode"] : "independent" as const,
    comparisonFeature: stringValue(sequenceRoot.comparisonFeature),
    comparisonVisibilityRule: stringValue(sequenceRoot.comparisonVisibilityRule),
    sharedCameraAngle: stringValue(sequenceRoot.sharedCameraAngle),
    sharedFraming: stringValue(sequenceRoot.sharedFraming),
    sharedSubjectScale: stringValue(sequenceRoot.sharedSubjectScale),
    sharedVisualConstraints: stringList(sequenceRoot.sharedVisualConstraints),
    slideDifferences: Array.isArray(sequenceRoot.slideDifferences) ? sequenceRoot.slideDifferences.map((entry) => {
      const item = objectValue(entry);
      return { index: Number(item.index), instruction: stringValue(item.instruction) };
    }) : options.slideIndexes.map((index) => ({ index, instruction: `Slide ${index}` })),
  };
  return {
    userIntentSummary, requirements,
    globalRules, ambiguitiesResolved: stringList(root.ambiguitiesResolved),
    sequence,
    slides: slides.sort((a, b) => a.index - b.index),
  };
}

const semanticContractReviewSchema = {
  type: "object", additionalProperties: false, required: ["passed", "issues"],
  properties: { passed: { type: "boolean" }, issues: { type: "array", items: { type: "string" } } },
};

export async function interpretTikTokAutomationBrief(input: {
  analysis: TikTokAutomationAnalysis;
  slides: TikTokAutomationSourceSlide[];
  preferences: TikTokAutomationPreferences;
  persona: TikTokAutomationPersonaContext;
  assets: TikTokAutomationPersonaAsset[];
  observations: TikTokReferenceObservation[];
  maxPersonaReferences: number;
}) {
  const evidence = input.observations.map((item) => ({
    assetId: item.assetId, role: item.role, visualSummary: item.visualSummary,
    observableAttributes: item.observableAttributes, usefulFor: item.usefulFor,
    faceVisibility: item.faceVisibility, faceAngle: item.faceAngle, faceDetail: item.faceDetail,
    bodyFraming: item.bodyFraming, identitySignals: item.identitySignals, captureStyle: item.captureStyle,
  }));
  const sourceOutline = {
    format: input.analysis.format,
    slides: input.analysis.slides.map((slide) => ({
      index: slide.index,
      role: slide.role,
      visibleText: slide.visibleText,
      visibleTextStyle: slide.visibleTextStyle,
      visualBrief: slide.visualBrief,
    })),
    language: input.analysis.language,
  };
  const identityMode = input.preferences.mode === "identity";
  const modeRules = identityMode
    ? `IDENTITY MODE:
- The selected persona is the target cast. Use target references only on slides where a person from that identity is actually needed.
- Slides that are diagrams, lists, products, typography, UI, collages, or other person-free formats may set usesPersona=false later.`
    : `CONCEPT MODE:
- No identity is selected and no persona is required. Never ask for, infer, or bind a library identity.
- Recreate the transferable idea: narrative function, information architecture, text mechanic, visual grammar, pacing, composition rhythm, and recognizable content format.
- Every slide must be an original adaptation, not a near-duplicate. Replace identifiable people, products, examples, illustrations, photos, and branded elements while preserving the source slide's communicative job.
- A source slide may be a photo, infographic, list, collage, tutorial card, beauty/hair reference board, product arrangement, UI-like graphic, or a mixture. Infer the right treatment per slide from sourceOutline instead of forcing a person-centered story.
- campaign.visualTreatment must be grounded in the source slides' visualBrief and visibleTextStyle. The legacy mode name preserve_target_genre means preserve the selected project reference genre, which in concept mode is the source slideshow genre.`;
  const basePrompt = `Interpret the user's free-form direction in the context of this exact project. The user may write in any language, use pronouns, shorthand, comparisons, corrections, or refer implicitly to visible properties in their selected references. Resolve meaning from the source analysis, ${identityMode ? "every target-reference observation, persona notes," : "the source slideshow's content and visual evidence,"} and UI choices. Do not match keywords and do not apply a generic campaign template.

${modeRules}

AUTHORITY:
1. The user's creativeBrief is the highest authority for creative intent.
2. Visible evidence in the selected target references is the source of truth for what those references can provide.
3. This stage receives only source slide indexes and visible text. A later binding stage owns source mechanics and visual responsibilities.
4. UI toggles are explicit property contracts, not optional hints. In identity mode, enabled New wardrobe/New location require a visible change. Disabled New wardrobe means preserve the exact clothing, accessories, and styling from each corresponding imported TikTok source slide; target identity references control identity only and cannot supply wardrobe. Disabled New location means preserve the exact background, environment, room layout, and setting from each corresponding imported TikTok source slide; target identity references cannot supply location. Never invent an outfit or location progression when its toggle is disabled. These disabled-state preservation contracts are required ui_choices requirements on every slide even though this stage does not see the source pixels. In concept mode, New subjects means replace identifiable people, products, outfits, examples, and illustrative assets; New setting means create a different environment or graphic background when one exists, without forcing a physical location into a flat graphic. The creativeBrief may refine enabled changes but cannot silently cancel them.
5. Before/After are neutral reference groups. They select which target views may be relevant; they never mean lower/higher quality or permission to worsen anything.
6. Source mood, attractiveness, grooming, lighting, wardrobe, location, polish, and transformation rhetoric are intentionally unavailable here and must never be inferred from generic Before/After conventions.
7. sourceOfTruth must be literal and accurate. Never label a requirement as user_brief when that instruction exists only in the source caption, source visuals, or your own interpretation.
8. A requested output angle or pose constrains the generated image, not the angles of evidence images. Never forbid front-facing, profile, close-up, or full-body target references from later identity binding; complementary views can establish the same person's identity even when their camera angle differs from the output.

TEXT OWNERSHIP:
- The UI textStrategy is authoritative per slide.
- sourceText must exactly echo that slide's supplied visibleText.
- keep means overlayText exactly equals sourceText; remove means overlayText is empty.
- rewrite means each slide with non-empty sourceText gets its own distinct adaptation of that exact line. Preserve a recognizable semantic function, tone, attitude, or rhetorical role from the source wording while adapting it to the user's brief and this slide's role; do not replace it with a generic campaign caption. textRelation must explicitly explain that connection, not merely say "rewrite". Never reuse one campaign hook across multiple slides. A slide with no sourceText must stay text-free.
- textStyleMode is preserve_source for keep/rewrite unless the raw creativeBrief explicitly requests a typography or text-layout change. UI rewrite permission changes wording only, never typography.
- For preserve_source, textStyleInstruction must tell the final writer to replace only the wording while matching that exact slide's observed visibleTextStyle: typography character, weight, case, color, effects, alignment, placement, relative scale, and line treatment. For an explicit user-requested redesign use change_requested and state it exactly. For removed text use remove.

EXPRESSION OWNERSHIP:
- Author expressionInstruction separately for every slide. It is the sole expression direction used by the final writer.
- An emotional expression may come only from the raw brief or an explicit project requirement. Never infer emotion from a library role, sequence position, physical state, source-person expression, or generic storytelling convention.
- When the project does not authorize a specific emotion, expressionInstruction must keep the expression natural and unforced without adding a narrative mood.

VISUAL-TREATMENT OWNERSHIP:
- ${identityMode ? "Target-reference captureStyle evidence" : "The source slideshow visualBrief and visibleTextStyle evidence"} defines the default visual genre and production character. Synthesize it into campaign.visualTreatment.
- campaign.visualTreatmentMode must be preserve_target_genre unless the raw creativeBrief explicitly asks to change the photographic aesthetic or production style.
- Enabled ${identityMode ? "New wardrobe and New location" : "New subjects and New setting"} controls require those concrete changes on every applicable slide. They never authorize a more polished, staged, editorial, aspirational, cinematic, studio-like, or otherwise different production treatment.
- In identity mode, a disabled New wardrobe or New location control requires exact per-slide source preservation for that property. campaign.wardrobeDirection and campaign.locationDirection must say so literally instead of inventing a generic campaign outfit or setting.
- When concrete subjects or settings change, retain the evidence-supported visual register, camera or graphic authenticity, lighting character, degree of staging, and production feel unless the raw brief explicitly changes them.
- Do not beautify, professionalize, simplify, or upgrade the ${identityMode ? "target-reference" : "source-slideshow"} genre by default. Describe what the evidence supports rather than selecting a generic aesthetic.

SEQUENCE OWNERSHIP:
- Declare whether the slides are independent, a progression, or a direct comparison.
- For comparison/progression, define comparisonFeature and comparisonVisibilityRule plus explicit non-empty sharedCameraAngle, sharedFraming, and sharedSubjectScale. sharedSubjectScale must name the visible region, subject extent, or crop necessary to judge this project's comparisonFeature. Derive that requirement only from the raw brief and visible project evidence; do not use a domain example or a preset. Also define the intended difference on every slide.
- A source frame may later contribute composition only when compatible with these sequence constraints. A crop that hides the property being compared is not authoritative.

Create an explicit intent contract. Decompose the user's meaning into testable requirements and assign them to slides. Define the campaign-level decisions that all applicable slides must share. Do not select assetIds, decide reference bindings, or assign source/target image responsibilities in this stage; a later multimodal binding stage owns those decisions. If a phrase is ambiguous, resolve it conservatively from project evidence and record that interpretation in ambiguitiesResolved. Do not write an image-generation JSON yet.

INPUT:
${JSON.stringify({ sourceOutline, userInterfaceChoices: input.preferences, persona: identityMode ? input.persona : null, targetReferenceEvidence: identityMode ? evidence : [] }, null, 2)}`;
  const assetImageById = new Map<string, OpenRouterContent>();
  for (const asset of input.assets) assetImageById.set(asset.id, await imageContent(asset.path, asset.mimeType));

  // The intent writer must see the same evidence as the verifier. Supplying
  // observation text alone made short, project-specific comments brittle: the
  // model had to guess what "our poses" or "the profile" referred to and a
  // malformed structured response aborted the whole automation before repair.
  const writerEvidence: OpenRouterContent[] = [];
  for (const observation of input.observations) {
    writerEvidence.push({
      type: "text",
      text: `ACTUAL TARGET REFERENCE ${observation.assetId}\nLIBRARY ROLE: ${observation.role}\nOBSERVED: ${observation.visualSummary}\nATTRIBUTES: ${observation.observableAttributes.join("; ")}\nUSEFUL FOR: ${observation.usefulFor.join("; ")}\nCAPTURE STYLE: ${observation.captureStyle}`,
    });
    const image = assetImageById.get(observation.assetId);
    if (image) writerEvidence.push(image);
  }
  let feedback = "";
  let lastStructurallyValid: TikTokAutomationIntentContract | null = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const writerInstructions = attempt === 4
        ? "Recovery pass: return the smallest complete contract that satisfies the schema and structural checklist. Preserve the user's meaning exactly; do not omit requirements just to make the response shorter."
        : "Return one complete intent contract. Do not return prose, markdown, a patch, or a partial object.";
      const writerContent: OpenRouterContent[] = [{
        type: "text",
        text: `${basePrompt}\n\nSTRUCTURAL CHECKLIST:\n- Include at least one uniquely identified, testable requirement with acceptance criteria and applicable slide indexes.\n- Include every source slide exactly once.\n- Every slide must cite every requirement that applies to it.\n- Author sourceText, overlayText, textRelation, textStyleMode, textStyleInstruction, expressionInstruction, and visualRequirements separately for every slide.\n- Author campaign.visualTreatmentMode and visualTreatment from the raw brief and ${identityMode ? "target captureStyle evidence" : "source visualBrief and visibleTextStyle evidence"}.\n- Author a complete sequence contract and ensure every slide visualRequirements operationalize it.\n- Campaign decisions must come from the raw creativeBrief, ${identityMode ? "target evidence" : "source analysis"}, or explicit UI choices; every ${identityMode ? "wardrobe/location toggle, including disabled-state source preservation" : "enabled subjects/setting toggle"} must become a required ui_choices requirement applied to every slide.\n- Do not manufacture any state change from sequence labels or source styling.\n- Describe constraints on the generated output only; ${identityMode ? "never ban evidence images because their angle or framing differs from the requested output" : "never treat person-centric fields as a reason to add a person to a graphic or informational slide"}.\n- Keep the contract concise but complete and do not include reference bindings.\n\n${writerInstructions}${feedback ? `\n\nA previous writer or verifier reported: ${feedback}\nRepair the issue in a full replacement contract.` : ""}`,
      }, ...writerEvidence];
      const payload = await requestOpenRouter({
        temperature: attempt === 4 ? 0 : 0.15,
        response_format: structuredResponse("tiktok_intent_contract", buildTikTokIntentContractSchema(input.analysis.slides.map((slide) => slide.index))),
        messages: [
          { role: "system", content: identityMode
            ? "You are the multimodal intent-resolution stage in a multi-stage creative automation. Understand this particular user's free-form language against the actual source slides and actual selected identity references. Resolve pronouns, shorthand, project context and visual references semantically. Never use keyword rules, domain-specific examples, hardcoded visual choices, or a prewritten campaign concept."
            : "You are the concept-adaptation stage in a multi-stage creative automation. No target identity exists. Infer the transferable mechanic of each source slide—content function, information hierarchy, text logic, visual grammar, pacing and composition—and turn it into a new original series for the user's requested topic. Never force a human subject, before/after story, photographic treatment, or identity workflow onto informational, graphic, product, list, collage, beauty-board, tutorial, or mixed-format content." },
          { role: "user", content: writerContent },
        ],
      });
      const contract = validateTikTokIntentContract(payload, input.analysis.slides.map((slide) => slide.index), {
        strategy: input.preferences.textStrategy,
        sourceTextBySlide: Object.fromEntries(input.analysis.slides.map((slide) => [slide.index, slide.visibleText])),
      });
      lastStructurallyValid = contract;
      const reviewerContent: OpenRouterContent[] = [{
        type: "text",
        text: `Verify this intent contract against the user's actual free-form brief and the supplied project evidence. The raw brief is the highest authority for creative meaning, while enabled UI switches are mandatory output constraints and must be labeled ui_choices. An enabled ${identityMode ? "New wardrobe or New location" : "New subjects or New setting"} toggle must be represented as a required requirement on every applicable slide and may not be cancelled by a narrower comment. ${identityMode ? "Before/After groups are neutral." : "No identity or target-reference group exists in concept mode."} This stage must preserve all concrete intent and campaign-wide consistency decisions without selecting assetIds or inventing reference bindings. Every requirement and acceptance criterion must be assigned to every applicable slide. Verify the per-slide text contract exactly: each rewrite must preserve a recognizable meaning, tone, attitude, or rhetorical role from its own sourceText while adapting it to the brief; reject generic campaign captions and reused slogans, and require textRelation to explain the concrete connection. Empty source text stays empty. Unless the raw brief explicitly requests text redesign, require preserve_source and verify textStyleInstruction preserves the observed style of its own source slide while changing only wording. Verify expressionInstruction independently: reject emotional direction that comes only from sequence position, library role, source-person expression, physical state, or generic storytelling rather than the raw brief or an explicit project requirement. Verify campaign.visualTreatment against the ${identityMode ? "visible captureStyle of target references" : "source slideshow's visualBrief and visibleTextStyle"}. Mandatory concrete changes must not authorize a different production genre or aesthetic upgrade. Require preserve_target_genre unless the raw brief explicitly asks to change visual treatment. ${identityMode ? "Also reject any rule that confuses requested output properties with evidence-image properties; an image may remain valid identity evidence when other properties differ from the output." : "Verify every slide remains faithful to its source content function and format while replacing source-specific people, products, examples, branding, and authored assets. Reject a forced human subject, photographic scene, or before/after story on a slide whose source format does not require one."} Verify that comparison/progression sequences declare shared framing, camera, subject scale, and visibility sufficient to judge the comparison feature, plus a distinct instruction for every slide. Reject unauthorized generic visual properties and verify every sourceOfTruth label literally.

RAW USER BRIEF:
${input.preferences.creativeBrief || "(none)"}

PERSONA NOTES:
${identityMode ? input.persona.notes || "(none)" : "(concept mode — no identity)"}

UI PERMISSIONS:
${JSON.stringify(input.preferences)}

SOURCE OUTLINE — INDEXES AND TEXT ONLY:
${JSON.stringify(sourceOutline)}

TARGET EVIDENCE:
${JSON.stringify(evidence)}

CANDIDATE INTENT CONTRACT:
${JSON.stringify(contract)}`,
      }];
      for (const observation of input.observations) {
        reviewerContent.push({
          type: "text",
          text: `ACTUAL TARGET REFERENCE ${observation.assetId}\nLIBRARY ROLE: ${observation.role}\nOBSERVED: ${observation.visualSummary}`,
        });
        const targetImage = assetImageById.get(observation.assetId);
        if (targetImage) reviewerContent.push(targetImage);
      }
      const review = await requestOpenRouter({
        temperature: 0,
        response_format: structuredResponse("tiktok_intent_contract_review", semanticContractReviewSchema),
        messages: [
          {
            role: "system",
            content: "You are an independent multimodal intent verifier. Verify that the intent contract faithfully operationalizes this particular user's free-form message using the actual source and target images. Understand pronouns, shorthand, corrections and project-specific references semantically. Do not select reference assets, use keyword matching, impose a generic before/after story, or introduce your own taste. Return only actionable omissions or contradictions.",
          },
          { role: "user", content: reviewerContent },
        ],
      });
      const issues = stringList(review.issues);
      if (review.passed === true && !issues.length) return contract;
      feedback = issues.length ? issues.join("; ") : "The contract does not fully operationalize the user's meaning";
    } catch (error) {
      feedback = error instanceof Error ? error.message : "invalid semantic contract";
      console.warn("TikTok semantic interpretation attempt failed", { attempt: attempt + 1, error: feedback });
      await waitForAutomationRetry(error, attempt, 5);
    }
  }
  // A verifier disagreement is internal repair feedback, not a user-facing
  // automation failure. If Gemini produced a structurally sound contract,
  // continue with it after exhausting repair attempts.
  if (lastStructurallyValid) return lastStructurallyValid;
  throw new Error("The user intent could not be interpreted");
}

type TikTokTextSequenceSlide = {
  index: number;
  sourceText: string;
  sourceFunction: string;
  sourceMechanics: string[];
  adaptedText: string;
  adaptationLogic: string;
  sequenceRole: string;
  connectionToPrevious: string;
  connectionToNext: string;
  viralMechanic: string;
};

type TikTokSourceTextDecompositionSlide = {
  index: number;
  sourceText: string;
  sourceFunction: string;
  phraseSkeleton: string;
  voiceFeatures: string[];
  rhetoricalRegister: "neutral" | "emotional" | "playful" | "provocative" | "slang" | "profane";
  edgeMustRemain: boolean;
  nonNegotiables: string[];
  sequenceRole: string;
  connectionToNext: string;
  transferableMechanics: string[];
};

export function buildTikTokSourceTextDecompositionSchema(slideIndexes: number[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["seriesMechanic", "slides"],
    properties: {
      seriesMechanic: { type: "string" },
      slides: {
        type: "array",
        minItems: slideIndexes.length,
        maxItems: slideIndexes.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["index", "sourceText", "sourceFunction", "phraseSkeleton", "voiceFeatures", "rhetoricalRegister", "edgeMustRemain", "nonNegotiables", "sequenceRole", "connectionToNext", "transferableMechanics"],
          properties: {
            index: { type: "integer", minimum: Math.min(...slideIndexes), maximum: Math.max(...slideIndexes) },
            sourceText: { type: "string" },
            sourceFunction: { type: "string" },
            phraseSkeleton: { type: "string" },
            voiceFeatures: { type: "array", items: { type: "string" } },
            rhetoricalRegister: { type: "string", enum: ["neutral", "emotional", "playful", "provocative", "slang", "profane"] },
            edgeMustRemain: { type: "boolean" },
            nonNegotiables: { type: "array", items: { type: "string" } },
            sequenceRole: { type: "string" },
            connectionToNext: { type: "string" },
            transferableMechanics: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  };
}

export function validateTikTokSourceTextDecomposition(
  payload: unknown,
  sourceTextBySlide: Record<number, string>,
  slideIndexes: number[],
) {
  const root = objectValue(payload);
  const allowedRegisters = new Set<TikTokSourceTextDecompositionSlide["rhetoricalRegister"]>(["neutral", "emotional", "playful", "provocative", "slang", "profane"]);
  const slides = Array.isArray(root.slides) ? root.slides.map((entry) => {
    const item = objectValue(entry);
    const rhetoricalRegister = stringValue(item.rhetoricalRegister) as TikTokSourceTextDecompositionSlide["rhetoricalRegister"];
    if (!allowedRegisters.has(rhetoricalRegister)) throw new Error("source text decomposition used an invalid rhetorical register");
    return {
      index: Number(item.index),
      sourceText: stringValue(item.sourceText),
      sourceFunction: stringValue(item.sourceFunction),
      phraseSkeleton: stringValue(item.phraseSkeleton),
      voiceFeatures: stringList(item.voiceFeatures),
      rhetoricalRegister,
      edgeMustRemain: item.edgeMustRemain === true,
      nonNegotiables: stringList(item.nonNegotiables),
      sequenceRole: stringValue(item.sequenceRole),
      connectionToNext: stringValue(item.connectionToNext),
      transferableMechanics: stringList(item.transferableMechanics),
    } satisfies TikTokSourceTextDecompositionSlide;
  }) : [];
  if (!stringValue(root.seriesMechanic)) throw new Error("source text decomposition must identify the series mechanic");
  if (!sameIntegerSet(slides.map((slide) => slide.index), slideIndexes)) throw new Error("source text decomposition must contain every slide exactly once");
  for (const slide of slides) {
    const sourceText = stringValue(sourceTextBySlide[slide.index]);
    if (slide.sourceText !== sourceText) throw new Error(`source text decomposition slide ${slide.index} must echo its exact source text`);
    if (!sourceText) continue;
    if (!slide.sourceFunction || !slide.phraseSkeleton || !slide.voiceFeatures.length || !slide.nonNegotiables.length || !slide.sequenceRole || !slide.connectionToNext || !slide.transferableMechanics.length) {
      throw new Error(`source text decomposition slide ${slide.index} is incomplete`);
    }
    if ((slide.rhetoricalRegister === "slang" || slide.rhetoricalRegister === "profane") && !slide.edgeMustRemain) {
      throw new Error(`source text decomposition slide ${slide.index} must preserve its slang or profane edge`);
    }
  }
  return { seriesMechanic: stringValue(root.seriesMechanic), slides: slides.sort((a, b) => a.index - b.index) };
}

export function buildTikTokTextSequenceSchema(slideIndexes: number[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["seriesLogic", "slides"],
    properties: {
      seriesLogic: { type: "string" },
      slides: {
        type: "array",
        minItems: slideIndexes.length,
        maxItems: slideIndexes.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["index", "sourceText", "sourceFunction", "sourceMechanics", "adaptedText", "adaptationLogic", "sequenceRole", "connectionToPrevious", "connectionToNext", "viralMechanic"],
          properties: {
            index: { type: "integer", minimum: Math.min(...slideIndexes), maximum: Math.max(...slideIndexes) },
            sourceText: { type: "string" },
            sourceFunction: { type: "string" },
            sourceMechanics: { type: "array", minItems: 1, items: { type: "string" } },
            adaptedText: { type: "string" },
            adaptationLogic: { type: "string" },
            sequenceRole: { type: "string" },
            connectionToPrevious: { type: "string" },
            connectionToNext: { type: "string" },
            viralMechanic: { type: "string" },
          },
        },
      },
    },
  };
}

function buildTikTokTextSequenceReviewSchema(slideIndexes: number[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["passed", "topicClarityScore", "sequenceLogicScore", "sourceFidelityScore", "rhetoricalForceScore", "hookStrengthScore", "payoffStrengthScore", "naturalnessScore", "slides", "issues"],
    properties: {
      passed: { type: "boolean" },
      topicClarityScore: { type: "integer", minimum: 1, maximum: 10 },
      sequenceLogicScore: { type: "integer", minimum: 1, maximum: 10 },
      sourceFidelityScore: { type: "integer", minimum: 1, maximum: 10 },
      rhetoricalForceScore: { type: "integer", minimum: 1, maximum: 10 },
      hookStrengthScore: { type: "integer", minimum: 1, maximum: 10 },
      payoffStrengthScore: { type: "integer", minimum: 1, maximum: 10 },
      naturalnessScore: { type: "integer", minimum: 1, maximum: 10 },
      slides: {
        type: "array",
        minItems: slideIndexes.length,
        maxItems: slideIndexes.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["index", "functionPreserved", "toneAndEnergyPreserved", "rhetoricalRegisterPreserved", "edgePreserved", "formatPreserved", "topicAdaptationNatural", "sequenceContributionStrong", "issues"],
          properties: {
            index: { type: "integer", minimum: Math.min(...slideIndexes), maximum: Math.max(...slideIndexes) },
            functionPreserved: { type: "boolean" },
            toneAndEnergyPreserved: { type: "boolean" },
            rhetoricalRegisterPreserved: { type: "boolean" },
            edgePreserved: { type: "boolean" },
            formatPreserved: { type: "boolean" },
            topicAdaptationNatural: { type: "boolean" },
            sequenceContributionStrong: { type: "boolean" },
            issues: { type: "array", items: { type: "string" } },
          },
        },
      },
      issues: { type: "array", items: { type: "string" } },
    },
  };
}

export function validateTikTokTextSequence(
  payload: unknown,
  sourceTextBySlide: Record<number, string>,
  slideIndexes: number[],
) {
  const root = objectValue(payload);
  const slides = Array.isArray(root.slides) ? root.slides.map((entry) => {
    const item = objectValue(entry);
    return {
      index: Number(item.index),
      sourceText: stringValue(item.sourceText),
      sourceFunction: stringValue(item.sourceFunction),
      sourceMechanics: stringList(item.sourceMechanics),
      adaptedText: stringValue(item.adaptedText),
      adaptationLogic: stringValue(item.adaptationLogic),
      sequenceRole: stringValue(item.sequenceRole),
      connectionToPrevious: stringValue(item.connectionToPrevious),
      connectionToNext: stringValue(item.connectionToNext),
      viralMechanic: stringValue(item.viralMechanic),
    } satisfies TikTokTextSequenceSlide;
  }) : [];
  if (!stringValue(root.seriesLogic)) throw new Error("text sequence must explain its cross-slide logic");
  if (!sameIntegerSet(slides.map((slide) => slide.index), slideIndexes)) throw new Error("text sequence must contain every slide exactly once");
  const adaptedTexts: string[] = [];
  for (const slide of slides) {
    const sourceText = stringValue(sourceTextBySlide[slide.index]);
    if (slide.sourceText !== sourceText) throw new Error(`text slide ${slide.index} must echo its exact source text`);
    if (!slide.sourceFunction || !slide.sourceMechanics.length || !slide.adaptationLogic || !slide.sequenceRole || !slide.connectionToPrevious || !slide.connectionToNext || !slide.viralMechanic) {
      throw new Error(`text slide ${slide.index} is missing rhetorical decomposition`);
    }
    if (!sourceText) {
      if (slide.adaptedText) throw new Error(`text slide ${slide.index} has no source text and cannot invent a rewrite`);
      continue;
    }
    if (!slide.adaptedText) throw new Error(`text slide ${slide.index} must contain an adapted line`);
    if (slide.adaptedText.toLocaleLowerCase() === sourceText.toLocaleLowerCase()) throw new Error(`text slide ${slide.index} must adapt rather than copy its source line`);
    const sourceWords = sourceText.split(/\s+/).filter(Boolean).length;
    const adaptedWords = slide.adaptedText.split(/\s+/).filter(Boolean).length;
    if (adaptedWords > Math.max(3, sourceWords + 2)) throw new Error(`text slide ${slide.index} lost the source line's compactness`);
    const sourceLineCount = sourceText.split(/\n+/).length;
    const adaptedLineCount = slide.adaptedText.split(/\n+/).length;
    if (adaptedLineCount !== sourceLineCount) throw new Error(`text slide ${slide.index} must preserve the source line structure`);
    adaptedTexts.push(slide.adaptedText.toLocaleLowerCase());
  }
  if (new Set(adaptedTexts).size !== adaptedTexts.length) throw new Error("text sequence reused the same adapted line");
  return { seriesLogic: stringValue(root.seriesLogic), slides: slides.sort((a, b) => a.index - b.index) };
}

function applyTikTokTextSequence(
  intentContract: TikTokAutomationIntentContract,
  candidate: ReturnType<typeof validateTikTokTextSequence>,
): TikTokAutomationIntentContract {
  const adaptedByIndex = new Map(candidate.slides.map((slide) => [slide.index, slide]));
  return {
    ...intentContract,
    campaign: {
      ...intentContract.campaign,
      rewrittenHook: candidate.slides.find((slide) => slide.adaptedText)?.adaptedText || intentContract.campaign.rewrittenHook,
    },
    slides: intentContract.slides.map((slide) => {
      const adapted = adaptedByIndex.get(slide.index);
      if (!adapted) return slide;
      return {
        ...slide,
        overlayText: adapted.adaptedText,
        textRelation: `${adapted.adaptationLogic} Sequence role: ${adapted.sequenceRole}. Connection: ${adapted.connectionToPrevious} / ${adapted.connectionToNext}. Viral mechanic: ${adapted.viralMechanic}.`,
      };
    }),
  } satisfies TikTokAutomationIntentContract;
}

export function resolveTikTokTextSequenceFallback(
  intentContract: TikTokAutomationIntentContract,
  bestValid: ReturnType<typeof validateTikTokTextSequence> | null,
  lastValid: ReturnType<typeof validateTikTokTextSequence> | null,
) {
  const fallback = bestValid ?? lastValid;
  return fallback ? applyTikTokTextSequence(intentContract, fallback) : intentContract;
}

export async function rewriteAndReviewTikTokTextSequence(input: {
  analysis: TikTokAutomationAnalysis;
  intentContract: TikTokAutomationIntentContract;
  preferences: TikTokAutomationPreferences;
  workspaceRolePrompt?: string;
}) {
  if (input.preferences.textStrategy !== "rewrite") return input.intentContract;
  const slideIndexes = input.analysis.slides.map((slide) => slide.index);
  const sourceTextBySlide = Object.fromEntries(input.analysis.slides.map((slide) => [slide.index, slide.visibleText]));
  const textContext = input.analysis.slides.map((slide) => {
    const intentSlide = input.intentContract.slides.find((item) => item.index === slide.index);
    return {
      index: slide.index,
      sourceText: slide.visibleText,
      sourceRole: slide.role,
      sourceNarrativeFunction: slide.visualBrief,
      targetInterpretation: intentSlide?.interpretation || "",
      targetDirective: intentSlide?.directive || "",
      sequenceDifference: input.intentContract.sequence.slideDifferences.find((item) => item.index === slide.index)?.instruction || "",
    };
  });
  let sourceDecomposition: ReturnType<typeof validateTikTokSourceTextDecomposition> | null = null;
  let decompositionFeedback = "";
  for (let attempt = 0; attempt < 3 && !sourceDecomposition; attempt += 1) {
    try {
      const sourceDecompositionPayload = await requestOpenRouter({
        temperature: 0,
        response_format: structuredResponse("tiktok_source_text_decomposition", buildTikTokSourceTextDecompositionSchema(slideIndexes)),
        messages: [
          {
            role: "system",
            content: `You are a source-copy strategist. Analyze only the original slideshow wording and its cross-slide retention mechanic. Do not rewrite it and do not design images.

For each exact source line, identify its rhetorical function, recognizable phrase or cadence skeleton, voice markers, sequence role, transferable viral mechanics, and non-negotiable traits that a topic adaptation must retain. Classify its rhetorical register honestly. Slang, insults, expletives, taboo language, blunt fragments, deliberate misspellings, and confrontational address are functional voice evidence, not disposable decoration. Set edgeMustRemain=true for slang or profane source lines and whenever removing the edge would reduce the line's energy or payoff. A pun, topic keyword, or polished synonym is not equivalent to an insult, expletive, or slang punch merely because it is short. Empty source text has no rewrite obligation.`,
          },
          {
            role: "user",
            content: `Decompose the source copy as a connected sequence. Preserve sourceText exactly and return no adapted wording.

SOURCE COPY AND SLIDE ROLES:
${JSON.stringify(textContext.map((slide) => ({
  index: slide.index,
  sourceText: slide.sourceText,
  sourceRole: slide.sourceRole,
  sourceNarrativeFunction: slide.sourceNarrativeFunction,
})), null, 2)}

${decompositionFeedback ? `PREVIOUS DECOMPOSITION FAILURE:\n${decompositionFeedback}\nReturn the complete corrected decomposition.` : ""}`,
          },
        ],
      });
      sourceDecomposition = validateTikTokSourceTextDecomposition(sourceDecompositionPayload, sourceTextBySlide, slideIndexes);
    } catch (error) {
      decompositionFeedback = error instanceof Error ? error.message : "invalid source-copy decomposition";
      console.warn("TikTok source-copy decomposition attempt failed", { attempt: attempt + 1, error: decompositionFeedback });
      await waitForAutomationRetry(error, attempt, 3);
    }
  }
  if (!sourceDecomposition) throw new Error("The source slideshow copy could not be decomposed");
  let feedback = "";
  let lastValid: ReturnType<typeof validateTikTokTextSequence> | null = null;
  let bestValid: ReturnType<typeof validateTikTokTextSequence> | null = null;
  let bestReviewScore = -1;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const payload = await requestOpenRouter({
        temperature: attempt === 4 ? 0.25 : 0.65,
        response_format: structuredResponse("tiktok_text_sequence", buildTikTokTextSequenceSchema(slideIndexes)),
        messages: [
          {
            role: "system",
            content: `You are the dedicated short-form slideshow copywriter. You do not design images or reinterpret visual intent. First decompose each source line's rhetorical job and viral mechanism, then write the complete adapted text sequence as one connected unit.

HARD RULES:
- Preserve each source line's function, brevity, rhythm, energy, POV pattern, casing logic, punctuation behavior, fragment/sentence form, and visual line count unless the user's raw brief explicitly requires otherwise.
- Adapt the minimum wording needed to make every line native to the target topic and slide role. Preserve the original's attitude and punch: a blunt fragment, slang beat, provocation, confession, question, setup, or punchline must remain an equivalent rhetorical device rather than becoming polished descriptive copy.
- Obey the independent SOURCE COPY CONTRACT. When edgeMustRemain=true, retain the same rhetorical temperature in the adapted wording. A clean pun, clever spelling, neutral command, or topic label cannot replace slang, an insult, an expletive, or confrontational address. Use a natural topic-native equivalent with equal force; do not sanitize it.
- When a source uses a recognizable phrase skeleton or cadence, prefer a minimal topic-native substitution that keeps it recognizable. A very short slang or punch line may add only the minimum words needed to become a concrete payoff while retaining its original attitude.
- The whole sequence must make immediate sense in order. Preserve or strengthen the original progression: hook/setup, development or contrast, then payoff/punch/CTA as supported by the actual source. Each line must connect to its neighbors and earn the next swipe.
- Optimize for comprehension and viral potential through source-supported curiosity, contrast, relatability, specificity, pattern interruption, memorable phrasing, or payoff. Do not manufacture claims, benefits, timelines, causes, CTAs, or facts absent from the source and user brief.
- Reject vague poetic captions, abstract editorial language, generic campaign slogans, repeated paraphrases, corporate copy, and lines that mention the topic without performing their slide's rhetorical job.
- Natural language outranks literal keyword insertion, but the target topic must be unmistakable from the words across the sequence rather than relying entirely on the image. A generic command, vague self-improvement phrase, or empty teaser is not a payoff unless the source itself uses that exact mechanism and the preceding line gives it concrete meaning.
- sourceText must be echoed exactly. Empty source text stays empty.
- Return the full sequence every time. The application will use adaptedText as the exact overlay text without rewriting it.

WORKSPACE PRODUCT/AUDIENCE ROLE:
${input.workspaceRolePrompt || "Use only the raw project brief and intent contract."}`,
          },
          {
            role: "user",
            content: `RAW USER BRIEF:
${input.preferences.creativeBrief || "(none)"}

TARGET INTENT AND SEQUENCE:
${JSON.stringify({
  userIntentSummary: input.intentContract.userIntentSummary,
  requirements: input.intentContract.requirements,
  campaign: input.intentContract.campaign,
  sequence: input.intentContract.sequence,
}, null, 2)}

SOURCE-LINE DECOMPOSITION INPUT:
${JSON.stringify(textContext, null, 2)}

INDEPENDENT SOURCE COPY CONTRACT:
${JSON.stringify(sourceDecomposition, null, 2)}

${feedback ? `PREVIOUS COPY OR REVIEW FAILURE:\n${feedback}\nRegenerate the entire sequence and fix it.` : "Write one connected, high-retention adapted sequence."}`,
          },
        ],
      });
      const candidate = validateTikTokTextSequence(payload, sourceTextBySlide, slideIndexes);
      lastValid = candidate;
      const review = await requestOpenRouter({
        temperature: 0,
        response_format: structuredResponse("tiktok_text_sequence_review", buildTikTokTextSequenceReviewSchema(slideIndexes)),
        messages: [
          {
            role: "system",
            content: "You are the independent short-form copy chief. Judge both the complete sequence and every source-to-adaptation pair against the independent source-copy contract. Use a strict production bar: 8 means genuinely strong enough to publish, 7 means acceptable but must regenerate. Reject weak logic, lost source mechanics, altered tone or rhetorical register, sanitized edge, unnatural wording, generic poetry, missing hook/payoff, low-retention phrasing, or topic adaptation that destroys the original attitude. Do not propose image changes. Score honestly and return actionable copy issues.",
          },
          {
            role: "user",
            content: `Verify this adapted slideshow copy against the raw source lines, raw user brief, slide functions, and target sequence.

Acceptance standard:
- every rewrite clearly descends from its own source line's rhetorical function and recognizable mechanics;
- the lines form one logical swipe-to-swipe progression with a clear setup and satisfying payoff appropriate to the available slides;
- the copy is compact, natural, specific enough to understand, and has a credible retention or sharing mechanism;
- the target topic is unmistakable from the words across the sequence without turning it into generic descriptive captions;
- profanity, slang, fragments, punctuation, POV, and punch are preserved when they are functional parts of the source;
- every edgeMustRemain contract stays at equal rhetorical intensity. A pun, word split, topic keyword, polished synonym, or neutral label cannot stand in for source profanity, slang, insult, or confrontational address;
- no unsupported claim or invented CTA is added.

For every slide, explicitly audit whether its rhetorical function, tone and energy, rhetorical register, required edge, compact format, natural topic adaptation, and contribution to the sequence survived. For a neutral source, edgePreserved may be true when no edge obligation exists. For an edgeMustRemain source, edgePreserved can be true only when the adapted words themselves carry comparable force. Slang, profanity, bluntness, vulnerability, humor, provocation, or attitude cannot be replaced by a neutral topic label or clean wordplay merely because the word count matches.

Set passed=true only when every score is at least 8, every per-slide boolean is true, and every issues array is empty. A vague opening, empty teaser, generic command, unclear topic, merely decorative caption, neutralized slang/punch, or payoff that does not concretely answer the setup must fail.

RAW BRIEF: ${input.preferences.creativeBrief || "(none)"}
SOURCE CONTEXT: ${JSON.stringify(textContext)}
SOURCE COPY CONTRACT: ${JSON.stringify(sourceDecomposition)}
CANDIDATE: ${JSON.stringify(candidate)}`,
          },
        ],
      });
      const slideReviews = Array.isArray(review.slides) ? review.slides.map((entry) => {
        const item = objectValue(entry);
        return {
          index: Number(item.index),
          passed: item.functionPreserved === true && item.toneAndEnergyPreserved === true && item.rhetoricalRegisterPreserved === true && item.edgePreserved === true && item.formatPreserved === true && item.topicAdaptationNatural === true && item.sequenceContributionStrong === true,
          issues: stringList(item.issues),
        };
      }) : [];
      if (!sameIntegerSet(slideReviews.map((slide) => slide.index), slideIndexes)) throw new Error("text review must audit every slide exactly once");
      const issues = [
        ...stringList(review.issues),
        ...slideReviews.flatMap((slide) => slide.issues.map((issue) => `slide ${slide.index}: ${issue}`)),
      ];
      const reviewScores = ["topicClarityScore", "sequenceLogicScore", "sourceFidelityScore", "rhetoricalForceScore", "hookStrengthScore", "payoffStrengthScore", "naturalnessScore"]
        .map((key) => Number(review[key]));
      const totalReviewScore = reviewScores.every((score) => Number.isFinite(score)) ? reviewScores.reduce((sum, score) => sum + score, 0) : -1;
      if (totalReviewScore > bestReviewScore) {
        bestReviewScore = totalReviewScore;
        bestValid = candidate;
      }
      if (review.passed === true && reviewScores.every((score) => Number.isInteger(score) && score >= 8) && slideReviews.every((slide) => slide.passed && !slide.issues.length) && !issues.length) {
        return applyTikTokTextSequence(input.intentContract, candidate);
      }
      const scoreFeedback = `scores: topic clarity ${reviewScores[0]}, sequence logic ${reviewScores[1]}, source fidelity ${reviewScores[2]}, rhetorical force ${reviewScores[3]}, hook ${reviewScores[4]}, payoff ${reviewScores[5]}, naturalness ${reviewScores[6]}`;
      const failedSlides = slideReviews.filter((slide) => !slide.passed).map((slide) => `slide ${slide.index} failed its source-mechanics audit`);
      feedback = [...issues, ...failedSlides, scoreFeedback].join("; ");
    } catch (error) {
      feedback = error instanceof Error ? error.message : "invalid text sequence";
      console.warn("TikTok text sequence attempt failed", { attempt: attempt + 1, error: feedback });
      await waitForAutomationRetry(error, attempt, 5);
    }
  }
  const fallback = bestValid ?? lastValid;
  if (fallback) {
    console.warn("TikTok text sequence exhausted review retries; using the best structurally valid candidate", { bestReviewScore });
    return resolveTikTokTextSequenceFallback(input.intentContract, bestValid, lastValid);
  }
  console.warn("TikTok text sequence produced no structurally valid refinement; keeping the validated intent-stage copy");
  return resolveTikTokTextSequenceFallback(input.intentContract, bestValid, lastValid);
}

export function buildTikTokReferenceBindingSchema(slideIndexes: number[], maxPersonaReferences: number) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["slides"],
    properties: {
      slides: {
        type: "array",
        minItems: slideIndexes.length,
        maxItems: slideIndexes.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["index", "usesPersona", "sourceResponsibilities", "targetReferenceResponsibilities", "plannedFaceVisibility", "requiredIdentityEvidence", "identityCoverage", "selectedPersonaAssetIds"],
          properties: {
            index: { type: "integer", minimum: Math.min(...slideIndexes), maximum: Math.max(...slideIndexes) },
            usesPersona: { type: "boolean" },
            sourceResponsibilities: { type: "array", minItems: 1, items: { type: "string", enum: ["framing", "composition", "camera perspective", "text placement", "text styling", "storytelling position"] } },
            targetReferenceResponsibilities: { type: "array", items: { type: "string" } },
            plannedFaceVisibility: { type: "string", enum: plannedFaceVisibilityValues },
            requiredIdentityEvidence: { type: "array", items: { type: "string", enum: identityEvidenceNeedValues } },
            identityCoverage: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["need", "assetIds"],
                properties: {
                  need: { type: "string", enum: identityEvidenceNeedValues },
                  assetIds: { type: "array", minItems: 1, items: { type: "string" } },
                },
              },
            },
            selectedPersonaAssetIds: {
              type: "array",
              maxItems: maxPersonaReferences,
              items: { type: "string" },
            },
          },
        },
      },
    },
  };
}

export function validateTikTokReferenceBindingPlan(
  payload: unknown,
  options: {
    slideIndexes: number[];
    assetIds: string[];
    maxPersonaReferences: number;
    expectedUsesPersonaBySlide?: Record<number, boolean>;
    assetRolesById?: Record<string, "reference" | "before" | "after">;
    requiredAssetRolesBySlide?: Record<number, "reference" | "before" | "after" | "none">;
    observationsByAssetId?: Record<string, TikTokReferenceObservation>;
    sourceAnalysisBySlide?: Record<number, TikTokAutomationAnalysis["slides"][number]>;
  },
): TikTokAutomationReferenceBindingPlan {
  const root = objectValue(payload);
  const allowedAssets = new Set(options.assetIds);
  const slides = Array.isArray(root.slides) ? root.slides.map((entry) => {
    const item = objectValue(entry);
    const index = Number(item.index);
    if (typeof item.usesPersona !== "boolean") throw new Error(`slide ${index} is missing usesPersona`);
    // In Cast identity mode, source analysis already decides whether this
    // slide has a person slot (personaVariant !== "none"). The binding model
    // chooses evidence, but cannot contradict that upstream structural fact.
    const usesPersona = options.expectedUsesPersonaBySlide?.[index] ?? item.usesPersona;
    const sourceResponsibilities = stringList(item.sourceResponsibilities);
    const targetReferenceResponsibilities = stringList(item.targetReferenceResponsibilities);
    const plannedFaceVisibility = plannedFaceVisibilityValues.includes(item.plannedFaceVisibility as never)
      ? item.plannedFaceVisibility as TikTokAutomationReferenceBindingPlan["slides"][number]["plannedFaceVisibility"]
      : "hidden";
    const requiredIdentityEvidence = stringList(item.requiredIdentityEvidence)
      .filter((need): need is TikTokAutomationReferenceBindingPlan["slides"][number]["requiredIdentityEvidence"][number] => identityEvidenceNeedValues.includes(need as never));
    const identityCoverage = Array.isArray(item.identityCoverage) ? item.identityCoverage.map((entry) => {
      const coverage = objectValue(entry);
      const need = stringValue(coverage.need);
      if (!identityEvidenceNeedValues.includes(need as never)) throw new Error(`slide ${index} has an unknown identity evidence need`);
      const assetIds = stringList(coverage.assetIds);
      if (!assetIds.length) throw new Error(`slide ${index} has empty coverage for ${need}`);
      return { need: need as TikTokAutomationReferenceBindingPlan["slides"][number]["identityCoverage"][number]["need"], assetIds };
    }) : [];
    const selectedPersonaAssetIds = stringList(item.selectedPersonaAssetIds);
    if (!sourceResponsibilities.length) throw new Error(`slide ${index} has no source responsibilities`);
    if (!sourceResponsibilities.some((responsibility) => responsibility === "framing" || responsibility === "composition" || responsibility === "camera perspective")) {
      throw new Error(`slide ${index} must retain at least one visual responsibility from its source TikTok slide`);
    }
    if (usesPersona && !selectedPersonaAssetIds.length) throw new Error(`slide ${index} uses a persona but has no selected visual evidence`);
    if (!usesPersona && selectedPersonaAssetIds.length) throw new Error(`slide ${index} does not use a persona but binds identity evidence`);
    if (usesPersona && !targetReferenceResponsibilities.length) throw new Error(`slide ${index} uses a persona but does not assign target-reference responsibilities`);
    if (usesPersona && !targetReferenceResponsibilities.some((responsibility) => /identity/i.test(responsibility))) {
      throw new Error(`slide ${index} uses persona references but does not assign their mandatory identity responsibility`);
    }
    if (!usesPersona && targetReferenceResponsibilities.length) throw new Error(`slide ${index} does not use a persona but assigns target-reference responsibilities`);
    if (!usesPersona && (requiredIdentityEvidence.length || identityCoverage.length || plannedFaceVisibility !== "hidden")) throw new Error(`slide ${index} does not use a persona but declares identity evidence`);
    if (selectedPersonaAssetIds.length > options.maxPersonaReferences) throw new Error(`slide ${index} exceeds the model reference limit`);
    if (new Set(selectedPersonaAssetIds).size !== selectedPersonaAssetIds.length) throw new Error(`slide ${index} repeats an identity image`);
    if (selectedPersonaAssetIds.some((id) => !allowedAssets.has(id))) throw new Error(`slide ${index} selects an unknown identity image`);
    const requiredRole = options.requiredAssetRolesBySlide?.[index];
    if (usesPersona && (requiredRole === "reference" || requiredRole === "before" || requiredRole === "after")) {
      const mismatched = selectedPersonaAssetIds.filter((id) => options.assetRolesById?.[id] !== requiredRole);
      if (mismatched.length) throw new Error(`slide ${index} must select only ${requiredRole} identity assets; mismatched IDs: ${mismatched.join(", ")}`);
    }
    if (usesPersona && new Set(requiredIdentityEvidence).size !== requiredIdentityEvidence.length) throw new Error(`slide ${index} repeats an identity evidence need`);
    if (usesPersona && !requiredIdentityEvidence.length) throw new Error(`slide ${index} uses a persona but declares no identity evidence needs`);
    const sourceAnalysis = options.sourceAnalysisBySlide?.[index];
    const preservesSourceFaceComposition = sourceAnalysis?.faceVisibility === "clear"
      && (sourceAnalysis.faceDetail === "high" || sourceAnalysis.faceDetail === "medium")
      && sourceResponsibilities.some((responsibility) => responsibility === "framing" || responsibility === "composition" || responsibility === "camera perspective");
    if (usesPersona && preservesSourceFaceComposition && plannedFaceVisibility !== "prominent" && plannedFaceVisibility !== "visible") {
      throw new Error(`slide ${index} preserves a source composition with a clear face and must plan the target face as visible`);
    }
    if (usesPersona && (plannedFaceVisibility === "prominent" || plannedFaceVisibility === "visible") && !requiredIdentityEvidence.includes("face_identity")) {
      throw new Error(`slide ${index} shows the face but does not require face identity evidence`);
    }
    if (usesPersona && (plannedFaceVisibility === "prominent" || plannedFaceVisibility === "visible")) {
      const availableInRole = options.assetRolesById && (requiredRole === "reference" || requiredRole === "before" || requiredRole === "after")
        ? options.assetIds.filter((id) => options.assetRolesById?.[id] === requiredRole).length
        : options.assetIds.length;
      const minimumComplementaryReferences = Math.min(2, options.maxPersonaReferences, availableInRole);
      if (selectedPersonaAssetIds.length < minimumComplementaryReferences) {
        throw new Error(`slide ${index} shows the face and needs at least ${minimumComplementaryReferences} complementary identity references`);
      }
    }
    const coverageNeeds = identityCoverage.map((coverage) => coverage.need);
    if (usesPersona && !sameStringSet(coverageNeeds, requiredIdentityEvidence)) throw new Error(`slide ${index} identity coverage must contain every declared need exactly once`);
    for (const coverage of identityCoverage) {
      if (coverage.assetIds.some((id) => !selectedPersonaAssetIds.includes(id))) throw new Error(`slide ${index} identity coverage uses an unselected asset`);
    }
    const uncoveredSelectedAssetIds = selectedPersonaAssetIds.filter((id) => !identityCoverage.some((coverage) => coverage.assetIds.includes(id)));
    if (usesPersona && uncoveredSelectedAssetIds.length) {
      throw new Error(`slide ${index} selected assetIds must each appear in identityCoverage; missing: ${uncoveredSelectedAssetIds.join(", ")}`);
    }
    const faceCoverage = identityCoverage.find((coverage) => coverage.need === "face_identity");
    const availableRoleAssetIds = options.assetIds.filter((id) => !requiredRole || options.assetRolesById?.[id] === requiredRole);
    const clearFaceAssetIds = availableRoleAssetIds.filter((id) => {
      const observation = options.observationsByAssetId?.[id];
      return observation?.faceVisibility === "clear" && (observation.faceDetail === "high" || observation.faceDetail === "medium");
    });
    if (faceCoverage && clearFaceAssetIds.length && !faceCoverage.assetIds.some((id) => clearFaceAssetIds.includes(id))) {
      throw new Error(`slide ${index} face identity must use an available clear target face reference; eligible assetIds: ${clearFaceAssetIds.join(",")}`);
    }
    const profileCoverage = identityCoverage.find((coverage) => coverage.need === "profile_identity");
    const profileAssetIds = availableRoleAssetIds.filter((id) => {
      const observation = options.observationsByAssetId?.[id];
      return observation?.faceAngle === "profile" || observation?.faceAngle === "three_quarter";
    });
    if (profileCoverage && profileAssetIds.length && !profileCoverage.assetIds.some((id) => profileAssetIds.includes(id))) {
      throw new Error(`slide ${index} profile identity must use an available profile or three-quarter target reference; eligible assetIds: ${profileAssetIds.join(",")}`);
    }
    return { index, usesPersona, sourceResponsibilities, targetReferenceResponsibilities, plannedFaceVisibility, requiredIdentityEvidence, identityCoverage, selectedPersonaAssetIds };
  }) : [];
  if (!sameIntegerSet(slides.map((slide) => slide.index), options.slideIndexes)) {
    const actual = slides.map((slide) => slide.index).join(", ") || "none";
    throw new Error(`reference binding must contain every slide exactly once; expected indexes ${options.slideIndexes.join(", ")}; received ${actual}`);
  }
  return { slides: slides.sort((a, b) => a.index - b.index) };
}

export function buildTikTokConceptReferenceBindingPlan(
  analysis: TikTokAutomationAnalysis,
  slideIndexes: number[],
): TikTokAutomationReferenceBindingPlan {
  return validateTikTokReferenceBindingPlan({
    slides: slideIndexes.map((index) => ({
      index,
      usesPersona: false,
      sourceResponsibilities: ["composition", "framing", "visual hierarchy", "content function", "typography placement"],
      targetReferenceResponsibilities: [],
      plannedFaceVisibility: "hidden",
      requiredIdentityEvidence: [],
      identityCoverage: [],
      selectedPersonaAssetIds: [],
    })),
  }, {
    slideIndexes,
    assetIds: [],
    maxPersonaReferences: 0,
    sourceAnalysisBySlide: Object.fromEntries(analysis.slides.map((slide) => [slide.index, slide])),
  });
}

export async function bindTikTokAutomationReferences(input: {
  analysis: TikTokAutomationAnalysis;
  intentContract: TikTokAutomationIntentContract;
  slides: TikTokAutomationSourceSlide[];
  persona: TikTokAutomationPersonaContext;
  assets: TikTokAutomationPersonaAsset[];
  observations: TikTokReferenceObservation[];
  maxPersonaReferences: number;
  mode: TikTokAutomationMode;
  preferences: TikTokAutomationPreferences;
}) {
  if (input.mode === "concept") {
    return buildTikTokConceptReferenceBindingPlan(input.analysis, input.slides.map((slide) => slide.index));
  }
  const assetRolesById = Object.fromEntries(input.assets.map((asset) => [asset.id, asset.role]));
  const observationsByAssetId = Object.fromEntries(input.observations.map((observation) => [observation.assetId, observation]));
  const sourceAnalysisBySlide = Object.fromEntries(input.analysis.slides.map((slide) => [slide.index, slide]));
  const requiredAssetRolesBySlide = Object.fromEntries(input.analysis.slides.map((slide) => [slide.index, slide.personaVariant]));
  const expectedUsesPersonaBySlide = Object.fromEntries(input.analysis.slides.map((slide) => [slide.index, slide.personaVariant !== "none"]));
  const sourceImages = new Map<number, OpenRouterContent>();
  for (const slide of input.slides) sourceImages.set(slide.index, await imageContent(slide.path, slide.mimeType));
  const targetImages = new Map<string, OpenRouterContent>();
  for (const asset of input.assets) targetImages.set(asset.id, await imageContent(asset.path, asset.mimeType));
  const bindSlide = async (slide: TikTokAutomationSourceSlide) => {
    const requiredRole = requiredAssetRolesBySlide[slide.index];
    const candidateAssets = requiredRole === "none" ? [] : input.assets.filter((asset) => asset.role === requiredRole);
    const candidateAssetIds = candidateAssets.map((asset) => asset.id);
    const candidateObservations = input.observations.filter((observation) => candidateAssetIds.includes(observation.assetId));
    const slideIntent = input.intentContract.slides.find((item) => item.index === slide.index);
    const sourceAnalysis = input.analysis.slides.find((item) => item.index === slide.index);
    if (!slideIntent || !sourceAnalysis) throw new Error(`Reference binding input is missing slide ${slide.index}`);

    const writerEvidence: OpenRouterContent[] = [{
      type: "text",
      text: `Create the reference-binding plan for exactly one slide: ${slide.index}. Return one slides entry only. The intent contract is authoritative. Source analysis has already made persona usage deterministic for this slide: usesPersona must be ${requiredRole === "none" ? "false" : "true"} because the required identity group is ${requiredRole}. Do not reinterpret that decision. Assign exact source and target responsibilities, and assemble the smallest sufficient complementary set from the supplied target candidates. Every identity property, including face identity, pose, body, form, and shot-specific evidence, must come exclusively from the exact neutral library group required for this slide (${requiredRole}). References from every other library group are forbidden for this slide even when they show a clearer face. Never select or invent any other assetId.

Whenever usesPersona is true, targetReferenceResponsibilities must explicitly include identity. Before selecting assets, declare plannedFaceVisibility and requiredIdentityEvidence for the intended output shot, then map every need to selected assetIds in identityCoverage. Every selected assetId must appear in at least one identityCoverage entry. The source analysis separately records whether its composition visibly contains a clear detailed face. If you preserve source framing, composition, or camera perspective from such a slide, the target output also has a visible face unless the authoritative intent explicitly replaces that composition; therefore face_identity and a clear target facial anchor are mandatory. When the face will be prominent or clearly visible, select complementary evidence when supplied: (1) a clear medium/high-detail facial-identity anchor even if its crop or angle differs from the output and (2) whichever additional view best supports the shot-specific angle, framing, subject extent, pose, form, or other visually required property. The number and kind of references must follow the intended shot and actual evidence rather than a project-domain preset. A distant image with a small face is never enough by itself to establish facial identity. Select typically 2–4 non-redundant references.

Output constraints and evidence-image properties are different things. An image may anchor facial identity even when its angle or crop differs from the intended output; selecting it does not transfer that angle or crop into the generated scene. Each evidence image may cover only its explicitly declared need. Never exclude useful identity evidence merely because a non-identity property differs from the final shot.

The imported TikTok slide remains the visual recreation template. The creativeBrief narrows which properties target references may contribute; a request such as “preserve only the pose” means only the pose may come from target references, not that the source template is discarded. sourceResponsibilities must always retain at least one of framing, composition, or camera perspective, plus any compatible text/story responsibilities. The source image never provides replacement identity. sourceResponsibilities uses a closed vocabulary: framing, composition, camera perspective, text placement, text styling, storytelling position. Do not decorate responsibilities with angle, crop, pose, identity, wardrobe, location, or mood claims. When this slide's textStyleMode is preserve_source, sourceResponsibilities must include both text placement and text styling. Do not transfer source-only face, body identity, mood, attractiveness, grooming, polish, wardrobe, location, lighting quality, vulnerability, confidence, or glow-up styling unless the intent explicitly authorizes that exact property.

UI PROPERTY AUTHORITY:
- New wardrobe is ${input.preferences.newOutfit ? "enabled: the output wardrobe must visibly change and neither source nor target references may supply it" : "disabled: preserve the exact wardrobe, clothing, accessories, and styling from this exact source slide; target references control identity only and must not contribute wardrobe"}.
- New location is ${input.preferences.newLocation ? "enabled: the output location must visibly change and neither source nor target references may supply it" : "disabled: preserve the exact location, background, environment, room layout, and setting from this exact source slide; target references control identity only and must not contribute location"}.
- The closed sourceResponsibilities vocabulary remains unchanged; these property rules are carried by the deterministic wardrobe_plan and location_plan later. Never assign wardrobe, clothing, styling, location, environment, or background to targetReferenceResponsibilities when its toggle is disabled.

The intent sequence contract outranks source composition. For comparison or progression slides, assign source framing/camera only when it preserves the sharedVisualConstraints and keeps comparisonFeature visible according to comparisonVisibilityRule. Never preserve a source crop, angle, or subject scale that hides the compared property or makes slides visually incomparable. targetReferenceResponsibilities and this slide's visualRequirements must carry the intended pose/body evidence.

RAW INTENT CONTRACT:
${JSON.stringify(input.intentContract)}

THIS SLIDE INTENT:
${JSON.stringify(slideIntent)}

THIS SOURCE ANALYSIS:
${JSON.stringify(sourceAnalysis)}

PERSONA:
${JSON.stringify(input.persona)}

ALLOWED TARGET CANDIDATES:
${JSON.stringify(candidateObservations)}

REFERENCE LIMIT FOR THIS SLIDE: ${input.maxPersonaReferences}`,
    }, { type: "text", text: `ACTUAL SOURCE SLIDE ${slide.index}` }];
    const sourceImage = sourceImages.get(slide.index);
    if (sourceImage) writerEvidence.push(sourceImage);
    for (const observation of candidateObservations) {
      writerEvidence.push({ type: "text", text: `ALLOWED TARGET REFERENCE ${observation.assetId}\nOBSERVATION: ${JSON.stringify(observation)}` });
      const image = targetImages.get(observation.assetId);
      if (image) writerEvidence.push(image);
    }

    let feedback = "";
    let lastEvidenceValid: TikTokAutomationReferenceBindingPlan["slides"][number] | null = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const payload = await requestOpenRouter({
          temperature: attempt === 4 ? 0 : 0.1,
          response_format: structuredResponse(`tiktok_reference_binding_slide_${slide.index}`, buildTikTokReferenceBindingSchema([slide.index], input.maxPersonaReferences)),
          messages: [
            { role: "system", content: "You bind visual evidence for one slide only. Use only supplied target assetIds. Target references are the sole identity source; the imported source person's identity is forbidden." },
            { role: "user", content: feedback ? [...writerEvidence, { type: "text", text: `Previous attempt failed: ${feedback}. Return a complete corrected one-slide binding. Ensure every selected assetId appears in identityCoverage.` }] : writerEvidence },
          ],
        });
        const binding = validateTikTokReferenceBindingPlan(payload, {
          slideIndexes: [slide.index],
          assetIds: candidateAssetIds,
          maxPersonaReferences: input.maxPersonaReferences,
          expectedUsesPersonaBySlide,
          assetRolesById,
          requiredAssetRolesBySlide,
          observationsByAssetId,
          sourceAnalysisBySlide,
        });
        const slideBinding = binding.slides[0];
        if (slideIntent.textStyleMode === "preserve_source" && (!slideBinding.sourceResponsibilities.includes("text placement") || !slideBinding.sourceResponsibilities.includes("text styling"))) {
          throw new Error(`slide ${slide.index} must bind source text placement and text styling for preserve_source mode`);
        }
        lastEvidenceValid = slideBinding;
        const reviewerContent: OpenRouterContent[] = [{
          type: "text",
          text: `Verify this one-slide binding against the intent and every allowed target alternative. The imported source person is expected to differ from the target persona: never demand identity, hair, wardrobe, or appearance consistency with the source person. Each slide binds only its own declared identity group; references from every other group are forbidden even as facial-identity anchors. Never demand evidence for other slides' states inside this slide's target-reference set. If the output face is visible, require the best facial-identity anchor available inside this slide's required group plus whichever same-group complementary view best covers this shot's declared evidence needs. Output properties do not constrain evidence-image properties: a reference may establish identity even when its angle or crop differs from the intended output, and must not be rejected for that difference. For comparison/progression, reject any source responsibility that preserves a crop, angle, or subject scale incompatible with sharedCameraAngle/sharedFraming/sharedSubjectScale or that hides the comparisonFeature. Source responsibilities must use only the closed neutral vocabulary and must not claim an angle or pose the source does not visibly have. Reject a single distant or weak face view when better same-group evidence exists, redundant choices, missing identity needs, cross-group identity leakage, any identity leakage from the source person, and unauthorized source aesthetics. Name better omitted assetId(s) in actionable issues.

INTENT: ${JSON.stringify(input.intentContract)}
SOURCE ANALYSIS: ${JSON.stringify(sourceAnalysis)}
CANDIDATE BINDING: ${JSON.stringify(slideBinding)}`,
        }, { type: "text", text: `ACTUAL SOURCE SLIDE ${slide.index}\nASSIGNED: ${slideBinding.sourceResponsibilities.join("; ")}` }];
        if (sourceImage) reviewerContent.push(sourceImage);
        for (const observation of candidateObservations) {
          const selected = slideBinding.selectedPersonaAssetIds.includes(observation.assetId);
          const coverage = slideBinding.identityCoverage.filter((item) => item.assetIds.includes(observation.assetId)).map((item) => item.need);
          reviewerContent.push({ type: "text", text: `TARGET ${observation.assetId}\n${selected ? "SELECTED" : "AVAILABLE BUT NOT SELECTED"}\nCOVERS: ${coverage.join("; ") || "(none)"}\nOBSERVATION: ${JSON.stringify(observation)}` });
          const image = targetImages.get(observation.assetId);
          if (image) reviewerContent.push(image);
        }
        const review = await requestOpenRouter({
          temperature: 0,
          response_format: structuredResponse(`tiktok_reference_binding_review_slide_${slide.index}`, semanticContractReviewSchema),
          messages: [
            { role: "system", content: "You independently verify whether the selected target subset is sufficient and complementary for one intended shot. Never use the source person as identity." },
            { role: "user", content: reviewerContent },
          ],
        });
        const issues = stringList(review.issues);
        if (review.passed === true && !issues.length) return slideBinding;
        feedback = issues.length ? issues.join("; ") : "The selected identity evidence is incomplete";
        console.warn("TikTok reference binding review requested repair", { slideIndex: slide.index, attempt: attempt + 1, issues: feedback });
      } catch (error) {
        feedback = error instanceof Error ? error.message : "invalid reference binding";
        console.warn("TikTok reference binding attempt failed", { slideIndex: slide.index, attempt: attempt + 1, error: feedback });
        await waitForAutomationRetry(error, attempt, 5);
      }
    }
    // The deterministic checks above enforce strict group membership,
    // complementary count, declared coverage, and the best same-group anchors.
    // A remaining qualitative reviewer disagreement must not discard that safe
    // model-authored binding or turn it into a user-facing planning failure.
    if (lastEvidenceValid) return lastEvidenceValid;
    throw new Error(`The project references could not be bound to slide ${slide.index}`);
  };

  const results = new Array<TikTokAutomationReferenceBindingPlan["slides"][number]>(input.slides.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(2, input.slides.length) }, async () => {
    while (cursor < input.slides.length) {
      const current = cursor++;
      results[current] = await bindSlide(input.slides[current]);
    }
  });
  await Promise.all(workers);
  return { slides: results.sort((a, b) => a.index - b.index) };
}

export function assembleTikTokSemanticContract(
  intent: TikTokAutomationIntentContract,
  binding: TikTokAutomationReferenceBindingPlan,
): TikTokAutomationSemanticContract {
  return {
    userIntentSummary: intent.userIntentSummary,
    requirements: intent.requirements,
    globalRules: intent.globalRules,
    ambiguitiesResolved: intent.ambiguitiesResolved,
    sequence: intent.sequence,
    slides: intent.slides.map((slideIntent) => {
      const slideBinding = binding.slides.find((item) => item.index === slideIntent.index);
      if (!slideBinding) throw new Error(`Reference binding is missing slide ${slideIntent.index}`);
      return { ...slideIntent, ...slideBinding };
    }),
  };
}

export function directionFromTikTokIntentContract(intent: TikTokAutomationIntentContract): TikTokAutomationDirection {
  return {
    campaignName: intent.campaign.campaignName,
    creativeThesis: intent.campaign.creativeThesis,
    creativeRequirements: intent.requirements.map((requirement) => requirement.instruction),
    wardrobeDirection: intent.campaign.wardrobeDirection,
    locationDirection: intent.campaign.locationDirection,
    visualTreatmentMode: intent.campaign.visualTreatmentMode,
    visualTreatment: intent.campaign.visualTreatment,
    consistencyRules: intent.campaign.consistencyRules,
    rewrittenHook: intent.campaign.rewrittenHook,
    commentAngle: intent.campaign.commentAngle,
    endingInstruction: intent.campaign.endingInstruction,
    slideDirectives: intent.slides.map((slide) => ({ index: slide.index, directive: slide.directive })),
    sequence: intent.sequence,
  };
}

function wardrobePlanForPreferences(preferences: TikTokAutomationPreferences) {
  if (preferences.mode === "concept") {
    return preferences.newOutfit
      ? {
          mode: "change_required" as const,
          instruction: "Use original subjects and illustrative assets. Do not copy identifiable people, products, outfits, examples, or branded elements from the source; preserve only their communicative function and content role.",
        }
      : {
          mode: "follow_contract" as const,
          instruction: "Follow the slide contract for subjects and illustrative assets without inventing an identity or copying branded source elements.",
        };
  }
  return preferences.newOutfit
    ? {
        mode: "change_required" as const,
        instruction: "Use visibly different clothing from every supplied source and target reference. Target references may provide identity, pose, or form evidence, but must not provide the output wardrobe.",
      }
    : {
        mode: "follow_contract" as const,
        instruction: PRESERVE_SOURCE_WARDROBE_INSTRUCTION,
      };
}

function locationPlanForPreferences(preferences: TikTokAutomationPreferences) {
  if (preferences.mode === "concept") {
    return preferences.newLocation
      ? {
          mode: "change_required" as const,
          instruction: "Create an original setting or background appropriate to the slide format. For flat graphics, adapt the visual surface or backdrop instead of inventing a physical location.",
        }
      : {
          mode: "follow_contract" as const,
          instruction: "Follow the slide contract for environment or graphic background without forcing a physical location where none belongs.",
        };
  }
  return preferences.newLocation
    ? {
        mode: "change_required" as const,
        instruction: "Use a visibly different place from every supplied source and target reference. Target references may provide identity, pose, or form evidence, but must not provide the output location.",
      }
    : {
        mode: "follow_contract" as const,
        instruction: PRESERVE_SOURCE_LOCATION_INSTRUCTION,
      };
}

const generationSchema = {
  type: "object", additionalProperties: false,
  required: ["title", "task", "reference_plan", "text_plan", "visual_style_plan", "wardrobe_plan", "location_plan", "sequence_plan", "subject", "scene", "preserve", "change", "avoid", "output", "overlayText", "confidence"],
  properties: {
    title: { type: "string" }, task: { type: "string" },
    reference_plan: { type: "array", items: { type: "object", additionalProperties: false, required: ["token", "title", "role", "instruction"], properties: { token: { type: "string" }, title: { type: "string" }, role: { type: "string", enum: ["source composition", "identity"] }, instruction: { type: "string" } } } },
    text_plan: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "text", "source_style_reference", "style_instruction"],
      properties: {
        mode: { type: "string", enum: ["preserve_source", "change_requested", "remove"] },
        text: { type: "string" },
        source_style_reference: { type: "string" },
        style_instruction: { type: "string" },
      },
    },
    visual_style_plan: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "treatment"],
      properties: {
        mode: { type: "string", enum: ["preserve_target_genre", "change_requested"] },
        treatment: { type: "string" },
      },
    },
    wardrobe_plan: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "instruction"],
      properties: {
        mode: { type: "string", enum: ["change_required", "follow_contract"] },
        instruction: { type: "string" },
      },
    },
    location_plan: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "instruction"],
      properties: {
        mode: { type: "string", enum: ["change_required", "follow_contract"] },
        instruction: { type: "string" },
      },
    },
    sequence_plan: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "comparison_feature", "comparison_visibility_rule", "shared_camera_angle", "shared_framing", "shared_subject_scale", "shared_visual_constraints", "slide_difference", "slide_visual_requirements"],
      properties: {
        mode: { type: "string", enum: ["independent", "progression", "comparison"] },
        comparison_feature: { type: "string" },
        comparison_visibility_rule: { type: "string" },
        shared_camera_angle: { type: "string" },
        shared_framing: { type: "string" },
        shared_subject_scale: { type: "string" },
        shared_visual_constraints: { type: "array", minItems: 1, items: { type: "string" } },
        slide_difference: { type: "string" },
        slide_visual_requirements: { type: "array", minItems: 1, items: { type: "string" } },
      },
    },
    subject: { type: "object", additionalProperties: false, required: ["identity", "appearance", "pose", "expression"], properties: { identity: { type: "string" }, appearance: { type: "array", items: { type: "string" } }, pose: { type: "string" }, expression: { type: "string" } } },
    scene: { type: "object", additionalProperties: false, required: ["environment", "composition", "lighting", "camera"], properties: { environment: { type: "string" }, composition: { type: "string" }, lighting: { type: "string" }, camera: { type: "string" } } },
    preserve: { type: "array", items: { type: "string" } }, change: { type: "array", items: { type: "string" } }, avoid: { type: "array", items: { type: "string" } },
    output: { type: "object", additionalProperties: false, required: ["format", "style"], properties: { format: { type: "string" }, style: { type: "string" } } },
    overlayText: { type: "string" }, confidence: { type: "number", minimum: 0, maximum: 1 },
  },
};

export function buildTikTokGenerationSchema(referenceCount: number) {
  return {
    ...generationSchema,
    properties: {
      ...generationSchema.properties,
      reference_plan: {
        ...generationSchema.properties.reference_plan,
        minItems: referenceCount,
        maxItems: referenceCount,
      },
    },
  };
}

const reviewSchema = {
  type: "object", additionalProperties: false, required: ["passed", "issues"],
  properties: { passed: { type: "boolean" }, issues: { type: "array", items: { type: "string" } } },
};

type SlidePersonaReference = TikTokAutomationPersonaAsset & { token: string; title: string };

export const TIKTOK_AUTOMATION_PROMPT_MAX_CHARS = 20_000;

type TikTokGenerationExpectations = {
  overlayText: string;
  textStyleMode: TikTokAutomationSlideContract["textStyleMode"];
  textStyleInstruction: string;
  expressionInstruction: string;
  visualTreatmentMode: TikTokAutomationDirection["visualTreatmentMode"];
  visualTreatment: string;
  wardrobePlan?: ReturnType<typeof wardrobePlanForPreferences>;
  locationPlan?: ReturnType<typeof locationPlanForPreferences>;
  sourceResponsibilities?: string[];
  sequence: TikTokAutomationIntentContract["sequence"];
  slideDifference: string;
  visualRequirements: string[];
};

function appendContractInstruction(value: unknown, instruction: string) {
  const current = stringValue(value);
  if (!instruction || current.toLocaleLowerCase().includes(instruction.toLocaleLowerCase())) return current;
  return `${current}${current ? " " : ""}${instruction}`;
}

/**
 * Gemini authors the creative parts of a slide prompt, while UI choices and the
 * already-approved semantic contract remain application-owned. Models may
 * faithfully paraphrase those rules, so requiring them to echo long strings
 * verbatim makes a valid plan fail nondeterministically. Lock the deterministic
 * fields here, then validate the provider-ready result.
 */
export function normalizeTikTokGenerationCandidate(
  payload: unknown,
  sourceToken: string,
  expectations: TikTokGenerationExpectations,
) {
  const root = objectValue(payload);
  const referencePlan = Array.isArray(root.reference_plan)
    ? root.reference_plan.map((entry) => ({ ...objectValue(entry) }))
    : root.reference_plan;
  const sourceEntry = Array.isArray(referencePlan)
    ? referencePlan.find((entry) => stringValue(entry.token) === sourceToken)
    : undefined;

  let sourceInstruction = stringValue(sourceEntry?.instruction);
  if (expectations.textStyleMode === "preserve_source") {
    sourceInstruction = appendContractInstruction(
      sourceInstruction,
      "Apply text_plan and preserve the source slide's typography, effects, placement, scale, alignment, and line treatment while changing only wording.",
    );
  }
  if (expectations.wardrobePlan?.instruction === PRESERVE_SOURCE_WARDROBE_INSTRUCTION) {
    sourceInstruction = appendContractInstruction(sourceInstruction, PRESERVE_SOURCE_WARDROBE_INSTRUCTION);
  }
  if (expectations.locationPlan?.instruction === PRESERVE_SOURCE_LOCATION_INSTRUCTION) {
    sourceInstruction = appendContractInstruction(sourceInstruction, PRESERVE_SOURCE_LOCATION_INSTRUCTION);
  }
  if (expectations.sourceResponsibilities?.length) {
    sourceInstruction = appendContractInstruction(
      sourceInstruction,
      `Preserve the assigned source responsibilities: ${expectations.sourceResponsibilities.join(", ")}.`,
    );
  }
  if (expectations.sequence.mode !== "independent") {
    sourceInstruction = appendContractInstruction(
      sourceInstruction,
      "sequence_plan overrides incompatible source angle, crop, framing, or subject scale.",
    );
  }
  if (sourceEntry) sourceEntry.instruction = sourceInstruction;

  const subject = { ...objectValue(root.subject) };
  let appearance = stringList(subject.appearance);
  if (expectations.wardrobePlan?.instruction === PRESERVE_SOURCE_WARDROBE_INSTRUCTION) {
    appearance = appendUnique(appearance, PRESERVE_SOURCE_WARDROBE_INSTRUCTION);
  }
  subject.appearance = appearance;
  subject.expression = expectations.expressionInstruction;

  const scene = { ...objectValue(root.scene) };
  if (expectations.locationPlan?.instruction === PRESERVE_SOURCE_LOCATION_INSTRUCTION) {
    scene.environment = appendContractInstruction(scene.environment, PRESERVE_SOURCE_LOCATION_INSTRUCTION);
  }

  let task = stringValue(root.task);
  if (expectations.textStyleMode === "preserve_source" && expectations.overlayText && !task.includes(expectations.overlayText)) {
    task = appendContractInstruction(
      task,
      `Replace the visible text with ${JSON.stringify(expectations.overlayText)} while preserving its source styling from ${sourceToken}.`,
    );
  }

  return {
    ...root,
    task,
    reference_plan: referencePlan,
    overlayText: expectations.overlayText,
    text_plan: {
      mode: expectations.textStyleMode,
      text: expectations.overlayText,
      source_style_reference: sourceToken,
      style_instruction: expectations.textStyleInstruction,
    },
    visual_style_plan: {
      mode: expectations.visualTreatmentMode,
      treatment: expectations.visualTreatment,
    },
    ...(expectations.wardrobePlan ? { wardrobe_plan: expectations.wardrobePlan } : {}),
    ...(expectations.locationPlan ? { location_plan: expectations.locationPlan } : {}),
    sequence_plan: {
      ...objectValue(root.sequence_plan),
      mode: expectations.sequence.mode,
      comparison_feature: expectations.sequence.comparisonFeature,
      comparison_visibility_rule: expectations.sequence.comparisonVisibilityRule,
      shared_camera_angle: expectations.sequence.sharedCameraAngle,
      shared_framing: expectations.sequence.sharedFraming,
      shared_subject_scale: expectations.sequence.sharedSubjectScale,
      shared_visual_constraints: expectations.sequence.sharedVisualConstraints,
      slide_difference: expectations.slideDifference,
      slide_visual_requirements: expectations.visualRequirements,
    },
    subject,
    scene,
  };
}

export function validateTikTokGenerationCandidate(
  payload: unknown,
  sourceToken: string,
  references: SlidePersonaReference[],
  usesPersona: boolean,
  expectations?: TikTokGenerationExpectations,
) {
  const root = objectValue(payload);
  const serialized = JSON.stringify(root);
  const leakedAssetIds = references.map((reference) => reference.id).filter((id) => serialized.includes(id));
  if (leakedAssetIds.length) throw new Error(`generation JSON must use @tokens instead of internal asset IDs: ${leakedAssetIds.join(", ")}`);
  const plan = Array.isArray(root.reference_plan) ? root.reference_plan.map((entry) => objectValue(entry)) : [];
  const expectedTokens = [sourceToken, ...references.map((reference) => reference.token)];
  const actualTokens = plan.map((item) => stringValue(item.token));
  if (actualTokens.length !== expectedTokens.length || expectedTokens.some((token) => actualTokens.filter((item) => item === token).length !== 1)) {
    throw new Error("reference_plan must bind every supplied token exactly once");
  }
  if (actualTokens.some((token) => !expectedTokens.includes(token))) throw new Error("reference_plan contains an unknown token");
  const task = stringValue(root.task);
  const missingTaskTokens = expectedTokens.filter((token) => !task.includes(token));
  if (missingTaskTokens.length) throw new Error(`task is missing exact supplied tokens: ${missingTaskTokens.join(", ")}`);
  const subject = objectValue(root.subject);
  const identity = stringValue(subject.identity);
  const sourceEntry = plan.find((item) => item.token === sourceToken);
  const sourceRole = stringValue(sourceEntry?.role);
  if (!sourceEntry || sourceRole !== "source composition") {
    throw new Error(`the source token role must be exactly "source composition"; received "${sourceRole || "missing"}"`);
  }
  if (identity.includes(sourceToken)) throw new Error("subject.identity cannot bind the source-composition token");
  if (usesPersona) {
    if (!references.length) throw new Error("this slide requires persona references");
    if (references.some((reference) => !identity.includes(reference.token))) throw new Error("subject.identity must name every target identity token");
    if (references.some((reference) => {
      const entry = plan.find((item) => item.token === reference.token);
      const role = stringValue(entry?.role);
      return !entry || role !== "identity";
    })) throw new Error("every target reference token role must be exactly \"identity\"");
  } else if (references.length) {
    throw new Error("a person-free slide cannot bind persona references");
  }
  if (expectations) {
    const overlayText = stringValue(root.overlayText);
    if (overlayText !== expectations.overlayText) throw new Error(`overlayText must exactly match this slide's text contract: ${JSON.stringify(expectations.overlayText)}`);
    const textPlan = objectValue(root.text_plan);
    if (textPlan.mode !== expectations.textStyleMode) throw new Error("text_plan.mode must exactly match this slide's text style contract");
    if (stringValue(textPlan.text) !== expectations.overlayText) throw new Error("text_plan.text must exactly match overlayText");
    if (stringValue(textPlan.source_style_reference) !== sourceToken) throw new Error("text_plan.source_style_reference must name the exact source token");
    if (stringValue(textPlan.style_instruction) !== expectations.textStyleInstruction) throw new Error("text_plan.style_instruction must exactly match this slide's text style contract");
    if (expectations.textStyleMode === "preserve_source") {
      const sourceInstruction = stringValue(sourceEntry.instruction).toLocaleLowerCase();
      if (!sourceInstruction.includes("text_plan") || !sourceInstruction.includes("preserv")) throw new Error("source reference instruction must explicitly apply text_plan and preserve source text styling");
      if (expectations.overlayText && !task.includes(expectations.overlayText)) throw new Error("task must state the exact replacement overlay text");
    }
    const visualStylePlan = objectValue(root.visual_style_plan);
    if (visualStylePlan.mode !== expectations.visualTreatmentMode) throw new Error("visual_style_plan.mode must exactly match the campaign treatment contract");
    if (stringValue(visualStylePlan.treatment) !== expectations.visualTreatment) throw new Error("visual_style_plan.treatment must exactly match the campaign treatment contract");
    const wardrobePlan = objectValue(root.wardrobe_plan);
    if (expectations.wardrobePlan && (wardrobePlan.mode !== expectations.wardrobePlan.mode || stringValue(wardrobePlan.instruction) !== expectations.wardrobePlan.instruction)) {
      throw new Error("wardrobe_plan must exactly match the UI wardrobe contract");
    }
    const locationPlan = objectValue(root.location_plan);
    if (expectations.locationPlan && (locationPlan.mode !== expectations.locationPlan.mode || stringValue(locationPlan.instruction) !== expectations.locationPlan.instruction)) {
      throw new Error("location_plan must exactly match the UI location contract");
    }
    const sourceInstruction = stringValue(sourceEntry.instruction).toLocaleLowerCase();
    if (expectations.wardrobePlan?.instruction === PRESERVE_SOURCE_WARDROBE_INSTRUCTION) {
      if (!sourceInstruction.includes(PRESERVE_SOURCE_WARDROBE_INSTRUCTION.toLocaleLowerCase())) throw new Error("source reference instruction must explicitly preserve the exact wardrobe from this source slide");
      if (!stringList(subject.appearance).includes(PRESERVE_SOURCE_WARDROBE_INSTRUCTION)) throw new Error("subject.appearance must operationalize exact source-slide wardrobe preservation");
    }
    if (expectations.locationPlan?.instruction === PRESERVE_SOURCE_LOCATION_INSTRUCTION) {
      if (!sourceInstruction.includes(PRESERVE_SOURCE_LOCATION_INSTRUCTION.toLocaleLowerCase())) throw new Error("source reference instruction must explicitly preserve the exact location from this source slide");
      if (!stringValue(objectValue(root.scene).environment).includes(PRESERVE_SOURCE_LOCATION_INSTRUCTION)) throw new Error("scene.environment must operationalize exact source-slide location preservation");
    }
    const missingSourceResponsibilities = (expectations.sourceResponsibilities || []).filter((responsibility) => !sourceInstruction.includes(responsibility.toLocaleLowerCase()));
    if (missingSourceResponsibilities.length) throw new Error(`source reference instruction omits assigned TikTok responsibilities: ${missingSourceResponsibilities.join(", ")}`);
    if (stringValue(subject.expression) !== expectations.expressionInstruction) throw new Error("subject.expression must exactly match this slide's expressionInstruction");
    const sequencePlan = objectValue(root.sequence_plan);
    if (sequencePlan.mode !== expectations.sequence.mode) throw new Error(`sequence_plan.mode must be ${expectations.sequence.mode}`);
    if (stringValue(sequencePlan.comparison_feature) !== expectations.sequence.comparisonFeature) throw new Error("sequence_plan.comparison_feature must exactly match the sequence contract");
    if (stringValue(sequencePlan.comparison_visibility_rule) !== expectations.sequence.comparisonVisibilityRule) throw new Error("sequence_plan.comparison_visibility_rule must exactly match the sequence contract");
    if (stringValue(sequencePlan.shared_camera_angle) !== expectations.sequence.sharedCameraAngle) throw new Error("sequence_plan.shared_camera_angle must exactly match the sequence contract");
    if (stringValue(sequencePlan.shared_framing) !== expectations.sequence.sharedFraming) throw new Error("sequence_plan.shared_framing must exactly match the sequence contract");
    if (stringValue(sequencePlan.shared_subject_scale) !== expectations.sequence.sharedSubjectScale) throw new Error("sequence_plan.shared_subject_scale must exactly match the sequence contract");
    if (!sameStringSet(stringList(sequencePlan.shared_visual_constraints), expectations.sequence.sharedVisualConstraints)) throw new Error("sequence_plan.shared_visual_constraints must exactly match the sequence contract");
    if (stringValue(sequencePlan.slide_difference) !== expectations.slideDifference) throw new Error("sequence_plan.slide_difference must exactly match this slide's sequence instruction");
    if (!sameStringSet(stringList(sequencePlan.slide_visual_requirements), expectations.visualRequirements)) throw new Error("sequence_plan.slide_visual_requirements must exactly match this slide's visual requirements");
    if (expectations.sequence.mode !== "independent" && !stringValue(sourceEntry.instruction).toLocaleLowerCase().includes("sequence_plan overrides")) {
      throw new Error('comparison/progression source instruction must state that "sequence_plan overrides" incompatible source angle, crop, or scale');
    }
  }
  if (JSON.stringify(root, null, 2).length > TIKTOK_AUTOMATION_PROMPT_MAX_CHARS) {
    throw new Error(`generation JSON exceeds the ${TIKTOK_AUTOMATION_PROMPT_MAX_CHARS}-character transport limit; return a concise complete replacement`);
  }
}

export async function planAndReviewTikTokSlide(input: {
  slide: TikTokAutomationSourceSlide;
  sourceToken: string;
  analysis: TikTokAutomationAnalysis;
  semanticContract: TikTokAutomationSemanticContract;
  slideContract: TikTokAutomationSlideContract;
  direction: TikTokAutomationDirection;
  preferences: TikTokAutomationPreferences;
  persona: TikTokAutomationPersonaContext;
  personaReferences: SlidePersonaReference[];
  externalFeedback?: string[];
}) {
  const identityMode = input.preferences.mode === "identity";
  const sourceImage = await imageContent(input.slide.path, input.slide.mimeType);
  const referenceImages = await Promise.all(input.personaReferences.map((reference) => imageContent(reference.path, reference.mimeType)));
  const targetTokens = input.personaReferences.map((reference) => reference.token);
  const requiredTaskTokens = [input.sourceToken, ...targetTokens];
  const tokenByAssetId = new Map(input.personaReferences.map((reference) => [reference.id, reference.token]));
  const promptSlideContract = {
    ...input.slideContract,
    selectedPersonaAssetIds: undefined,
    identityCoverage: input.slideContract.identityCoverage.map((coverage) => ({
      need: coverage.need,
      tokens: coverage.assetIds.map((id) => tokenByAssetId.get(id)).filter(Boolean),
    })),
  };
  const promptSemanticContract = {
    ...input.semanticContract,
    slides: input.semanticContract.slides.map((slide) => ({
      ...slide,
      selectedPersonaAssetIds: undefined,
      identityCoverage: slide.index === input.slide.index
        ? promptSlideContract.identityCoverage
        : slide.identityCoverage.map((coverage) => ({ need: coverage.need, referenceCount: coverage.assetIds.length })),
    })),
  };
  const slideDifference = input.semanticContract.sequence.slideDifferences.find((item) => item.index === input.slide.index)?.instruction || "";
  const wardrobePlan = wardrobePlanForPreferences(input.preferences);
  const locationPlan = locationPlanForPreferences(input.preferences);
  const sourcePropertyContract = [
    wardrobePlan.instruction === PRESERVE_SOURCE_WARDROBE_INSTRUCTION ? PRESERVE_SOURCE_WARDROBE_INSTRUCTION : "",
    locationPlan.instruction === PRESERVE_SOURCE_LOCATION_INSTRUCTION ? PRESERVE_SOURCE_LOCATION_INSTRUCTION : "",
  ].filter(Boolean);
  const referenceBindingRules = input.slideContract.usesPersona
    ? `This slide uses the selected persona. The source image controls only these assigned neutral responsibilities: ${input.slideContract.sourceResponsibilities.join(", ")}, and only where compatible with the sequence contract. sharedCameraAngle, sharedFraming, sharedSubjectScale, comparisonVisibilityRule, and slide visual requirements override conflicting source crop or angle. The selected target images collectively control identity plus these assigned responsibilities: ${input.slideContract.targetReferenceResponsibilities.join(", ")}. Identity evidence needs are ${input.slideContract.requiredIdentityEvidence.join(", ")}; coverage is ${JSON.stringify(input.slideContract.identityCoverage)}. Use each covered target view only for its declared evidence need, combining the clearest facial-identity anchor with the complementary views needed by this exact shot. The source person's face, facial structure, skin, hair, and body identity are never identity evidence and must not be blended into the result. Every target token is a view of the same selected person and must be named literally in task and subject.identity.`
    : identityMode
      ? `This slide intentionally does not use the selected persona. Bind only the source token and follow its assigned responsibilities: ${input.slideContract.sourceResponsibilities.join(", ")}. Do not invent or bind a target identity.`
      : `This is a concept-adaptation slide with no selected identity. Bind only the source token. Preserve its transferable content function, information hierarchy, visual grammar, text mechanic, pacing, and assigned responsibilities (${input.slideContract.sourceResponsibilities.join(", ")}), while replacing its concrete people, products, examples, branded elements, and authored assets with an original adaptation. Do not force a human subject or photographic scene when the source format is graphic, informational, product-led, list-based, collage-based, tutorial-like, or mixed.`;
  const writerContent: OpenRouterContent[] = [
    { type: "text", text: `Write the final directly runnable provider JSON for slide ${input.slide.index}. You author the creative and operational scene fields; the application deterministically locks UI-controlled and approved contract fields before delivery. The semantic contract and raw user brief are authoritative. Do not apply generic campaign assumptions or domain-specific examples. Do not add any concrete visual property unless it is explicitly authorized by this slide's contract, the user's brief, or the model-authored campaign specification. Visible evidence may only operationalize responsibilities already assigned to that exact image; it cannot create a new instruction. Enabled UI toggles are mandatory output constraints. Library roles Before/After are neutral identity groupings, never quality instructions. Never transfer an unassigned source property into the output. The imported TikTok source remains the recreation template for its assigned responsibilities; a narrow comment about what to preserve from target references does not discard the source template.

${referenceBindingRules}

MANDATORY LITERAL TOKEN CONTRACT:
- task must contain every one of these exact token strings: ${requiredTaskTokens.join(", ")}.
- reference_plan must contain exactly one entry for each supplied token and no others.
- ${input.sourceToken} must use role exactly "source composition" and must never appear in subject.identity.
${targetTokens.length ? `- Every target token (${targetTokens.join(", ")}) must use role exactly "identity" and must appear literally in subject.identity.
- Treat all target tokens as complementary evidence of one identity. Explicitly prevent facial identity or facial geometry from being inherited from ${input.sourceToken}.` : "- This slide has no target identity tokens."}
- Do not replace tokens with aliases such as "the source", "the persona", or "the references" in task or subject.identity.
- Never output internal asset IDs or UUIDs. Refer to every image only by its supplied @token.
- overlayText must be exactly ${JSON.stringify(input.slideContract.overlayText)}. This text is already authored for this specific source slide; do not reuse a campaign hook or another slide's text.
- text_plan must copy mode ${JSON.stringify(input.slideContract.textStyleMode)}, text ${JSON.stringify(input.slideContract.overlayText)}, source_style_reference ${JSON.stringify(input.sourceToken)}, and style_instruction ${JSON.stringify(input.slideContract.textStyleInstruction)} exactly.
${input.slideContract.textStyleMode === "preserve_source" ? `- In task, explicitly say to replace the visible text with ${JSON.stringify(input.slideContract.overlayText)} while preserving text style from ${input.sourceToken}. The ${input.sourceToken} reference_plan instruction must explicitly say to apply text_plan and preserve the source slide's typography, effects, placement, scale, alignment, and line treatment while changing only wording.` : ""}
- visual_style_plan must copy mode ${JSON.stringify(input.direction.visualTreatmentMode)} and treatment ${JSON.stringify(input.direction.visualTreatment)} exactly. Every appearance, environment, lighting, camera, output style, preserve, change, and avoid instruction must comply with it.
- wardrobe_plan must be exactly ${JSON.stringify(wardrobePlan)}. location_plan must be exactly ${JSON.stringify(locationPlan)}. These plans outrank conflicting wardrobe/location details visible in any source or target image and must be operationalized in subject.appearance, scene.environment, preserve, change, and avoid.
- For every disabled-toggle source-preservation rule, copy the full deterministic instruction verbatim into the ${input.sourceToken} reference_plan instruction. Copy the wardrobe preservation instruction verbatim as one subject.appearance item, and copy the location preservation instruction verbatim into scene.environment. Required source property instructions: ${JSON.stringify(sourcePropertyContract)}.
- A mandatory subject/wardrobe or setting/location change changes only that element. It must not cause an aesthetic or production-level upgrade. When visual_style_plan.mode is preserve_target_genre, retain the ${identityMode ? "target references'" : "source slideshow's"} visual genre, degree of staging, lighting or graphic treatment, layout character, and casual/formal register; never substitute a generic polished treatment.
- The ${input.sourceToken} reference_plan instruction must explicitly name every assigned source responsibility: ${input.slideContract.sourceResponsibilities.join(", ")}. Target reference instructions must never claim wardrobe or location responsibility when its plan is change_required or when its disabled-toggle contract preserves that property from the source.
- subject.expression must be exactly ${JSON.stringify(input.slideContract.expressionInstruction)}. Do not infer an additional mood from the sequence role, physical state, source person, or storytelling convention.
- sequence_plan must copy the exact sequence contract, this slide's exact difference instruction, and every slide visual requirement. These constraints must be operationalized in subject.pose and scene.composition, not merely echoed.
${input.semanticContract.sequence.mode !== "independent" ? `- The ${input.sourceToken} reference_plan instruction must include the literal phrase "sequence_plan overrides" and state that incompatible source angle, crop, or subject scale must not be copied.` : ""}
- A library role or sequence label must never create a visual difference by itself. Every generated difference must be traceable to the raw brief or the explicit semantic contract.

PROJECT DATA:\n${JSON.stringify({ rawUserBrief: input.preferences.creativeBrief, preferences: input.preferences, sourceAnalysis: input.analysis.slides.find((slide) => slide.index === input.slide.index), semanticContract: promptSemanticContract, slideContract: promptSlideContract, sequenceDifference: slideDifference, direction: input.direction, persona: identityMode ? input.persona : null }, null, 2)}

SOURCE TOKEN: ${input.sourceToken}\nASSIGNED SOURCE RESPONSIBILITIES: ${input.slideContract.sourceResponsibilities.join(", ")}` },
    sourceImage,
  ];
  input.personaReferences.forEach((reference, index) => {
    writerContent.push({ type: "text", text: `TARGET IDENTITY TOKEN: ${reference.token}\nLIBRARY ROLE (DESCRIPTIVE METADATA ONLY): ${reference.role}\nTITLE: ${reference.title}\nASSIGNED TARGET RESPONSIBILITIES: ${input.slideContract.targetReferenceResponsibilities.join(", ")}` });
    writerContent.push(referenceImages[index]);
  });

  let feedback = input.externalFeedback?.filter(Boolean).join("; ") || "";
  let lastStructurallyValid: Record<string, unknown> | null = null;
  let lastAttempt = 0;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const authoredPayload = await requestOpenRouter({
        temperature: attempt === 5 ? 0 : 0.18,
        response_format: structuredResponse("tiktok_slide_generation_prompt", buildTikTokGenerationSchema(1 + input.personaReferences.length)),
        messages: [
          { role: "system", content: identityMode
            ? "You are the final provider-prompt author in a multi-stage image recreation system. Follow the supplied semantic contract and literal token contract exactly. Return only the required JSON object. Reference roles are closed vocabulary: use exactly 'source composition' for the source and exactly 'identity' for target-person references. Do not substitute generic before/after storytelling, and do not silently weaken, reinterpret, or omit the user's free-form instruction."
            : "You are the final provider-prompt author for an original concept adaptation. No identity reference exists. Use the source only for its assigned transferable mechanic and format responsibilities, then create new concrete content. Match the source format when useful—photo, infographic, list, collage, tutorial card, beauty board, product layout, UI-like graphic, or mixed slide—without forcing a person or copying branded/source-specific assets. Return only the required JSON object." },
          { role: "user", content: feedback ? [...writerContent, { type: "text", text: `The previous attempt failed or the independent reviewer found contract mismatches. Rewrite the complete JSON, preserving everything that was correct: ${feedback}` }] : writerContent },
        ],
      });
      const expectations: TikTokGenerationExpectations = {
        overlayText: input.slideContract.overlayText,
        textStyleMode: input.slideContract.textStyleMode,
        textStyleInstruction: input.slideContract.textStyleInstruction,
        expressionInstruction: input.slideContract.expressionInstruction,
        visualTreatmentMode: input.direction.visualTreatmentMode,
        visualTreatment: input.direction.visualTreatment,
        wardrobePlan,
        locationPlan,
        sourceResponsibilities: input.slideContract.sourceResponsibilities,
        sequence: input.semanticContract.sequence,
        slideDifference,
        visualRequirements: input.slideContract.visualRequirements,
      };
      const payload = normalizeTikTokGenerationCandidate(authoredPayload, input.sourceToken, expectations);
      validateTikTokGenerationCandidate(payload, input.sourceToken, input.personaReferences, input.slideContract.usesPersona, expectations);
      lastStructurallyValid = payload;
      lastAttempt = attempt;

      const reviewerContent: OpenRouterContent[] = [{
        type: "text",
        text: `Review this candidate only against the user's raw brief and the explicit semantic contract. Do not invent new creative preferences or generic campaign rules. Check whether every required meaning is operationally present, whether source responsibilities and any target-reference responsibilities are correctly bound, and whether any candidate instruction contradicts the contract. Verify overlayText, text_plan, visual_style_plan, wardrobe_plan, location_plan, and subject.expression exactly match their contracts. An enabled ${identityMode ? "New wardrobe/New location" : "New subjects/New setting"} toggle is mandatory on every applicable slide: reject copied concrete source elements even when the raw comment asks to preserve only a narrow property. Verify the source reference instruction explicitly retains every assigned source TikTok responsibility. In preserve_source text mode, require the task and source reference instruction to say that only wording changes while typography, effects, placement, scale, alignment, and line treatment come from this exact source slide. In preserve_target_genre mode, reject any aesthetic or production-level upgrade and require the output to operationalize the ${identityMode ? "target-reference capture genre" : "source slideshow's visual genre and content format"}. ${identityMode ? "When the target face is visible, verify that the candidate uses the target references collectively for facial geometry and explicitly prevents the source person's face or identity from leaking into the result." : "No target identity exists. Verify that the candidate transfers the source mechanic into original concrete content and does not force a person, photography, or before/after framing onto a graphic, informational, product-led, list, collage, tutorial, beauty-board, or mixed-format slide."} Verify sequence_plan is operationalized: for comparison/progression, subject.pose and scene.composition must keep the comparison feature visible with the same shared angle, framing, scale, and visible crop while applying this slide's intended difference. Reject source framing that hides the comparison feature. Reject internal IDs and any visual property not explicitly assigned in the slide contract. Return actionable issues; do not rewrite the JSON.

RAW USER BRIEF: ${input.preferences.creativeBrief || "(none)"}
SEMANTIC CONTRACT: ${JSON.stringify(promptSemanticContract)}
SLIDE CONTRACT: ${JSON.stringify(promptSlideContract)}
CANDIDATE: ${JSON.stringify(payload)}`,
      }, { type: "text", text: `ACTUAL SOURCE IMAGE ${input.sourceToken}. Assigned responsibilities: ${input.slideContract.sourceResponsibilities.join(", ")}` }, sourceImage];
      referenceImages.forEach((image, index) => {
        reviewerContent.push({ type: "text", text: `ACTUAL TARGET IMAGE ${input.personaReferences[index].token}. Assigned responsibilities: ${input.slideContract.targetReferenceResponsibilities.join(", ")}` });
        reviewerContent.push(image);
      });
      const review = await requestOpenRouter({
        temperature: 0,
        response_format: structuredResponse("tiktok_slide_contract_review", reviewSchema),
        messages: [
          { role: "system", content: "You are an independent semantic contract verifier. Judge only against supplied user intent, contract, and visual evidence. Never introduce generic before/after aesthetics or your own taste." },
          { role: "user", content: reviewerContent },
        ],
      });
      const issues = stringList(review.issues);
      if (review.passed === true && !issues.length) return slidePlanFromCandidate(payload, input, true, [], attempt);
      feedback = (issues.length ? issues : ["Candidate did not fully satisfy the semantic contract"]).join("; ");
    } catch (error) {
      feedback = error instanceof Error ? error.message : "slide prompt attempt failed";
      console.warn("TikTok slide prompt attempt failed", { slideIndex: input.slide.index, attempt, error: feedback });
      await waitForAutomationRetry(error, attempt - 1, 5);
    }
  }
  // Reviewer disagreements stay internal. A structurally valid Gemini-authored
  // prompt is still returned instead of exposing QA implementation details to
  // the user as a fatal automation error.
  if (lastStructurallyValid) return slidePlanFromCandidate(lastStructurallyValid, input, false, [], lastAttempt || 5);
  throw new Error("A valid slide prompt could not be produced");
}

export function buildTikTokSeriesReviewSchema(slideIndexes: number[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["passed", "slides"],
    properties: {
      passed: { type: "boolean" },
      slides: {
        type: "array",
        minItems: slideIndexes.length,
        maxItems: slideIndexes.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["index", "passed", "issues"],
          properties: {
            index: { type: "integer", minimum: Math.min(...slideIndexes), maximum: Math.max(...slideIndexes) },
            passed: { type: "boolean" },
            issues: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  };
}

export async function reviewTikTokSlideSeries(input: {
  semanticContract: TikTokAutomationSemanticContract;
  direction: TikTokAutomationDirection;
  preferences: TikTokAutomationPreferences;
  slides: Array<{
    slide: TikTokAutomationSourceSlide;
    sourceToken: string;
    personaReferences: SlidePersonaReference[];
    plan: TikTokAutomationSlidePlan;
  }>;
}) {
  const identityMode = input.preferences.mode === "identity";
  const slideIndexes = input.slides.map((item) => item.slide.index);
  const expectedWardrobePlan = wardrobePlanForPreferences(input.preferences);
  const expectedLocationPlan = locationPlanForPreferences(input.preferences);
  const hardIssues = new Map<number, string[]>();
  const parsedPrompts = input.slides.map((item) => ({ index: item.slide.index, prompt: objectValue(JSON.parse(item.plan.prompt)) }));
  for (const item of parsedPrompts) {
    const slideContract = input.semanticContract.slides.find((slide) => slide.index === item.index);
    if (!slideContract) continue;
    const issues: string[] = [];
    if (stringValue(item.prompt.overlayText) !== slideContract.overlayText) issues.push("overlayText does not match the slide-specific text contract");
    const textPlan = objectValue(item.prompt.text_plan);
    if (textPlan.mode !== slideContract.textStyleMode || stringValue(textPlan.text) !== slideContract.overlayText || stringValue(textPlan.style_instruction) !== slideContract.textStyleInstruction) issues.push("text plan does not match the slide-specific text style contract");
    const visualStylePlan = objectValue(item.prompt.visual_style_plan);
    if (visualStylePlan.mode !== input.direction.visualTreatmentMode || stringValue(visualStylePlan.treatment) !== input.direction.visualTreatment) issues.push("visual style plan does not match the campaign treatment contract");
    const wardrobePlan = objectValue(item.prompt.wardrobe_plan);
    if (wardrobePlan.mode !== expectedWardrobePlan.mode || stringValue(wardrobePlan.instruction) !== expectedWardrobePlan.instruction) issues.push("wardrobe plan does not match the UI wardrobe contract");
    const locationPlan = objectValue(item.prompt.location_plan);
    if (locationPlan.mode !== expectedLocationPlan.mode || stringValue(locationPlan.instruction) !== expectedLocationPlan.instruction) issues.push("location plan does not match the UI location contract");
    if (stringValue(objectValue(item.prompt.subject).expression) !== slideContract.expressionInstruction) issues.push("subject expression does not match the slide-specific expression contract");
    const sequencePlan = objectValue(item.prompt.sequence_plan);
    const difference = input.semanticContract.sequence.slideDifferences.find((entry) => entry.index === item.index)?.instruction || "";
    if (sequencePlan.mode !== input.semanticContract.sequence.mode) issues.push("sequence mode does not match the series contract");
    if (stringValue(sequencePlan.shared_camera_angle) !== input.semanticContract.sequence.sharedCameraAngle) issues.push("shared camera angle does not match the series contract");
    if (stringValue(sequencePlan.shared_framing) !== input.semanticContract.sequence.sharedFraming) issues.push("shared framing does not match the series contract");
    if (stringValue(sequencePlan.shared_subject_scale) !== input.semanticContract.sequence.sharedSubjectScale) issues.push("shared subject scale does not match the series contract");
    if (!sameStringSet(stringList(sequencePlan.shared_visual_constraints), input.semanticContract.sequence.sharedVisualConstraints)) issues.push("shared visual constraints do not match the series contract");
    if (stringValue(sequencePlan.slide_difference) !== difference) issues.push("slide difference does not match the series contract");
    if (!sameStringSet(stringList(sequencePlan.slide_visual_requirements), slideContract.visualRequirements)) issues.push("slide visual requirements do not match the slide contract");
    if (issues.length) hardIssues.set(item.index, issues);
  }
  if (input.preferences.textStrategy === "rewrite") {
    const withSourceText = input.semanticContract.slides.filter((slide) => slide.sourceText);
    const byText = new Map<string, number[]>();
    for (const slide of withSourceText) {
      const key = slide.overlayText.toLocaleLowerCase();
      byText.set(key, [...(byText.get(key) || []), slide.index]);
    }
    for (const indexes of byText.values()) {
      if (indexes.length > 1) for (const index of indexes) hardIssues.set(index, [...(hardIssues.get(index) || []), "rewrite mode reused another slide's overlay text"]);
    }
  }
  const reviewContract = {
    ...input.semanticContract,
    slides: input.semanticContract.slides.map((slide) => {
      const reviewSlide = input.slides.find((item) => item.slide.index === slide.index);
      const tokenByAssetId = new Map(reviewSlide?.personaReferences.map((reference) => [reference.id, reference.token]) || []);
      return {
        ...slide,
        selectedPersonaAssetIds: undefined,
        selectedPersonaTokens: reviewSlide?.personaReferences.map((reference) => reference.token) || [],
        identityCoverage: slide.identityCoverage.map((coverage) => ({
          need: coverage.need,
          tokens: coverage.assetIds.map((assetId) => tokenByAssetId.get(assetId)).filter(Boolean),
        })),
      };
    }),
  };
  const content: OpenRouterContent[] = [{
    type: "text",
    text: `Review this complete slideshow series after all per-slide prompts have been written. Judge only against the raw user brief, semantic contract, and model-authored campaign specification. Check cross-slide consistency for every property that the contract says should remain consistent, and check that each slide still fulfills its own requirements and exact reference responsibilities. Enforce each slide's own sourceText-to-overlayText and text-style contract; in rewrite mode, different source slides must not reuse one generic campaign slogan, and preserve_source must change wording without redesigning that slide's typography or placement. Enforce the campaign visual-treatment contract across appearance, environment, lighting, camera, graphic treatment, layout and output style; preserve_target_genre forbids an aesthetic or production-level upgrade even when subjects or settings change. ${identityMode ? "Identity references have already passed deterministic per-slide validation." : "This is concept mode: no identity exists. Verify that the prompts transfer the source mechanic and content function into new original concrete content without forcing a person-centered or photographic format."} Enforce the sequence contract operationally. For comparison/progression, inspect subject.pose and scene.composition across all prompts: shared angle, framing, subject scale, and visible crop must make comparisonFeature visibly comparable, and each slide must express its declared slide difference. A prompt fails if its crop hides the compared property even when sequence_plan merely repeats the correct words. The semantic contract below uses the same public @tokens as the prompts; never infer or compare internal asset IDs, and never report a token-mapping issue. Do not introduce new taste, generic before/after aesthetics, or requirements not present in the contract.

RAW USER BRIEF:
${input.preferences.creativeBrief || "(none)"}

SEMANTIC CONTRACT:
${JSON.stringify(reviewContract)}

CAMPAIGN SPECIFICATION:
${JSON.stringify(input.direction)}

CANDIDATE PROMPTS:
${JSON.stringify(parsedPrompts)}`,
  }];
  let feedback = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const payload = await requestOpenRouter({
        temperature: 0,
        response_format: structuredResponse("tiktok_series_review", buildTikTokSeriesReviewSchema(slideIndexes)),
        messages: [
          { role: "system", content: "You are the final cross-slide semantic consistency verifier. Return actionable issues keyed to exact slide indexes. Judge only against supplied intent and visual evidence; never add your own campaign preferences." },
          { role: "user", content: feedback ? [...content, { type: "text", text: `The previous review response was invalid: ${feedback}. Return a complete review entry for every slide.` }] : content },
        ],
      });
      const slides = Array.isArray(payload.slides) ? payload.slides.map((entry) => {
        const item = objectValue(entry);
        return { index: Number(item.index), passed: item.passed === true, issues: stringList(item.issues) };
      }) : [];
      if (!sameIntegerSet(slides.map((slide) => slide.index), slideIndexes)) {
        throw new Error(`series review must contain indexes ${slideIndexes.join(", ")}`);
      }
      const combined = new Map(hardIssues);
      for (const slide of slides.filter((slide) => !slide.passed || slide.issues.length)) {
        combined.set(slide.index, [
          ...(combined.get(slide.index) || []),
          ...(slide.issues.length ? slide.issues : ["The slide does not satisfy the cross-slide contract"]),
        ]);
      }
      return combined;
    } catch (error) {
      feedback = error instanceof Error ? error.message : "invalid series review";
      console.warn("TikTok series review attempt failed", { attempt: attempt + 1, error: feedback });
      await waitForAutomationRetry(error, attempt, 3);
    }
  }
  // Series review is semantic QA. Per-slide prompts have already passed hard
  // reference and transport validation, so provider review outages must not
  // strand an otherwise runnable automation.
  return hardIssues;
}

function slidePlanFromCandidate(
  payload: Record<string, unknown>,
  input: Parameters<typeof planAndReviewTikTokSlide>[0],
  reviewPassed: boolean,
  reviewIssues: string[],
  attempts: number,
): TikTokAutomationSlidePlan {
  const analysisSlide = input.analysis.slides.find((slide) => slide.index === input.slide.index);
  return {
    index: input.slide.index, sourceAssetId: input.slide.assetId,
    role: analysisSlide?.role || "other", personaVariant: input.slideContract.usesPersona ? analysisSlide?.personaVariant || "reference" : "none",
    prompt: JSON.stringify(payload, null, 2), overlayText: stringValue(payload.overlayText),
    preserve: stringList(payload.preserve), change: stringList(payload.change),
    confidence: Math.max(0, Math.min(1, Number(payload.confidence) || 0)),
    reviewPassed, reviewIssues, attempts,
    personaAssetIds: input.personaReferences.map((reference) => reference.id),
    referenceLabels: [input.sourceToken, ...input.personaReferences.map((reference) => reference.token)],
    referenceCount: 1 + input.personaReferences.length, creditCost: 0,
  };
}
