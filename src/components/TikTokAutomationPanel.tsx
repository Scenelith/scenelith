"use client";

import { ArrowRight, Check, RotateCcw, Settings2, Square, Workflow, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { generatorRatiosFor, generatorResolutionsFor, type GeneratorModelOption } from "@/components/FrameNode";
import { InspectorSelect } from "@/components/InspectorSelect";
import { AutomationReferencePicker, type AutomationReferenceCandidate } from "@/components/automation/AutomationReferencePicker";
import { assistantModels } from "@/lib/assistant-models";
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
export type AutomationChoiceConfirmation = {
  runId: string;
  mode: "production" | "test";
  changes: Array<{
    field: string;
    runtimeInputKey: string;
    label: string;
    selectedLabel: string;
    requestedLabel: string;
    requestedValue: unknown;
    evidence: string[];
  }>;
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
  workspaceId,
  canvasReferences = [],
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
  execution,
  onRun,
  onCancel,
  onResume,
  onClose,
  onSourceSelected,
  onRuntimeValuesChange,
  confirmation,
  onConfirmChanges,
  onDismissConfirmation,
}: {
  workspaceId?: string;
  canvasReferences?: AutomationReferenceCandidate[];
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
  execution?: {
    runId: string | null;
    status: "queued" | "running" | "completed" | "completed_with_warnings" | "failed" | "cancelled";
    nodeRuns: Array<{ nodeId: string; status: string; errorCode?: string | null }>;
  } | null;
  onRun: (runtimeInputs: Record<string, unknown>, mode: "production" | "test") => void;
  onCancel: () => void;
  onResume?: (runId: string, nodeId: string) => void;
  onClose: () => void;
  onSourceSelected?: (sourceId: string) => void;
  onRuntimeValuesChange?: (workflowId: string, values: Record<string, unknown>) => void;
  confirmation?: AutomationChoiceConfirmation | null;
  onConfirmChanges?: (runtimeInputs: Record<string, unknown>, mode: "production" | "test") => void;
  onDismissConfirmation?: () => void;
}) {
  const initialDemoInputs = demo ? (demo.productionRunInputs.length ? demo.productionRunInputs : demo.draftRunInputs || []) : [];
  const [workflows, setWorkflows] = useState<AutomationWorkflowRecord[]>(() => demo?.workflows || []);
  const [capabilities, setCapabilities] = useState<AutomationCapabilities>(() => demo?.capabilities || { run: false, edit: false, publish: false, manageTriggers: false, manageCredentials: false });
  const [openTriggerAlerts, setOpenTriggerAlerts] = useState<Record<string, number>>(() => demo?.openTriggerAlerts || {});
  const [workflowError, setWorkflowError] = useState("");
  const [cancelArmed, setCancelArmed] = useState(false);
  const [runInputs, setRunInputs] = useState<AutomationRunInputField[]>(() => initialDemoInputs);
  const [productionRunInputs, setProductionRunInputs] = useState<AutomationRunInputField[]>(() => demo?.productionRunInputs || []);
  const [runtimeValuesByWorkflow, setRuntimeValuesByWorkflow] = useState<Record<string, Record<string, unknown>>>(() => demo ? { [demo.detail.workflow.id]: demo.runtimeValues || {} } : {});
  const workflowIdRef = useRef(workflowId);
  const setWorkflowIdRef = useRef(setWorkflowId);
  const busy = status === "planning" || status === "building" || status === "generating";
  const stoppedNodeRun = [...(execution?.nodeRuns || [])].reverse().find((nodeRun) => nodeRun.status === "failed");
  const canResume = Boolean(
    capabilities.run
    && onResume
    && execution?.runId
    && (execution.status === "failed" || execution.status === "cancelled")
    && stoppedNodeRun,
  );
  const selectedWorkflow = workflows.find((workflow) => workflow.id === workflowId);
  const visibleWorkflows = useMemo(() => workflows.filter((workflow) => workflow.status !== "archived"), [workflows]);
  const selectedAlertCount = openTriggerAlerts[workflowId] || 0;
  const runtimeValues = useMemo(() => runtimeValuesByWorkflow[workflowId] || {}, [runtimeValuesByWorkflow, workflowId]);
  const runInputVisible = useCallback((field: AutomationRunInputField) => !field.visibleWhen || field.visibleWhen.values.some((value) => Object.is(value, runtimeValues[field.visibleWhen!.key] ?? field.visibleWhen!.value)), [runtimeValues]);
  const visibleRunInputs = useMemo(() => runInputs.filter(runInputVisible), [runInputVisible, runInputs]);
  const visibleProductionRunInputs = useMemo(() => productionRunInputs.filter(runInputVisible), [productionRunInputs, runInputVisible]);
  const runtimeValuesChangeRef = useRef(onRuntimeValuesChange);
  useEffect(() => { runtimeValuesChangeRef.current = onRuntimeValuesChange; }, [onRuntimeValuesChange]);
  useEffect(() => { runtimeValuesChangeRef.current?.(workflowId, runtimeValues); }, [runtimeValues, workflowId]);

  useEffect(() => { workflowIdRef.current = workflowId; }, [workflowId]);
  useEffect(() => { setWorkflowIdRef.current = setWorkflowId; }, [setWorkflowId]);

  useEffect(() => {
    if (!cancelArmed) return;
    const timer = window.setTimeout(() => setCancelArmed(false), 5_000);
    return () => window.clearTimeout(timer);
  }, [cancelArmed]);

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
        const fields = publishedFields.length ? publishedFields : draftFields;
        setProductionRunInputs(publishedFields);
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
            else if (field.valueType === "assistant-model") next[field.key] = assistantModels[0]?.id || "";
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
  const requiredMissing = (fields: AutomationRunInputField[]) => fields.some((field) => (field.required || field.requiredWhenVisible) && emptyRuntimeValue(runtimeValues[field.key]));
  const inputsFor = (fields: AutomationRunInputField[]) => Object.fromEntries(fields.map((field) => [field.key, runtimeValues[field.key]]));
  const confirmChanges = () => {
    if (!confirmation || !onConfirmChanges) return;
    const updates = Object.fromEntries(confirmation.changes.map((change) => [change.runtimeInputKey, change.requestedValue]));
    const nextValues = { ...runtimeValues, ...updates };
    setRuntimeValuesByWorkflow((current) => ({ ...current, [workflowId]: nextValues }));
    runtimeValuesChangeRef.current?.(workflowId, nextValues);
    onConfirmChanges(nextValues, confirmation.mode);
  };
  const runnable = Boolean(selectedWorkflow?.publishedVersionId || selectedWorkflow?.status === "system");
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
    if (field.valueType === "assistant-model") return assistantModels.map((model) => ({ value: model.id, label: model.label }));
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

  return <aside className="tiktok-automation-panel" onPointerDown={(event) => event.stopPropagation()}>
    <header className="tiktok-automation-head">
      <div><span className="eyebrow">AUTOMATION</span><h2>{selectedWorkflow?.name || "Choose a workflow"}</h2><p>{selectedWorkflow?.description || "Select, configure and run a workflow."}</p></div>
      <div className="tiktok-automation-head-actions">
        <button type="button" className={selectedAlertCount ? "has-alert" : undefined} disabled={!workflowId} onClick={() => workflowId && onConfigure(workflowId)} aria-label={selectedAlertCount ? `Configure workflow, ${selectedAlertCount} trigger alerts need attention` : "Configure workflow"} title={selectedAlertCount ? `${selectedAlertCount} trigger alert${selectedAlertCount === 1 ? "" : "s"} need attention` : "Configure workflow"}><Settings2 size={16} />{selectedAlertCount > 0 && <i>{Math.min(99, selectedAlertCount)}</i>}</button>
        <button type="button" onClick={onClose} aria-label="Close automation"><X size={16} /></button>
      </div>
    </header>

    <div className="tiktok-automation-form">
      <label><span>Workflow</span><InspectorSelect label="Workflow" value={workflowId} onChange={setWorkflowId} disabled={busy || !visibleWorkflows.length} showSelectedIcon={false} variant="workflow" options={visibleWorkflows.map((workflow) => ({
        value: workflow.id,
        label: workflow.name,
        description: workflow.status === "system" ? "Default workflow" : "Saved automatically",
      }))} />{workflowError && <small className="tiktok-automation-inline-error" role="alert">{workflowError}</small>}</label>

      <section className="tiktok-automation-runtime-fields">
        <span className="eyebrow">RUN INPUTS</span>
        {!visibleRunInputs.length && <div className="tiktok-automation-empty-inputs">
          <Settings2 size={15} />
          <span><strong>No run inputs yet</strong><p>Add an input node, or select any configurable step and choose <b>Add to run inputs</b> beside the value you want to set before each run.</p></span>
        </div>}
        {visibleRunInputs.map((field) => {
          const options = fieldOptions(field);
          const value = runtimeValues[field.key];
          return <label key={`${workflowId}:${field.key}`}><span>{field.label}{!field.required && !field.requiredWhenVisible && <em>optional</em>}</span>{field.valueType === "visual-references" && workspaceId
            ? <AutomationReferencePicker workspaceId={workspaceId} projectId={projectId} canvasReferences={canvasReferences || []} personas={personas} selectedIds={Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []} maxItems={field.selectionLimit || field.max || 8} disabled={busy || !capabilities.run} placement="run-panel" onChange={(assetIds) => setRuntimeField(field, assetIds)} />
            : field.valueType === "boolean"
            ? <InspectorSelect label={field.label} value={value ? "true" : "false"} disabled={busy || !capabilities.run} options={[{ value: "true", label: "Enabled" }, { value: "false", label: "Disabled" }]} onChange={(next) => setRuntimeField(field, next === "true")} />
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
      <div className="tiktok-automation-run-head"><span><strong>{status === "complete" ? "Automation complete" : status === "failed" ? execution?.status === "cancelled" ? "Automation cancelled" : "Automation stopped" : "Running workflow"}</strong><small>{status === "failed" && execution?.status === "cancelled" ? "Stopped by request · completed steps are saved" : stageLabel}</small></span><b>{status === "complete" ? "DONE" : status === "failed" ? execution?.status === "cancelled" ? "CANCELLED" : "CHECK" : `${Math.floor(visibleProgress)}%`}</b></div>
      <div className={`tiktok-automation-progress ${busy ? "is-active" : ""}`} role="progressbar" aria-label={`${Math.floor(visibleProgress)}% complete`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(visibleProgress)}><i style={{ width: `${visibleProgress}%` }} /></div>
    </section>}

    {confirmation && <section className="automation-choice-confirmation" aria-label="Confirm proposed creative changes">
      <header><span><small>CONFIRM CHANGES</small><strong>The written direction changes {confirmation.changes.length === 1 ? "one choice" : `${confirmation.changes.length} choices`}</strong></span><button type="button" aria-label="Dismiss proposed changes" onClick={onDismissConfirmation}><X size={14} /></button></header>
      <div>{confirmation.changes.map((change) => <article key={`${change.runtimeInputKey}:${change.requestedLabel}`}>
        <b>{change.label}</b>
        <p><span>{change.selectedLabel}</span><ArrowRight size={13} /><strong>{change.requestedLabel}</strong></p>
        {change.evidence.length > 0 && <blockquote>“{change.evidence.join(" · ")}”</blockquote>}
      </article>)}</div>
      <footer><span>Only these visible choices will change. All other run inputs stay the same.</span><button type="button" onClick={confirmChanges}><Check size={14} />Confirm and run again</button></footer>
    </section>}

    <footer>
      <p>{!capabilities.run ? "Your workspace role can view this automation but cannot run it" : !runnable ? "Finish the required workflow setup before running" : selectedSource ? `${selectedSource.assetIds.length} source ${selectedSource.assetIds.length === 1 ? "slide" : "slides"} · ready to run` : `${visibleRunInputs.length} run ${visibleRunInputs.length === 1 ? "input" : "inputs"} · ready to run`}</p>
      <div className="tiktok-automation-run-control">
        {busy
          ? capabilities.run && <button key="stop-run" type="button" className={`is-cancel ${cancelArmed ? "is-armed" : ""}`} onClick={(event) => {
            event.currentTarget.blur();
            if (!cancelArmed) {
              setCancelArmed(true);
              return;
            }
            setCancelArmed(false);
            onCancel();
          }} title={cancelArmed ? "Confirm stopping this workflow run" : "Stop workflow run"}><Square size={13} />{cancelArmed ? "Confirm stop" : "Stop run"}</button>
          : canResume && execution?.runId && stoppedNodeRun
            ? <><button key="resume-run" type="button" className="is-resume" onClick={(event) => {
              event.currentTarget.blur();
              onResume?.(execution.runId!, stoppedNodeRun.nodeId);
            }} title="Reuse completed steps and continue from the stopped step"><RotateCcw size={14} />Resume from stopped step</button><button key="start-over" type="button" className="is-start-over" disabled={!runnable || requiredMissing(visibleProductionRunInputs)} onClick={(event) => {
              event.currentTarget.blur();
              onRun(inputsFor(visibleProductionRunInputs), "production");
            }} title="Discard this route and start a completely new run"><Workflow size={14} />Start over</button></>
            : capabilities.run && <button key="run-new" type="button" disabled={!runnable || requiredMissing(visibleProductionRunInputs)} onClick={(event) => {
              event.currentTarget.blur();
              onRun(inputsFor(visibleProductionRunInputs), "production");
            }} title="Run selected workflow"><Workflow size={15} />Run automation</button>}
      </div>
    </footer>
  </aside>;
}
