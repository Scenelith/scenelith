"use client";

import { FileUp, Plus, Settings2, Workflow, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { generatorRatiosFor, generatorResolutionsFor, type GeneratorModelOption } from "@/components/FrameNode";
import { InspectorSelect } from "@/components/InspectorSelect";
import { tiktokAutomationPlanningModels } from "@/lib/assistant-models";
import type { AutomationCapabilities } from "@/editions/contracts/access";
import type { PersonaRecord } from "@/lib/types";
import type { TikTokSlideshowSource } from "@/lib/tiktok-slideshow-sources";
import type { AutomationRunInputField, AutomationWorkflowDetail, AutomationWorkflowRecord } from "@/lib/automation-workflows/types";

export type TikTokAutomationStatus = "idle" | "planning" | "building" | "generating" | "complete" | "failed";
export type TikTokAutomationSlideState = {
  index: number;
  role: string;
  personaVariant: string;
  status: "planned" | "queued" | "generating" | "ready" | "failed";
  nodeId?: string;
};

export type TikTokAutomationPanelDemo = Readonly<{
  workflows: AutomationWorkflowRecord[];
  capabilities: AutomationCapabilities;
  detail: AutomationWorkflowDetail;
  productionRunInputs: AutomationRunInputField[];
  draftRunInputs?: AutomationRunInputField[];
  runtimeValues?: Record<string, unknown>;
  openTriggerAlerts?: Record<string, number>;
}>;

function emptyRuntimeValue(value: unknown) {
  return value === undefined || value === null || (typeof value === "string" && !value.trim()) || (Array.isArray(value) && value.length === 0);
}

function RuntimeJsonField({ value, disabled, onChange }: { value: unknown; disabled: boolean; onChange: (value: unknown) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [invalid, setInvalid] = useState(false);
  return <div className={`automation-runtime-json ${invalid ? "is-invalid" : ""}`}>
    <textarea value={text} disabled={disabled} spellCheck={false} onChange={(event) => setText(event.target.value)} onBlur={() => {
      try { onChange(JSON.parse(text)); setInvalid(false); }
      catch { setInvalid(true); }
    }} />
    {invalid && <small>Enter valid JSON.</small>}
  </div>;
}

export function TikTokAutomationPanel({
  projectId,
  workflowId,
  setWorkflowId,
  workflowRefreshKey,
  demo,
  onConfigure,
  sources,
  personas,
  models,
  status,
  stageLabel,
  planningProgress,
  slideStates,
  onRun,
  onCancel,
  onClose,
  onSourceSelected,
  onRuntimeValuesChange,
}: {
  workspaceId?: string;
  projectId: string;
  workflowId: string;
  setWorkflowId: (value: string) => void;
  workflowRefreshKey: number;
  demo?: TikTokAutomationPanelDemo;
  onConfigure: (workflowId: string) => void;
  sources: TikTokSlideshowSource[];
  personas: PersonaRecord[];
  models: GeneratorModelOption[];
  status: TikTokAutomationStatus;
  stageLabel: string;
  planningProgress: number;
  slideStates: TikTokAutomationSlideState[];
  onRun: (runtimeInputs: Record<string, unknown>, mode: "production" | "test") => void;
  onCancel: () => void;
  onClose: () => void;
  onSourceSelected?: (sourceId: string) => void;
  onRuntimeValuesChange?: (workflowId: string, values: Record<string, unknown>) => void;
}) {
  const initialDemoInputs = demo ? [...new Map([...(demo.productionRunInputs || []), ...(demo.draftRunInputs || [])].map((field) => [field.key, field])).values()] : [];
  const [workflows, setWorkflows] = useState<AutomationWorkflowRecord[]>(() => demo?.workflows || []);
  const [capabilities, setCapabilities] = useState<AutomationCapabilities>(() => demo?.capabilities || { run: false, edit: false, publish: false, manageTriggers: false, manageCredentials: false });
  const [openTriggerAlerts, setOpenTriggerAlerts] = useState<Record<string, number>>(() => demo?.openTriggerAlerts || {});
  const [workflowError, setWorkflowError] = useState("");
  const [creatingWorkflow, setCreatingWorkflow] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [runInputs, setRunInputs] = useState<AutomationRunInputField[]>(() => initialDemoInputs);
  const [productionRunInputs, setProductionRunInputs] = useState<AutomationRunInputField[]>(() => demo?.productionRunInputs || []);
  const [draftRunInputs, setDraftRunInputs] = useState<AutomationRunInputField[]>(() => demo?.draftRunInputs || []);
  const [runtimeValuesByWorkflow, setRuntimeValuesByWorkflow] = useState<Record<string, Record<string, unknown>>>(() => demo ? { [demo.detail.workflow.id]: demo.runtimeValues || {} } : {});
  const workflowIdRef = useRef(workflowId);
  const setWorkflowIdRef = useRef(setWorkflowId);
  const busy = status === "planning" || status === "building" || status === "generating";
  const selectedWorkflow = workflows.find((workflow) => workflow.id === workflowId);
  const selectedAlertCount = openTriggerAlerts[workflowId] || 0;
  const runtimeValues = useMemo(() => runtimeValuesByWorkflow[workflowId] || {}, [runtimeValuesByWorkflow, workflowId]);
  const nodeManagedInputKeys = useMemo(() => new Set(runInputs.filter((field) => field.valueType === "visual-references").map((field) => field.key)), [runInputs]);
  const panelRuntimeValues = useMemo(() => Object.fromEntries(Object.entries(runtimeValues).filter(([key]) => !nodeManagedInputKeys.has(key))), [nodeManagedInputKeys, runtimeValues]);
  const visibleRunInputs = useMemo(() => runInputs.filter((field) => field.valueType !== "visual-references"), [runInputs]);
  const runtimeValuesChangeRef = useRef(onRuntimeValuesChange);
  useEffect(() => { runtimeValuesChangeRef.current = onRuntimeValuesChange; }, [onRuntimeValuesChange]);
  useEffect(() => { runtimeValuesChangeRef.current?.(workflowId, panelRuntimeValues); }, [panelRuntimeValues, workflowId]);

  useEffect(() => { workflowIdRef.current = workflowId; }, [workflowId]);
  useEffect(() => { setWorkflowIdRef.current = setWorkflowId; }, [setWorkflowId]);

  useEffect(() => {
    if (demo) return;
    let cancelled = false;
    void fetch(`/api/automation-workflows?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { workflows?: AutomationWorkflowRecord[]; capabilities?: AutomationCapabilities; openTriggerAlerts?: Record<string, number>; error?: string };
        if (!response.ok) throw new Error(body.error || "Could not load workflows");
        if (cancelled) return;
        const next = body.workflows || [];
        setWorkflows(next);
        if (body.capabilities) setCapabilities(body.capabilities);
        setOpenTriggerAlerts(body.openTriggerAlerts || {});
        setWorkflowError("");
        const currentWorkflowId = workflowIdRef.current;
        if (!next.some((workflow) => workflow.id === currentWorkflowId) && next[0]) setWorkflowIdRef.current(next[0].id);
      })
      .catch((error) => { if (!cancelled) setWorkflowError(error instanceof Error ? error.message : "Could not load workflows"); });
    return () => { cancelled = true; };
  }, [demo, projectId, workflowRefreshKey]);

  useEffect(() => {
    if (!workflowId || demo) return;
    let cancelled = false;
    void fetch(`/api/automation-workflows/${encodeURIComponent(workflowId)}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as AutomationWorkflowDetail & { capabilities?: AutomationCapabilities; runInputs?: AutomationRunInputField[]; draftRunInputs?: AutomationRunInputField[]; error?: string };
        if (!response.ok) throw new Error(body.error || "Could not load workflow inputs");
        if (cancelled) return;
        const publishedFields = body.runInputs || [];
        const draftFields = body.draftRunInputs || [];
        const fields = [...new Map([...publishedFields, ...draftFields].map((field) => [field.key, field])).values()];
        setProductionRunInputs(publishedFields);
        setDraftRunInputs(draftFields);
        if (body.capabilities) setCapabilities(body.capabilities);
        setRunInputs(fields);
        setWorkflows((current) => current.map((workflow) => workflow.id === body.workflow.id ? body.workflow : workflow));
        setRuntimeValuesByWorkflow((current) => {
          const saved = current[workflowId] || {};
          const next: Record<string, unknown> = {};
          for (const field of fields) {
            if (field.key in saved) next[field.key] = saved[field.key];
            else if (field.value !== undefined) next[field.key] = field.value;
            else if (field.valueType === "boolean") next[field.key] = false;
            else if (field.valueType === "tiktok-source") next[field.key] = field.required ? sources[0]?.id || "" : "";
            else if (field.valueType === "identity") next[field.key] = "";
            else if (field.valueType === "visual-references") next[field.key] = [];
            else if (field.valueType === "assistant-model") next[field.key] = tiktokAutomationPlanningModels[0]?.id || "";
            else if (field.valueType === "image-model") next[field.key] = models.find((model) => model.mediaType === "image" && model.maxReferences > 0)?.id || "";
            else if (field.options?.length) next[field.key] = field.options[0].value;
            else next[field.key] = "";
          }
          for (const modelField of fields.filter((field) => field.valueType === "image-model")) {
            const model = models.find((candidate) => candidate.id === next[modelField.key]);
            const resolutionField = fields.find((field) => field.nodeId === modelField.nodeId && field.valueType === "resolution");
            const ratioField = fields.find((field) => field.nodeId === modelField.nodeId && field.valueType === "aspect-ratio");
            const resolutions = generatorResolutionsFor(model, false);
            if (resolutionField && !resolutions.includes(String(next[resolutionField.key] || ""))) next[resolutionField.key] = model?.defaultResolution || resolutions[0] || "";
            const ratios = generatorRatiosFor(model, resolutionField ? String(next[resolutionField.key] || "") : undefined, true);
            if (ratioField && !ratios.includes(String(next[ratioField.key] || ""))) next[ratioField.key] = model?.defaultRatio && ratios.includes(model.defaultRatio) ? model.defaultRatio : ratios[0] || "";
          }
          return { ...current, [workflowId]: next };
        });
        setWorkflowError("");
      })
      .catch((error) => { if (!cancelled) setWorkflowError(error instanceof Error ? error.message : "Could not load workflow inputs"); });
    return () => { cancelled = true; };
  }, [demo, models, personas, sources, workflowId, workflowRefreshKey]);

  const setRuntimeField = (field: AutomationRunInputField, value: unknown) => setRuntimeValuesByWorkflow((current) => {
    const next = { ...(current[workflowId] || {}), [field.key]: value };
    const modelField = field.valueType === "image-model"
      ? field
      : runInputs.find((candidate) => candidate.nodeId === field.nodeId && candidate.valueType === "image-model");
    const model = models.find((candidate) => candidate.id === (modelField ? next[modelField.key] : ""));
    const resolutionField = runInputs.find((candidate) => candidate.nodeId === field.nodeId && candidate.valueType === "resolution");
    const ratioField = runInputs.find((candidate) => candidate.nodeId === field.nodeId && candidate.valueType === "aspect-ratio");
    const resolutions = generatorResolutionsFor(model, false);
    if (resolutionField && !resolutions.includes(String(next[resolutionField.key] || ""))) next[resolutionField.key] = model?.defaultResolution || resolutions[0] || "";
    const ratios = generatorRatiosFor(model, resolutionField ? String(next[resolutionField.key] || "") : undefined, true);
    if (ratioField && !ratios.includes(String(next[ratioField.key] || ""))) next[ratioField.key] = model?.defaultRatio && ratios.includes(model.defaultRatio) ? model.defaultRatio : ratios[0] || "";
    return { ...current, [workflowId]: next };
  });

  const sourceField = runInputs.find((field) => field.valueType === "tiktok-source");
  const selectedSource = sourceField ? sources.find((source) => source.id === runtimeValues[sourceField.key]) : null;
  const requiredMissing = (fields: AutomationRunInputField[]) => fields.some((field) => field.required && emptyRuntimeValue(runtimeValues[field.key]));
  const inputsFor = (fields: AutomationRunInputField[]) => Object.fromEntries(fields.map((field) => [field.key, runtimeValues[field.key]]));
  const runnable = Boolean(selectedWorkflow?.publishedVersionId || selectedWorkflow?.status === "system");
  const testable = capabilities.edit && Boolean(selectedWorkflow?.draftVersionId);
  const finishedSlides = slideStates.filter((slide) => slide.status === "ready" || slide.status === "failed").length;
  const visibleProgress = status === "complete" ? 100 : status === "generating"
    ? Math.min(99, 84 + Math.round((finishedSlides / Math.max(1, slideStates.length)) * 15))
    : Math.min(99, Math.max(busy ? 4 : 0, planningProgress));

  const fieldOptions = (field: AutomationRunInputField) => {
    if (field.valueType === "tiktok-source") return sources.map((source) => ({ value: source.id, label: source.label, description: source.description }));
    if (field.valueType === "identity") return [
      ...(!field.required ? [{ value: "", label: "No identity", description: "Run without identity references" }] : []),
      ...personas.map((persona) => ({ value: persona.id, label: persona.name, description: `${persona.assets.length} references` })),
    ];
    if (field.valueType === "assistant-model") return tiktokAutomationPlanningModels.map((model) => ({ value: model.id, label: model.label }));
    if (field.valueType === "image-model") return models.filter((model) => model.mediaType === "image" && model.maxReferences > 0).map((model) => ({ value: model.id, label: model.label, description: model.description }));
    const modelField = runInputs.find((candidate) => candidate.nodeId === field.nodeId && candidate.valueType === "image-model");
    const selectedModel = models.find((model) => model.id === (modelField ? runtimeValues[modelField.key] : ""));
    if (field.valueType === "resolution") return generatorResolutionsFor(selectedModel, false).map((value) => ({ value, label: value }));
    if (field.valueType === "aspect-ratio") {
      const resolutionField = runInputs.find((candidate) => candidate.nodeId === field.nodeId && candidate.valueType === "resolution");
      return generatorRatiosFor(selectedModel, resolutionField ? String(runtimeValues[resolutionField.key] || "") : undefined, true).map((value) => ({ value, label: value }));
    }
    return field.options?.map((option) => ({ ...option })) || [];
  };

  async function createWorkflow() {
    if (creatingWorkflow || busy) return;
    setCreatingWorkflow(true);
    setWorkflowError("");
    try {
      const response = await fetch("/api/automation-workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, name: "Untitled automation" }),
      });
      const body = await response.json() as AutomationWorkflowDetail & { error?: string };
      if (!response.ok || !body.workflow?.id) throw new Error(body.error || "Could not create a workflow");
      setWorkflows((current) => [...current.filter((workflow) => workflow.id !== body.workflow.id), body.workflow]);
      setWorkflowId(body.workflow.id);
      onConfigure(body.workflow.id);
    } catch (error) {
      setWorkflowError(error instanceof Error ? error.message : "Could not create a workflow");
    } finally {
      setCreatingWorkflow(false);
    }
  }

  async function importWorkflow(file: File | undefined) {
    if (!file || busy || creatingWorkflow) return;
    setCreatingWorkflow(true);
    setWorkflowError("");
    try {
      if (file.size > 3_000_000) throw new Error("Automation packages must be smaller than 3 MB");
      const portable = JSON.parse(await file.text()) as unknown;
      const response = await fetch("/api/automation-workflows/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, package: portable }),
      });
      const body = await response.json() as { detail?: AutomationWorkflowDetail; error?: string };
      if (!response.ok || !body.detail?.workflow) throw new Error(body.error || "Could not import this automation");
      const imported = body.detail.workflow;
      setWorkflows((current) => [...current.filter((workflow) => workflow.id !== imported.id), imported]);
      setWorkflowId(imported.id);
      onConfigure(imported.id);
    } catch (error) {
      setWorkflowError(error instanceof SyntaxError ? "Choose a valid Scenelith automation JSON file" : error instanceof Error ? error.message : "Could not import this automation");
    } finally {
      setCreatingWorkflow(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  }

  return <aside className="tiktok-automation-panel" onPointerDown={(event) => event.stopPropagation()}>
    <header className="tiktok-automation-head">
      <div><span className="eyebrow">AUTOMATION</span><h2>{selectedWorkflow?.name || "Choose a workflow"}</h2><p>{selectedWorkflow?.description || "Select, configure and run a published workflow."}</p></div>
      <div className="tiktok-automation-head-actions">
        <input ref={importInputRef} type="file" accept="application/json,.json,.scenelith-automation.json" hidden onChange={(event) => void importWorkflow(event.target.files?.[0])} />
        {capabilities.edit && <button type="button" disabled={busy || creatingWorkflow} onClick={() => importInputRef.current?.click()} aria-label="Import workflow JSON" title="Import Scenelith automation JSON"><FileUp size={16} /></button>}
        {capabilities.edit && <button type="button" disabled={busy || creatingWorkflow} onClick={() => void createWorkflow()} aria-label="Create workflow" title="Create workflow"><Plus size={16} /></button>}
        <button type="button" className={selectedAlertCount ? "has-alert" : undefined} disabled={!workflowId} onClick={() => workflowId && onConfigure(workflowId)} aria-label={selectedAlertCount ? `Configure workflow, ${selectedAlertCount} trigger alerts need attention` : "Configure workflow"} title={selectedAlertCount ? `${selectedAlertCount} trigger alert${selectedAlertCount === 1 ? "" : "s"} need attention` : "Configure workflow"}><Settings2 size={16} />{selectedAlertCount > 0 && <i>{Math.min(99, selectedAlertCount)}</i>}</button>
        <button type="button" onClick={onClose} aria-label="Close automation"><X size={16} /></button>
      </div>
    </header>

    <div className="tiktok-automation-form">
      <label><span>Workflow</span><InspectorSelect label="Workflow" value={workflowId} onChange={setWorkflowId} disabled={busy || !workflows.length} options={workflows.map((workflow) => ({
        value: workflow.id,
        label: workflow.name,
        description: workflow.status === "system" ? "System template" : workflow.status === "published" ? "Published custom workflow" : workflow.publishedVersionId ? "Draft changes · runs last published version" : "Draft · publish before running",
      }))} />{workflowError && <small className="tiktok-automation-inline-error" role="alert">{workflowError}</small>}</label>

      <section className="tiktok-automation-runtime-fields">
        <span className="eyebrow">RUN INPUTS</span>
        {!visibleRunInputs.length && <p className="tiktok-automation-empty-inputs">Run-specific values are configured on the workflow nodes.</p>}
        {visibleRunInputs.map((field) => {
          const options = fieldOptions(field);
          const value = runtimeValues[field.key];
          return <label key={`${workflowId}:${field.key}`}><span>{field.label}{!field.required && <em>optional</em>}</span>{field.valueType === "boolean"
            ? <button type="button" className={`tiktok-automation-runtime-toggle ${value ? "is-on" : ""}`} disabled={busy || !capabilities.run} onClick={() => setRuntimeField(field, !value)}><i />{value ? "Enabled" : "Disabled"}</button>
            : field.valueType === "json"
              ? <RuntimeJsonField value={value} disabled={busy || !capabilities.run} onChange={(next) => setRuntimeField(field, next)} />
              : options.length
                ? <InspectorSelect label={field.label} value={String(value ?? "")} onChange={(next) => {
                  setRuntimeField(field, next);
                  if (field.valueType === "tiktok-source") onSourceSelected?.(next);
                }} disabled={busy || !capabilities.run} options={options} />
                : field.fieldKind === "textarea" || field.fieldKind === "prompt"
                  ? <textarea value={String(value ?? "")} disabled={busy || !capabilities.run} onChange={(event) => setRuntimeField(field, event.target.value)} />
                  : <input type={field.valueType === "number" ? "number" : "text"} min={field.min} max={field.max} value={String(value ?? "")} disabled={busy || !capabilities.run} onChange={(event) => setRuntimeField(field, field.valueType === "number" ? Number(event.target.value) : event.target.value)} />}</label>;
        })}
      </section>
    </div>

    {status !== "idle" && <section className={`tiktok-automation-run is-${status}`} aria-live="polite">
      <div className="tiktok-automation-run-head"><span><strong>{status === "complete" ? "Automation complete" : status === "failed" ? "Automation stopped" : "Running workflow"}</strong><small>{stageLabel}</small></span><b>{status === "complete" ? "DONE" : status === "failed" ? "CHECK" : `${Math.floor(visibleProgress)}%`}</b></div>
      <div className={`tiktok-automation-progress ${busy ? "is-active" : ""}`} role="progressbar" aria-label={`${Math.floor(visibleProgress)}% complete`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(visibleProgress)}><i style={{ width: `${visibleProgress}%` }} /></div>
    </section>}

    <footer>
      <p>{!capabilities.run ? "Your workspace role can view this automation but cannot run it" : !runnable ? "Publish this workflow before running it" : selectedSource ? `${selectedSource.assetIds.length} source ${selectedSource.assetIds.length === 1 ? "slide" : "slides"} · exact published version will run` : `${visibleRunInputs.length} run ${visibleRunInputs.length === 1 ? "input" : "inputs"} · exact published version will run`}</p>
      <div className="tiktok-automation-run-control">
        {busy
          ? capabilities.run && <button type="button" className="is-cancel" onClick={onCancel} title="Cancel workflow run">Cancel run</button>
          : capabilities.run && <>{testable && <button type="button" disabled={requiredMissing(draftRunInputs)} onClick={() => onRun(inputsFor(draftRunInputs), "test")} title="Run the current draft without changing the content canvas">Test draft</button>}<button type="button" disabled={!runnable || requiredMissing(productionRunInputs)} onClick={() => onRun(inputsFor(productionRunInputs), "production")} title="Run selected workflow"><Workflow size={15} />Run automation</button></>}
      </div>
    </footer>
  </aside>;
}
