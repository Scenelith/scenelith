import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { providerCostToUsageUnits, tiktokPlanningReserveCredits } from "./automation-pricing";
import { DEFAULT_ASSISTANT_MODEL_ID, getTikTokAutomationPlanningModel } from "./assistant-models";
import { usageAuthority } from "@/modules/usage";
import { editionServer } from "@/editions/current/server";
import { db, readProjectGraphSnapshot, usageWorkspaceForUserProject, userCanAccessAsset, userCanAccessProject } from "./postgres-db";
import { generationCreditCost } from "./generation-pricing";
import { settleWithConcurrency } from "./generation-queue";
import { getKieModel } from "./kie";
import { createOpenRouterUsageTracker, summarizeOpenRouterUsage, withOpenRouterModel, withOpenRouterUsage, withOpenRouterUsageStage } from "./openrouter";
import { referenceMentionToken } from "./reference-mentions";
import { persistedProjectIdSchema } from "./project-id";
import { matchesTikTokSlideshowSource } from "./tiktok-slideshow-sources";
import type { ProjectGraph } from "./types";
import {
  analyzeTikTokSlideshow,
  assembleTikTokSemanticContract,
  bindTikTokAutomationReferences,
  directionFromTikTokIntentContract,
  enforceTikTokAutomationPreferenceContract,
  inspectTikTokPersonaReferences,
  interpretTikTokAutomationBrief,
  planAndReviewTikTokSlide,
  reviewTikTokSlideSeries,
  rewriteAndReviewTikTokTextSequence,
  TIKTOK_AUTOMATION_PIPELINE_VERSION,
  type TikTokAutomationSourceSlide,
} from "./tiktok-automation";
import type {
  TikTokAutomationAnalysis,
  TikTokAutomationIntentContract,
  TikTokAutomationPlanResponse,
  TikTokAutomationReferenceBindingPlan,
  TikTokReferenceObservation,
} from "./tiktok-automation-types";

export const tiktokAutomationPlanSchema = z.object({
  projectId: persistedProjectIdSchema,
  sourceNodeId: z.string().min(1).max(200),
  sourceAssetIds: z.array(z.string().uuid()).min(1).max(35),
  personaId: z.string().uuid().nullable().optional(),
  modelId: z.string().min(1).max(120),
  planningModelId: z.string().min(1).max(120).default(DEFAULT_ASSISTANT_MODEL_ID),
  caption: z.string().max(4000).optional().default(""),
  preferences: z.object({
    mode: z.enum(["concept", "identity"]).default("identity"),
    newOutfit: z.boolean().default(true),
    newLocation: z.boolean().default(true),
    textStrategy: z.enum(["keep", "rewrite", "remove"]).default("rewrite"),
    creativeBrief: z.string().max(4000).default(""),
  }),
});

export type TikTokAutomationPlanInput = z.infer<typeof tiktokAutomationPlanSchema>;
export type TikTokAutomationRunBody = TikTokAutomationPlanResponse & { error?: string; code?: string };
export type TikTokAutomationRunResult = { status: number; body: TikTokAutomationRunBody | Record<string, unknown> };
export type TikTokAutomationProgress = { stage: string; label: string; progress: number };

type AssetRow = { id: string; filename: string; storage_path: string; mime_type: string; thumbnail_storage_path: string | null; thumbnail_mime_type: string | null };
type PersonaAssetRow = { id: string; filename: string; role: "reference" | "before" | "after"; storage_path: string; mime_type: string; thumbnail_storage_path: string | null; thumbnail_mime_type: string | null };
type TikTokPlanningCacheRow = { analysis_json: string | null; observations_json: string | null; intent_json: string | null; binding_json: string | null };

function cachedPlanningValue<T>(value: string | null | undefined) {
  if (!value) return null;
  try { return JSON.parse(value) as T; }
  catch { return null; }
}

function failure(status: number, body: Record<string, unknown>): TikTokAutomationRunResult {
  return { status, body };
}

export async function executeTikTokAutomationPlan(options: {
  userId: string;
  input: TikTokAutomationPlanInput;
  reservationId: string;
  reportProgress?: (progress: TikTokAutomationProgress) => void;
}): Promise<TikTokAutomationRunResult> {
  const { userId, input, reservationId: planningReservationId } = options;
  const report = (stage: string, label: string, progress: number) => options.reportProgress?.({ stage, label, progress });
  report("preflight", "Checking canvas access and source slides", 3);

  if (!await userCanAccessProject(userId, input.projectId)) return failure(404, { error: "Canvas not found" });
  const projectWorkspaceId = (await db.prepare("SELECT workspace_id FROM projects WHERE id = ?").get(input.projectId) as { workspace_id: string } | undefined)?.workspace_id || null;
  const usageWorkspaceId = await usageWorkspaceForUserProject(userId, input.projectId);
  const authority = await usageAuthority();
  const usage = usageWorkspaceId ? await authority.summary(usageWorkspaceId) : null;
  if (!projectWorkspaceId || !usageWorkspaceId || !usage?.assistantEnabled) {
    const denial = editionServer.featureAccessDenial("automation");
    return failure(denial.status, denial.body);
  }
  const projectGraph = (await readProjectGraphSnapshot(input.projectId)).graph as ProjectGraph;
  if (!matchesTikTokSlideshowSource(projectGraph.nodes || [], projectGraph.edges || [], input.sourceNodeId, input.sourceAssetIds)) {
    return failure(400, { error: "Choose an imported TikTok slideshow from this canvas" });
  }
  const workspaceRolePrompt = (await db.prepare("SELECT role_prompt FROM workspaces WHERE id = ?").get(projectWorkspaceId) as { role_prompt: string } | undefined)?.role_prompt || "";

  let planningModel;
  try { planningModel = getTikTokAutomationPlanningModel(input.planningModelId); }
  catch (error) { return failure(400, { error: error instanceof Error ? error.message : "Planning model not found" }); }
  if (!planningModel.supportsVision) return failure(400, { error: `${planningModel.label} is text-only and cannot inspect slideshow frames` });

  let model;
  let planningStage = "source_analysis";
  try { model = getKieModel(input.modelId); }
  catch (error) { return failure(400, { error: error instanceof Error ? error.message : "Image model not found" }); }
  const identityMode = input.preferences.mode === "identity";
  if (model.mediaType !== "image" || model.maxReferences < (identityMode ? 2 : 1)) {
    return failure(400, { error: identityMode ? "Choose an image model that supports both source and identity references" : "Choose an image model that supports a source reference" });
  }

  const persona = identityMode && input.personaId
    ? await db.prepare("SELECT id, name, notes FROM personas WHERE id = ? AND workspace_id = ?").get(input.personaId, projectWorkspaceId) as { id: string; name: string; notes: string } | undefined
    : null;
  if (identityMode && !persona) return failure(400, { error: "Choose an identity for Cast identity mode" });
  const personaAssets = persona ? await db.prepare(
    "SELECT id, filename, role, storage_path, mime_type, thumbnail_storage_path, thumbnail_mime_type FROM assets WHERE persona_id = ? AND role IN ('reference', 'before', 'after') ORDER BY CASE role WHEN 'reference' THEN 0 WHEN 'before' THEN 1 ELSE 2 END, sort_order, created_at, id",
  ).all(persona.id) as PersonaAssetRow[] : [];
  if (identityMode && !personaAssets.length) return failure(400, { error: "This identity has no usable references" });

  const slides: TikTokAutomationSourceSlide[] = [];
  for (const [index, assetId] of input.sourceAssetIds.entries()) {
    if (!await userCanAccessAsset(userId, assetId)) return failure(404, { error: `Source slide ${index + 1} is no longer available` });
    const asset = await db.prepare("SELECT id, filename, storage_path, mime_type, thumbnail_storage_path, thumbnail_mime_type FROM assets WHERE id = ?").get(assetId) as AssetRow | undefined;
    if (!asset || !asset.mime_type.startsWith("image/")) {
      return failure(400, { error: `Source slide ${index + 1} is not an image` });
    }
    slides.push({
      index: index + 1,
      assetId: asset.id,
      path: asset.storage_path,
      mimeType: asset.mime_type,
      analysisPath: asset.thumbnail_storage_path || undefined,
      analysisMimeType: asset.thumbnail_mime_type || undefined,
      title: `Screen ${String(index + 1).padStart(2, "0")}`,
    });
  }

  const personaContext = {
    name: persona?.name || "No fixed identity",
    notes: persona?.notes || "Concept adaptation without a selected persona",
    hasReference: personaAssets.some((asset) => asset.role === "reference"),
    hasBefore: personaAssets.some((asset) => asset.role === "before"),
    hasAfter: personaAssets.some((asset) => asset.role === "after"),
  };
  const personaInputAssets = personaAssets.map((asset) => ({
    id: asset.id,
    filename: asset.filename,
    role: asset.role,
    path: asset.storage_path,
    mimeType: asset.mime_type,
    analysisPath: asset.thumbnail_storage_path || undefined,
    analysisMimeType: asset.thumbnail_mime_type || undefined,
  }));
  const planningReserveCredits = tiktokPlanningReserveCredits(input.sourceAssetIds.length, planningModel.id);
  const largestIdentityStage = Math.max(
    personaAssets.filter((asset) => asset.role === "reference").length,
    personaAssets.filter((asset) => asset.role === "before").length,
    personaAssets.filter((asset) => asset.role === "after").length,
  );
  const estimatedPersonaReferences = identityMode ? Math.min(4, Math.max(0, model.maxReferences - 1), largestIdentityStage) : 0;
  const estimatedGenerationCredits = input.sourceAssetIds.length * generationCreditCost(
    model.id, model.defaultResolution || model.resolutions[0], "5", 1 + estimatedPersonaReferences,
  );
  const estimatedTotalCredits = planningReserveCredits + estimatedGenerationCredits;
  if (usage.usageMode === "metered" && estimatedTotalCredits > usage.remaining) {
    return failure(402, {
      error: `This automation needs about ${estimatedTotalCredits} credits. You have ${usage.remaining}.`,
      code: "INSUFFICIENT_CREDITS", estimatedCredits: estimatedTotalCredits, planningCredits: planningReserveCredits,
      generationCredits: estimatedGenerationCredits, availableCredits: usage.remaining,
    });
  }
  const reserved = planningReserveCredits === 0 || await authority.reserveAutomation({
    reservationId: planningReservationId,
    workspaceId: usageWorkspaceId,
    userId,
    kind: "tiktok_planning",
    credits: planningReserveCredits,
    metadata: {
      projectId: input.projectId, sourceNodeId: input.sourceNodeId, personaId: persona?.id || null,
      mode: input.preferences.mode, modelId: model.id, planningModelId: planningModel.id,
      slideCount: input.sourceAssetIds.length, estimatedGenerationCredits,
    },
  });
  if (!reserved) {
    const currentUsage = await authority.summary(usageWorkspaceId);
    return failure(402, {
      error: `This automation needs about ${estimatedTotalCredits} credits. You have ${currentUsage.remaining}.`,
      code: "INSUFFICIENT_CREDITS", estimatedCredits: estimatedTotalCredits, availableCredits: currentUsage.remaining,
    });
  }

  const usageTracker = createOpenRouterUsageTracker();
  try {
    return await withOpenRouterUsage(usageTracker, () => withOpenRouterModel(planningModel.id, async () => {
      const planningInputHash = createHash("sha256").update(JSON.stringify({
        pipelineVersion: TIKTOK_AUTOMATION_PIPELINE_VERSION,
        projectId: input.projectId,
        sourceNodeId: input.sourceNodeId,
        sourceAssetIds: input.sourceAssetIds,
        personaId: persona?.id || null,
        personaAssets: personaAssets.map((asset) => ({ id: asset.id, role: asset.role })),
        modelId: model.id,
        planningModelId: planningModel.id,
        maxReferences: model.maxReferences,
        caption: input.caption,
        preferences: input.preferences,
        workspaceRolePrompt,
      })).digest("hex");
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
      await db.prepare("DELETE FROM tiktok_planning_runs WHERE expires_at <= ?").run(now.toISOString());
      const cachedRun = await db.prepare(
        "SELECT analysis_json, observations_json, intent_json, binding_json FROM tiktok_planning_runs WHERE workspace_id = ? AND input_hash = ? AND expires_at > ?",
      ).get(projectWorkspaceId, planningInputHash, now.toISOString()) as TikTokPlanningCacheRow | undefined;
      const savePlanningArtifacts = async (artifacts: Partial<TikTokPlanningCacheRow>) => {
        const timestamp = new Date().toISOString();
        await db.prepare(`INSERT INTO tiktok_planning_runs (
          id, workspace_id, project_id, source_node_id, input_hash,
          analysis_json, observations_json, intent_json, binding_json,
          created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, input_hash) DO UPDATE SET
          analysis_json = COALESCE(excluded.analysis_json, tiktok_planning_runs.analysis_json),
          observations_json = COALESCE(excluded.observations_json, tiktok_planning_runs.observations_json),
          intent_json = COALESCE(excluded.intent_json, tiktok_planning_runs.intent_json),
          binding_json = COALESCE(excluded.binding_json, tiktok_planning_runs.binding_json),
          updated_at = excluded.updated_at,
          expires_at = excluded.expires_at`).run(
          randomUUID(), projectWorkspaceId, input.projectId, input.sourceNodeId, planningInputHash,
          artifacts.analysis_json ?? null, artifacts.observations_json ?? null,
          artifacts.intent_json ?? null, artifacts.binding_json ?? null,
          timestamp, timestamp, expiresAt,
        );
      };

      planningStage = identityMode ? "source_and_persona_analysis" : "source_analysis";
      report(planningStage, identityMode ? "Reading source slides and identity evidence" : "Reading every source slide", 8);
      const cachedAnalysis = cachedPlanningValue<TikTokAutomationAnalysis>(cachedRun?.analysis_json);
      const cachedObservations = cachedPlanningValue<TikTokReferenceObservation[]>(cachedRun?.observations_json);
      let sourceAnalysisProgress = cachedAnalysis ? 1 : 0;
      let personaAnalysisProgress = !identityMode || cachedObservations ? 1 : 0;
      const reportCombinedAnalysis = (label: string) => {
        const combined = (sourceAnalysisProgress + personaAnalysisProgress) / 2;
        report(planningStage, label, 8 + Math.round(combined * 20));
      };
      const [analysis, observations] = await Promise.all([
        cachedAnalysis ? Promise.resolve(cachedAnalysis) : withOpenRouterUsageStage("source_analysis", () => analyzeTikTokSlideshow({
          slides,
          caption: input.caption,
          onProgress(fraction, label) {
            sourceAnalysisProgress = fraction;
            reportCombinedAnalysis(label);
          },
        })).then((value) => {
          void savePlanningArtifacts({ analysis_json: JSON.stringify(value) });
          return value;
        }),
        !identityMode ? Promise.resolve([]) : cachedObservations ? Promise.resolve(cachedObservations) : withOpenRouterUsageStage("identity_analysis", () => inspectTikTokPersonaReferences({
          persona: personaContext,
          assets: personaInputAssets,
          onProgress(fraction, label) {
            personaAnalysisProgress = fraction;
            reportCombinedAnalysis(label);
          },
        })).then((value) => {
          void savePlanningArtifacts({ observations_json: JSON.stringify(value) });
          return value;
        }),
      ]);

      planningStage = "brief_interpretation";
      report(planningStage, "Interpreting the creative brief and source mechanic", 30);
      const cachedIntent = cachedPlanningValue<TikTokAutomationIntentContract>(cachedRun?.intent_json);
      const interpretedIntent: TikTokAutomationIntentContract = cachedIntent ?? await withOpenRouterUsageStage("intent_interpretation", () => interpretTikTokAutomationBrief({
        analysis, slides, preferences: input.preferences, persona: personaContext,
        observations, assets: personaInputAssets, maxPersonaReferences: identityMode ? model.maxReferences - 1 : 0,
      })).then(async (value) => {
        planningStage = "text_sequence";
        report(planningStage, "Rewriting and checking the full text sequence", 42);
        const refined = await withOpenRouterUsageStage("text_sequence", () => rewriteAndReviewTikTokTextSequence({
          analysis, intentContract: value, preferences: input.preferences, workspaceRolePrompt,
        }));
        void savePlanningArtifacts({ intent_json: JSON.stringify(refined) });
        return refined;
      });
      const intentContract = enforceTikTokAutomationPreferenceContract(interpretedIntent, input.preferences);
      await savePlanningArtifacts({ intent_json: JSON.stringify(intentContract) });

      planningStage = "reference_binding";
      report(planningStage, "Assigning only the references each slide needs", 53);
      const cachedBinding = cachedPlanningValue<TikTokAutomationReferenceBindingPlan>(cachedRun?.binding_json);
      const referenceBindingPlan: TikTokAutomationReferenceBindingPlan = cachedBinding ?? await withOpenRouterUsageStage("reference_binding", () => bindTikTokAutomationReferences({
        analysis, intentContract, slides, persona: personaContext,
        observations, assets: personaInputAssets, maxPersonaReferences: identityMode ? model.maxReferences - 1 : 0,
        mode: input.preferences.mode, preferences: input.preferences,
      })).then((value) => {
        void savePlanningArtifacts({ binding_json: JSON.stringify(value) });
        return value;
      });
      const semanticContract = assembleTikTokSemanticContract(intentContract, referenceBindingPlan);
      const direction = directionFromTikTokIntentContract(intentContract);

      planningStage = "slide_prompt_planning";
      report(planningStage, "Building reviewed instructions for every slide", 64);
      const slidePlans: TikTokAutomationPlanResponse["slides"] = new Array(slides.length);
      const planningInputs = slides.map((slide) => {
        const slideContract = semanticContract.slides.find((item) => item.index === slide.index);
        if (!slideContract) throw new Error(`Semantic contract is missing slide ${slide.index}`);
        const selectedAssets = slideContract.selectedPersonaAssetIds
          .map((assetId) => personaAssets.find((asset) => asset.id === assetId))
          .filter((asset): asset is PersonaAssetRow => Boolean(asset));
        if (selectedAssets.length !== slideContract.selectedPersonaAssetIds.length) {
          throw new Error(`Semantic contract selected an unavailable identity reference for slide ${slide.index}`);
        }
        const sourceToken = referenceMentionToken(slide.title, 0);
        const personaReferences = selectedAssets.map((asset, assetIndex) => ({
          id: asset.id,
          filename: asset.filename,
          token: referenceMentionToken(persona?.name || "Identity", assetIndex + 1),
          title: `${persona?.name || "Identity"} Reference ${assetIndex + 1}`,
          role: asset.role,
          path: asset.storage_path,
          mimeType: asset.mime_type,
        }));
        return { slide, slideContract, sourceToken, personaReferences };
      });
      const buildSlidePlan = async (planningInput: (typeof planningInputs)[number], externalFeedback?: string[]) => {
        let plan;
        try {
          plan = await withOpenRouterUsageStage(`slide_${planningInput.slide.index}_planning`, () => planAndReviewTikTokSlide({
            ...planningInput, analysis, semanticContract, direction, preferences: input.preferences, persona: personaContext, externalFeedback,
          }));
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`Slide ${planningInput.slide.index} planning failed: ${detail}`);
        }
        plan.personaAssetIds = planningInput.personaReferences.map((asset) => asset.id);
        plan.referenceCount = 1 + planningInput.personaReferences.length;
        plan.creditCost = generationCreditCost(model.id, model.defaultResolution || model.resolutions[0], "5", plan.referenceCount);
        return plan;
      };
      let plannedSlides = 0;
      const results = await settleWithConcurrency(planningInputs, 3, async (planningInput, index) => {
        slidePlans[index] = await buildSlidePlan(planningInput);
        plannedSlides += 1;
        report(planningStage, `Building reviewed instructions · ${plannedSlides}/${planningInputs.length}`, 64 + Math.round((plannedSlides / planningInputs.length) * 15));
      });
      const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
      if (rejected) throw rejected.reason;

      planningStage = "series_review";
      report(planningStage, "Checking consistency across the complete slideshow", 82);
      let seriesIssues = await withOpenRouterUsageStage("series_review", () => reviewTikTokSlideSeries({
        semanticContract, direction, preferences: input.preferences,
        slides: planningInputs.map((planningInput, index) => ({ ...planningInput, plan: slidePlans[index] })),
      }));
      if (seriesIssues.size) {
        planningStage = "series_repair";
        report(planningStage, "Repairing only the slides that failed review", 88);
        const repairs = planningInputs
          .map((planningInput, index) => ({ planningInput, index, issues: seriesIssues.get(planningInput.slide.index) }))
          .filter((item): item is typeof item & { issues: string[] } => Boolean(item.issues?.length));
        const repairResults = await settleWithConcurrency(repairs, 3, async ({ planningInput, index, issues }) => {
          slidePlans[index] = await buildSlidePlan(planningInput, issues);
        });
        const rejectedRepair = repairResults.find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
        if (rejectedRepair) throw rejectedRepair.reason;
        planningStage = "series_recheck";
        report(planningStage, "Running the final sequence check", 93);
        seriesIssues = await withOpenRouterUsageStage("series_recheck", () => reviewTikTokSlideSeries({
          semanticContract, direction, preferences: input.preferences,
          slides: planningInputs.map((planningInput, index) => ({ ...planningInput, plan: slidePlans[index] })),
        }));
        if (seriesIssues.size) {
          const unresolved = [...seriesIssues.entries()].map(([index, issues]) => `slide ${index}: ${issues.join("; ")}`).join(" | ");
          throw new Error(`Series QA remained unresolved after targeted repair: ${unresolved}`);
        }
      }

      planningStage = "finalizing";
      report(planningStage, "Finalizing credits and the reviewed plan", 97);
      const generationCredits = slidePlans.reduce((sum, slide) => sum + slide.creditCost, 0);
      const usage = summarizeOpenRouterUsage(usageTracker);
      const measuredPlanningCredits = providerCostToUsageUnits(usage.costUsd);
      const settlement = planningReserveCredits === 0
        ? { chargedCredits: 0, capped: false, settled: true }
        : await authority.settleAutomation({
          reservationId: planningReservationId,
          actualCredits: measuredPlanningCredits,
          actualCostUsd: usage.costUsd,
          metadata: {
            modelId: planningModel.id, measuredPlanningCredits, reservedPlanningCredits: planningReserveCredits,
            requestCount: usage.requestCount, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens, usageEntries: usageTracker.entries,
          },
        });
      const currentUsage = await authority.summary(usageWorkspaceId);
      if (currentUsage.usageMode === "metered" && generationCredits > currentUsage.remaining) {
        return failure(402, {
          error: `The reviewed slides need ${generationCredits} generation credits. You have ${currentUsage.remaining}.`,
          code: "INSUFFICIENT_CREDITS", estimatedCredits: settlement.chargedCredits + generationCredits,
          planningCredits: settlement.chargedCredits, generationCredits, availableCredits: currentUsage.remaining,
        });
      }

      const response: TikTokAutomationPlanResponse = {
        analysis,
        semanticContract,
        direction,
        slides: slidePlans,
        persona: persona ? {
          id: persona.id,
          name: persona.name,
          notes: persona.notes || "",
          assets: personaAssets.map((asset) => ({ id: asset.id, filename: asset.filename, role: asset.role, url: `/api/assets/${asset.id}` })),
        } : null,
        model: {
          id: model.id,
          label: model.label,
          maxReferences: model.maxReferences,
          defaultRatio: model.ratios.includes("9:16") ? "9:16" : model.defaultRatio || model.ratios[0],
          defaultResolution: model.defaultResolution || model.resolutions[0],
        },
        planningModel: { id: planningModel.id, label: planningModel.label },
        planningCredits: settlement.chargedCredits,
        planningCostUsd: usage.costUsd,
        generationCredits,
        estimatedCredits: settlement.chargedCredits + generationCredits,
        availableCredits: currentUsage.remaining,
      };
      return { status: 200, body: response };
    }));
  } catch (error) {
    const usage = summarizeOpenRouterUsage(usageTracker);
    if (planningReserveCredits > 0) {
      await authority.releaseAutomation(planningReservationId, "planning_failed", {
        planningStage, modelId: planningModel.id, incurredCostUsd: usage.costUsd,
        requestCount: usage.requestCount, totalTokens: usage.totalTokens,
      });
    }
    console.error("TikTok automation planning failed", { projectId: input.projectId, sourceNodeId: input.sourceNodeId, planningStage, error });
    return failure(502, { error: "TikTok automation could not build this plan. Try again." });
  }
}
