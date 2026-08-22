"use client";

import { LayoutGrid, MapPin, Shirt, UserRound, Workflow, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { generatorModelCreditDescription, type GeneratorModelOption } from "@/components/FrameNode";
import { InspectorSelect } from "@/components/InspectorSelect";
import { tiktokPlanningReserveCredits } from "@/lib/automation-pricing";
import { tiktokAutomationPlanningModels } from "@/lib/assistant-models";
import type { PersonaRecord } from "@/lib/types";
import type { TikTokAutomationMode, TikTokTextStrategy } from "@/lib/tiktok-automation-types";
import type { TikTokSlideshowSource } from "@/lib/tiktok-slideshow-sources";

export type TikTokAutomationStatus = "idle" | "planning" | "building" | "generating" | "complete" | "failed";
export const TIKTOK_AUTOMATION_STAGES = [
  { id: "analyze", label: "Analyze", detail: "Source" },
  { id: "decompose", label: "Decompose", detail: "Mechanic" },
  { id: "rewrite", label: "Rewrite", detail: "Copy" },
  { id: "direct", label: "Direct", detail: "Visuals" },
  { id: "references", label: "References", detail: "Identity" },
  { id: "review", label: "Review", detail: "Sequence" },
  { id: "build", label: "Build", detail: "Nodes" },
  { id: "generate", label: "Generate", detail: "Images" },
] as const;
export type TikTokAutomationStage = "ready" | (typeof TIKTOK_AUTOMATION_STAGES)[number]["id"];
export type TikTokAutomationSlideState = {
  index: number;
  role: string;
  personaVariant: string;
  status: "planned" | "queued" | "generating" | "ready" | "failed";
  nodeId?: string;
};
export type TikTokAutomationDemoTarget = "identity" | "wardrobe" | "location" | "text-remove" | "run";

export function TikTokAutomationPanel({
  sources,
  sourceId,
  setSourceId,
  mode,
  setMode,
  personas,
  personaId,
  setPersonaId,
  models,
  modelId,
  setModelId,
  planningModelId,
  setPlanningModelId,
  newOutfit,
  setNewOutfit,
  newLocation,
  setNewLocation,
  textStrategy,
  setTextStrategy,
  creativeBrief,
  setCreativeBrief,
  status,
  activeStage,
  stageLabel,
  planningProgress,
  slideStates,
  estimatedCredits,
  planningCredits,
  generationCredits,
  demoTarget,
  demoPress = false,
  demoFormScroll,
  onRun,
  onClose,
}: {
  sources: TikTokSlideshowSource[];
  sourceId: string;
  setSourceId: (value: string) => void;
  mode: TikTokAutomationMode;
  setMode: (value: TikTokAutomationMode) => void;
  personas: PersonaRecord[];
  personaId: string;
  setPersonaId: (value: string) => void;
  models: GeneratorModelOption[];
  modelId: string;
  setModelId: (value: string) => void;
  planningModelId: string;
  setPlanningModelId: (value: string) => void;
  newOutfit: boolean;
  setNewOutfit: (value: boolean) => void;
  newLocation: boolean;
  setNewLocation: (value: boolean) => void;
  textStrategy: TikTokTextStrategy;
  setTextStrategy: (value: TikTokTextStrategy) => void;
  creativeBrief: string;
  setCreativeBrief: (value: string) => void;
  status: TikTokAutomationStatus;
  activeStage: TikTokAutomationStage;
  stageLabel: string;
  planningProgress: number;
  slideStates: TikTokAutomationSlideState[];
  estimatedCredits: number;
  planningCredits: number;
  generationCredits: number;
  demoTarget?: TikTokAutomationDemoTarget;
  demoPress?: boolean;
  demoFormScroll?: number;
  onRun: () => void;
  onClose: () => void;
}) {
  const formRef = useRef<HTMLDivElement>(null);
  const selectedSource = sources.find((source) => source.id === sourceId);
  const selectedPersona = personas.find((persona) => persona.id === personaId);
  const sourceSlideCount = Math.max(1, selectedSource?.assetIds.length || 0);
  const identityStageReferenceCount = Math.max(
    selectedPersona?.assets.filter((asset) => asset.role === "reference").length || 0,
    selectedPersona?.assets.filter((asset) => asset.role === "before").length || 0,
    selectedPersona?.assets.filter((asset) => asset.role === "after").length || 0,
  );
  const busy = status === "planning" || status === "building" || status === "generating";
  const finishedSlides = slideStates.filter((slide) => slide.status === "ready" || slide.status === "failed").length;
  const activeStageIndex = TIKTOK_AUTOMATION_STAGES.findIndex((step) => step.id === activeStage);
  const currentStage = activeStageIndex >= 0 ? TIKTOK_AUTOMATION_STAGES[activeStageIndex] : null;
  const stageBaseProgress = activeStageIndex < 0 ? 0 : Math.round((activeStageIndex / TIKTOK_AUTOMATION_STAGES.length) * 100);
  const generationProgress = slideStates.length ? Math.round((finishedSlides / slideStates.length) * (100 / TIKTOK_AUTOMATION_STAGES.length)) : 0;
  const measuredProgress = status === "complete"
    ? 100
    : status === "planning"
      ? Math.min(78, Math.round(Math.max(0, planningProgress) * 0.78))
      : status === "building"
        ? 82
        : status === "generating"
          ? Math.min(99, 84 + Math.round((finishedSlides / Math.max(1, slideStates.length)) * 15))
          : Math.min(99, stageBaseProgress + (activeStage === "generate" ? generationProgress : busy && activeStageIndex >= 0 ? 5 : 0));
  const [displayProgress, setDisplayProgress] = useState(measuredProgress);

  useEffect(() => {
    queueMicrotask(() => setDisplayProgress((current) => {
      if (!busy || measuredProgress < current - 15) return measuredProgress;
      return Math.max(current, measuredProgress);
    }));
  }, [busy, measuredProgress]);

  useEffect(() => {
    if (!busy) return;
    const ceiling = status === "planning" ? Math.min(77, measuredProgress + 6) : Math.min(99, measuredProgress + 2);
    const timer = window.setInterval(() => {
      setDisplayProgress((current) => {
        if (current >= ceiling) return current;
        return Math.min(ceiling, current + Math.max(0.08, (ceiling - current) * 0.045));
      });
    }, 900);
    return () => window.clearInterval(timer);
  }, [busy, measuredProgress, status]);

  useEffect(() => {
    if (demoFormScroll === undefined) return;
    const frame = window.requestAnimationFrame(() => {
      const form = formRef.current;
      if (!form) return;
      const progress = Math.max(0, Math.min(1, demoFormScroll));
      form.scrollTo({ top: Math.max(0, form.scrollHeight - form.clientHeight) * progress, behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [demoFormScroll, mode]);

  const visibleProgress = Math.max(busy ? 4 : 0, Math.min(100, displayProgress));
  const visiblePercent = Math.floor(visibleProgress);
  return <aside
    className="tiktok-automation-panel"
    data-demo-target={demoTarget}
    data-demo-press={demoPress ? "true" : undefined}
    onPointerDown={(event) => event.stopPropagation()}
  >
    <header className="tiktok-automation-head">
      <div><span className="eyebrow">TIKTOK AUTOMATION</span><h2>Recreate a viral slideshow</h2><p>Carry over the source mechanic, then choose whether the new series needs a fixed identity.</p></div>
      <button type="button" onClick={onClose} aria-label="Close TikTok automation"><X size={16} /></button>
    </header>

    <div ref={formRef} className="tiktok-automation-form">
      <label><span>Source slideshow</span><InspectorSelect label="TikTok source" value={sourceId} onChange={setSourceId} disabled={busy} options={sources.map((source) => ({ value: source.id, label: source.label, description: source.description }))} /></label>
      <label><span>Adaptation mode</span><div className="tiktok-automation-modes">
        <button type="button" className={mode === "concept" ? "is-active" : ""} disabled={busy} onClick={() => setMode("concept")}><LayoutGrid size={15} /><span><b>Adapt concept</b><small>New original slides from the same mechanic. No identity required.</small></span></button>
        <button type="button" className={mode === "identity" ? "is-active" : ""} disabled={busy} onClick={() => setMode("identity")}><UserRound size={15} /><span><b>Cast identity</b><small>Use one selected identity only where a slide needs that person.</small></span></button>
      </div></label>
      <div className={`tiktok-automation-grid ${mode === "concept" ? "is-single" : ""}`}>
        {mode === "identity" && <label><span>Identity</span><InspectorSelect label="Identity" value={personaId} onChange={setPersonaId} disabled={busy} options={personas.map((persona) => ({ value: persona.id, label: persona.name, description: `${persona.assets.length} references` }))} /></label>}
        <label><span>Image model</span><InspectorSelect label="Image model" value={modelId} onChange={setModelId} disabled={busy} options={models.filter((model) => model.mediaType === "image" && model.maxReferences >= (mode === "identity" ? 2 : 1)).map((model) => ({
          value: model.id,
          label: model.label,
          description: generatorModelCreditDescription(model, {
            referenceCount: 1 + (mode === "identity" ? Math.min(4, Math.max(0, model.maxReferences - 1), identityStageReferenceCount) : 0),
          }),
        }))} /></label>
      </div>
      <label className="tiktok-automation-planner"><span>Planning model</span><InspectorSelect label="Planning model" value={planningModelId} onChange={setPlanningModelId} disabled={busy} options={tiktokAutomationPlanningModels.map((model) => {
        const credits = tiktokPlanningReserveCredits(sourceSlideCount, model.id);
        return { value: model.id, label: model.label, description: `≈ ${credits.toLocaleString("en-US")} credits` };
      })} /></label>

      <div className="tiktok-automation-toggles">
        <button type="button" className={newOutfit ? "is-on" : ""} disabled={busy} onClick={() => setNewOutfit(!newOutfit)}><Shirt size={16} /><span><b>{mode === "identity" ? "New wardrobe" : "New subjects"}</b><small>{mode === "identity" ? "Avoid copying the source outfit" : "Replace people, products and examples"}</small></span><i /></button>
        <button type="button" className={newLocation ? "is-on" : ""} disabled={busy} onClick={() => setNewLocation(!newLocation)}><MapPin size={16} /><span><b>{mode === "identity" ? "New location" : "New setting"}</b><small>{mode === "identity" ? "Keep function, change the place" : "Adapt the scene or graphic background"}</small></span><i /></button>
      </div>

      <label><span>On-screen text</span><div className="tiktok-automation-segments">{(["keep", "rewrite", "remove"] as TikTokTextStrategy[]).map((value) => <button type="button" className={textStrategy === value ? "is-active" : ""} key={value} disabled={busy} onClick={() => setTextStrategy(value)}>{value}</button>)}</div></label>
      <label><span>Creative direction <em>optional</em></span><textarea value={creativeBrief} disabled={busy} onChange={(event) => setCreativeBrief(event.target.value)} placeholder="Theme, product, audience, comment angle or details that must stay consistent…" maxLength={4000} /></label>
    </div>

    {status !== "idle" && <section className={`tiktok-automation-run is-${status}`} aria-live="polite">
      <div className="tiktok-automation-run-head">
        <span><strong>{status === "complete" ? "Slides ready" : status === "failed" ? "Automation paused" : currentStage?.label || "Preparing"}</strong><small>{stageLabel}</small></span>
        <b>{status === "complete" ? "DONE" : status === "failed" ? "CHECK" : `${visiblePercent}%`}</b>
      </div>
      <div className={`tiktok-automation-progress ${busy ? "is-active" : ""}`} role="progressbar" aria-label={`${visiblePercent}% complete`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={visiblePercent}><i style={{ width: `${visibleProgress}%` }} /></div>
    </section>}

    <footer>
      <p>{selectedSource ? `${selectedSource.assetIds.length} source ${selectedSource.assetIds.length === 1 ? "slide" : "slides"} · ${estimatedCredits.toLocaleString("en-US")} credits (${planningCredits.toLocaleString("en-US")} plan + ${generationCredits.toLocaleString("en-US")} images)` : "Import a TikTok slideshow first"}</p>
      <div className="tiktok-automation-run-control">
        <span role="tooltip">Run {selectedSource?.assetIds.length || 0} {selectedSource?.assetIds.length === 1 ? "slide" : "slides"} · {planningCredits.toLocaleString("en-US")} planning + {generationCredits.toLocaleString("en-US")} generation credits</span>
        <button type="button" disabled={busy || !selectedSource || (mode === "identity" && !personaId) || !modelId} onClick={onRun} title={`Run ${estimatedCredits.toLocaleString("en-US")} credits`}>{!busy && <Workflow size={15} />}{busy ? "Automation running" : `Build & run ${selectedSource?.assetIds.length || 0} ${selectedSource?.assetIds.length === 1 ? "slide" : "slides"}`}</button>
      </div>
    </footer>
  </aside>;
}
