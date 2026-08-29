"use client";

import { AlertTriangle, Check, Clock3, Copy, FlaskConical, GitBranch, Play, Plus, Radio, RotateCcw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { AutomationRunInputField, AutomationWorkflowDetail, AutomationWorkflowVersionSummary } from "@/lib/automation-workflows/types";
import type { AutomationCapabilities } from "@/editions/contracts/access";

type RunSummary = {
  id: string;
  workflowVersionId: string;
  status: "queued" | "running" | "completed" | "completed_with_warnings" | "failed" | "cancelled";
  runKind: "production" | "test" | "replay" | "trigger" | "subworkflow" | "node-preview";
  previewNodeId?: string | null;
  fixtureId?: string | null;
  stageLabel: string;
  progress: number;
  error: string | null;
  code: string | null;
  chargedCredits: number;
  treeChargedCredits: number;
  warningCount: number;
  treeWarningCount: number;
  treeRunCount: number;
  treeNodeExecutions: number;
  treeGeneratedAssets: number;
  reusedNodeCount: number;
  replayOfRunId: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  nodeRuns: Array<{
    id: string;
    nodeId: string;
    nodeType: string;
    attempt: number;
    status: string;
    error: string | null;
    chargedCredits: number;
    outputPorts: string[];
    hasCapturedInput: boolean;
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
    reusedFromNodeRunId: string | null;
    startedAt: string | null;
    completedAt: string | null;
  }>;
  events: Array<{ id: number; type: string; nodeRunId: string | null; payload: Record<string, unknown>; createdAt: string }>;
};
type TriggerSummary = { id: string; type: "schedule" | "webhook" | "canvas-event"; status: "active" | "paused"; name: string; overlapPolicy: "queue" | "skip" | "cancel-previous"; maxConcurrentRuns: number; config: Record<string, unknown>; nextFireAt: string | null; lastFiredAt: string | null };
type DeliverySummary = { id: string; triggerId: string | null; triggerName: string; status: string; attempts: number; maxAttempts: number; runId: string | null; error: string | null; errorCode: string | null; alertOpen: boolean; createdAt: string };
type FixtureSummary = { id: string; name: string; workflowVersionId: string; runtimeInputs: Record<string, unknown>; nodeInputs: Record<string, Record<string, unknown>>; sourceRunId: string | null; updatedAt: string };
type WorkflowNodeOption = { id: string; name: string; type: string; category: string; inputs: Array<{ id: string; label: string; required: boolean }> };

function when(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function statusLabel(status: RunSummary["status"]) {
  if (status === "completed_with_warnings") return "Completed with warnings";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

const operationsViewCopy = {
  runs: {
    eyebrow: "EXECUTION",
    title: "Run history",
    description: "Open a run to see every step, exact route, retry, error and charge.",
  },
  versions: {
    eyebrow: "WORKFLOW HISTORY",
    title: "Versions",
    description: "Review live and auto-saved snapshots or restore an earlier version as a new draft.",
  },
  triggers: {
    eyebrow: "AUTOMATIC STARTS",
    title: "Automatic starts",
    description: "Choose whether a schedule, webhook or Canvas event can start this workflow without clicking Run.",
  },
  fixtures: {
    eyebrow: "SAFE TESTING",
    title: "Test a step",
    description: "Save an input example, then run one selected step without launching the full production workflow.",
  },
} as const;

export function AutomationWorkflowOperations({
  projectId,
  workflowId,
  readOnly,
  capabilities,
  runInputFields,
  workflowNodes,
  initialView,
  onRestored,
  onClose,
}: {
  projectId: string;
  workflowId: string;
  readOnly: boolean;
  capabilities: AutomationCapabilities;
  runInputFields: AutomationRunInputField[];
  initialView: "runs" | "versions" | "triggers" | "fixtures";
  workflowNodes: WorkflowNodeOption[];
  onRestored: (detail: AutomationWorkflowDetail) => void;
  onClose: () => void;
}) {
  const [view, setView] = useState(initialView);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRun, setSelectedRun] = useState<RunSummary | null>(null);
  const [versions, setVersions] = useState<AutomationWorkflowVersionSummary[]>([]);
  const [triggers, setTriggers] = useState<TriggerSummary[]>([]);
  const [deliveries, setDeliveries] = useState<DeliverySummary[]>([]);
  const [fixtures, setFixtures] = useState<FixtureSummary[]>([]);
  const [triggerType, setTriggerType] = useState<TriggerSummary["type"]>("schedule");
  const [triggerName, setTriggerName] = useState("Scheduled run");
  const [triggerValue, setTriggerValue] = useState("tiktok.imported");
  const [triggerCron, setTriggerCron] = useState("0 9 * * 1-5");
  const [triggerTimezone, setTriggerTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [triggerMisfirePolicy, setTriggerMisfirePolicy] = useState<"skip" | "catch-up-once">("catch-up-once");
  const [triggerOverlapPolicy, setTriggerOverlapPolicy] = useState<"queue" | "skip" | "cancel-previous">("queue");
  const [triggerMaxConcurrentRuns, setTriggerMaxConcurrentRuns] = useState(1);
  const previewableNodes = workflowNodes.filter((node) => node.category !== "trigger");
  const [fixtureName, setFixtureName] = useState("Saved example");
  const [fixtureNodeId, setFixtureNodeId] = useState(previewableNodes[0]?.id || "");
  const [fixtureRuntimeInputs, setFixtureRuntimeInputs] = useState("{}");
  const [fixtureNodeInputs, setFixtureNodeInputs] = useState(() => JSON.stringify(Object.fromEntries((previewableNodes[0]?.inputs || []).map((port) => [port.id, null])), null, 2));
  const [previewRun, setPreviewRun] = useState<RunSummary | null>(null);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [triggerInputs, setTriggerInputs] = useState<Record<string, unknown>>(() => Object.fromEntries(runInputFields.map((field) => [field.key, field.value ?? (field.fieldKind === "boolean" ? false : "")])));
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState("");
  const viewCopy = operationsViewCopy[view];

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const loadRuns = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/automation-runs?projectId=${encodeURIComponent(projectId)}&workflowId=${encodeURIComponent(workflowId)}&limit=50`, { cache: "no-store" });
      const body = await response.json() as { runs?: RunSummary[]; error?: string };
      if (!response.ok) throw new Error(body.error || "Could not load run history");
      const runList = body.runs || [];
      setRuns(runList);
      if (runList[0]) {
        const latestResponse = await fetch(`/api/automation-runs/${encodeURIComponent(runList[0].id)}`, { cache: "no-store" });
        const latestBody = await latestResponse.json() as { run?: RunSummary; error?: string };
        if (!latestResponse.ok || !latestBody.run) throw new Error(latestBody.error || "Could not open the latest run");
        setSelectedRun(latestBody.run);
      } else {
        setSelectedRun(null);
      }
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load run history");
    } finally { setLoading(false); }
  }, [projectId, workflowId]);

  const loadVersions = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/automation-workflows/${encodeURIComponent(workflowId)}/versions`, { cache: "no-store" });
      const body = await response.json() as { versions?: AutomationWorkflowVersionSummary[]; error?: string };
      if (!response.ok) throw new Error(body.error || "Could not load version history");
      setVersions(body.versions || []);
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load version history");
    } finally { setLoading(false); }
  }, [workflowId]);

  const loadTriggers = useCallback(async () => {
    setLoading(true);
    try {
      const [response, deliveryResponse] = await Promise.all([
        fetch(`/api/automation-workflows/${encodeURIComponent(workflowId)}/triggers`, { cache: "no-store" }),
        fetch(`/api/automation-trigger-deliveries?projectId=${encodeURIComponent(projectId)}&workflowId=${encodeURIComponent(workflowId)}&limit=50`, { cache: "no-store" }),
      ]);
      const body = await response.json() as { triggers?: TriggerSummary[]; error?: string };
      const deliveryBody = await deliveryResponse.json() as { deliveries?: DeliverySummary[]; error?: string };
      if (!response.ok) throw new Error(body.error || "Could not load triggers");
      if (!deliveryResponse.ok) throw new Error(deliveryBody.error || "Could not load trigger deliveries");
      setTriggers(body.triggers || []); setDeliveries(deliveryBody.deliveries || []); setError("");
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : "Could not load triggers"); }
    finally { setLoading(false); }
  }, [projectId, workflowId]);

  const loadFixtures = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/automation-workflows/${encodeURIComponent(workflowId)}/fixtures`, { cache: "no-store" });
      const body = await response.json() as { fixtures?: FixtureSummary[]; error?: string };
      if (!response.ok) throw new Error(body.error || "Could not load fixtures");
      setFixtures(body.fixtures || []); setError("");
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : "Could not load fixtures"); }
    finally { setLoading(false); }
  }, [workflowId]);

  useEffect(() => {
    const load = view === "runs" ? loadRuns : view === "versions" ? loadVersions : view === "triggers" ? loadTriggers : loadFixtures;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [loadFixtures, loadRuns, loadTriggers, loadVersions, view]);

  async function createTrigger() {
    setBusyId("create-trigger"); setWebhookUrl("");
    try {
      const config = triggerType === "schedule"
        ? { mode: "calendar", cron: triggerCron, timezone: triggerTimezone, misfirePolicy: triggerMisfirePolicy }
        : triggerType === "canvas-event" ? { event: triggerValue || "tiktok.imported", version: 1 } : {};
      const response = await fetch(`/api/automation-workflows/${encodeURIComponent(workflowId)}/triggers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, type: triggerType, name: triggerName, overlapPolicy: triggerOverlapPolicy, maxConcurrentRuns: triggerMaxConcurrentRuns, config, inputs: triggerInputs }) });
      const body = await response.json() as { trigger?: TriggerSummary; token?: string; error?: string };
      if (!response.ok || !body.trigger) throw new Error(body.error || "Could not create trigger");
      if (body.token) setWebhookUrl(`${window.location.origin}/api/automation-webhooks/${body.trigger.id}/${body.token}`);
      await loadTriggers();
    } catch (createError) { setError(createError instanceof Error ? createError.message : "Could not create trigger"); }
    finally { setBusyId(""); }
  }

  async function toggleTrigger(trigger: TriggerSummary) {
    setBusyId(trigger.id);
    try {
      const response = await fetch(`/api/automation-triggers/${encodeURIComponent(trigger.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: trigger.status === "active" ? "paused" : "active" }) });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not update trigger");
      await loadTriggers();
    } catch (toggleError) { setError(toggleError instanceof Error ? toggleError.message : "Could not update trigger"); }
    finally { setBusyId(""); }
  }

  async function deleteTrigger(trigger: TriggerSummary) {
    setBusyId(trigger.id);
    try {
      const response = await fetch(`/api/automation-triggers/${encodeURIComponent(trigger.id)}`, { method: "DELETE" });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not delete trigger");
      setConfirmDeleteId("");
      await loadTriggers();
    } catch (deleteError) { setError(deleteError instanceof Error ? deleteError.message : "Could not delete trigger"); }
    finally { setBusyId(""); }
  }

  async function replayDelivery(delivery: DeliverySummary) {
    setBusyId(delivery.id);
    try {
      const response = await fetch(`/api/automation-trigger-deliveries/${encodeURIComponent(delivery.id)}/replay`, { method: "POST" });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not replay this delivery");
      await loadTriggers();
    } catch (replayError) { setError(replayError instanceof Error ? replayError.message : "Could not replay this delivery"); }
    finally { setBusyId(""); }
  }

  async function createFixture() {
    setBusyId("create-fixture");
    try {
      const runtimeInputs = JSON.parse(fixtureRuntimeInputs) as unknown;
      const nodeInput = JSON.parse(fixtureNodeInputs) as unknown;
      if (!runtimeInputs || typeof runtimeInputs !== "object" || Array.isArray(runtimeInputs)) throw new Error("Runtime values must be a JSON object");
      if (!nodeInput || typeof nodeInput !== "object" || Array.isArray(nodeInput)) throw new Error("Port input must be a JSON object");
      if (!fixtureNodeId) throw new Error("Choose a step for this example");
      const response = await fetch(`/api/automation-workflows/${encodeURIComponent(workflowId)}/fixtures`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: fixtureName, runtimeInputs, nodeInputs: { [fixtureNodeId]: nodeInput } }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not save fixture");
      await loadFixtures();
    } catch (fixtureError) { setError(fixtureError instanceof Error ? fixtureError.message : "Could not save fixture"); }
    finally { setBusyId(""); }
  }

  async function captureRunNodeFixture(run: RunSummary, nodeRun: RunSummary["nodeRuns"][number]) {
    setBusyId(`capture:${nodeRun.id}`);
    try {
      const response = await fetch(`/api/automation-workflows/${encodeURIComponent(workflowId)}/fixtures`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: `${nodeRun.nodeId} · ${when(run.createdAt)}`,
          runtimeInputs: {},
          nodeInputs: {},
          sourceRunId: run.id,
          sourceNodeId: nodeRun.nodeId,
        }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not capture this step");
      setView("fixtures");
      await loadFixtures();
    } catch (captureError) { setError(captureError instanceof Error ? captureError.message : "Could not capture this step"); }
    finally { setBusyId(""); }
  }

  async function deleteFixture(fixture: FixtureSummary) {
    setBusyId(fixture.id);
    try {
      const response = await fetch(`/api/automation-workflows/${encodeURIComponent(workflowId)}/fixtures/${encodeURIComponent(fixture.id)}`, { method: "DELETE" });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not delete fixture");
      if (previewRun?.fixtureId === fixture.id) setPreviewRun(null);
      setConfirmDeleteId("");
      await loadFixtures();
    } catch (fixtureError) { setError(fixtureError instanceof Error ? fixtureError.message : "Could not delete fixture"); }
    finally { setBusyId(""); }
  }

  async function previewFixture(fixture: FixtureSummary, nodeId: string) {
    setBusyId(`preview:${fixture.id}`);
    setPreviewRun(null);
    try {
      const response = await fetch(`/api/automation-workflows/${encodeURIComponent(workflowId)}/preview`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fixtureId: fixture.id, nodeId }),
      });
      const body = await response.json() as { runId?: string; error?: string };
      if (!response.ok || !body.runId) throw new Error(body.error || "Could not start step preview");
      for (let attempt = 0; attempt < 180; attempt += 1) {
        const runResponse = await fetch(`/api/automation-runs/${encodeURIComponent(body.runId)}`, { cache: "no-store" });
        const runBody = await runResponse.json() as { run?: RunSummary; error?: string };
        if (!runResponse.ok || !runBody.run) throw new Error(runBody.error || "Could not inspect step preview");
        setPreviewRun(runBody.run);
        if (["completed", "completed_with_warnings", "failed", "cancelled"].includes(runBody.run.status)) break;
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      }
    } catch (previewError) { setError(previewError instanceof Error ? previewError.message : "Could not preview this step"); }
    finally { setBusyId(""); }
  }

  async function inspectRun(runId: string) {
    setBusyId(runId);
    try {
      const response = await fetch(`/api/automation-runs/${encodeURIComponent(runId)}`, { cache: "no-store" });
      const body = await response.json() as { run?: RunSummary; error?: string };
      if (!response.ok || !body.run) throw new Error(body.error || "Could not inspect this run");
      setSelectedRun(body.run);
      setError("");
    } catch (inspectError) {
      setError(inspectError instanceof Error ? inspectError.message : "Could not inspect this run");
    } finally { setBusyId(""); }
  }

  async function retryRun(runId: string, nodeId: string) {
    setBusyId(`${runId}:${nodeId}`);
    try {
      const response = await fetch(`/api/automation-runs/${encodeURIComponent(runId)}/retry`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nodeId }),
      });
      const body = await response.json() as { runId?: string; error?: string };
      if (!response.ok || !body.runId) throw new Error(body.error || "Could not retry this run");
      await loadRuns();
      await inspectRun(body.runId);
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : "Could not retry this run");
    } finally { setBusyId(""); }
  }

  async function restoreVersion(versionId: string) {
    setBusyId(versionId);
    try {
      const response = await fetch(`/api/automation-workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(versionId)}/restore`, { method: "POST" });
      const body = await response.json() as AutomationWorkflowDetail & { error?: string };
      if (!response.ok || !body.workflow) throw new Error(body.error || "Could not restore this version");
      onRestored(body);
      onClose();
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : "Could not restore this version");
    } finally { setBusyId(""); }
  }

  return <div className="automation-operations-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="automation-operations" role="dialog" aria-modal="true" aria-label="Workflow operations">
      <header>
        <div><small>{viewCopy.eyebrow}</small><h2>{viewCopy.title}</h2><p>{viewCopy.description}</p></div>
        <nav aria-label="Workflow management sections"><button type="button" className={view === "runs" ? "is-active" : ""} onClick={() => { setView("runs"); setSelectedRun(null); }}>Runs</button>{(capabilities.edit || capabilities.publish) && <button type="button" className={view === "versions" ? "is-active" : ""} onClick={() => { setView("versions"); setSelectedRun(null); }}>Versions</button>}{capabilities.manageTriggers && <button type="button" className={view === "triggers" ? "is-active" : ""} onClick={() => { setView("triggers"); setSelectedRun(null); }}>Automatic starts</button>}{(capabilities.run || capabilities.edit) && <button type="button" className={view === "fixtures" ? "is-active" : ""} onClick={() => { setView("fixtures"); setSelectedRun(null); }}>Test a step</button>}</nav>
        <button type="button" className="automation-operations-close" onClick={onClose} aria-label="Close operations"><X size={16} /></button>
      </header>
      {error && <div className="automation-operations-error" role="alert"><AlertTriangle size={14} />{error}</div>}
      <div className="automation-operations-body">
        {loading ? <div className="automation-operations-loading" aria-live="polite"><i />Loading…</div> : view === "runs" ? <>
          <div className="automation-operations-list">
            {!runs.length && <p className="automation-operations-empty">No runs yet. Test the auto-saved draft or run the live version.</p>}
            {runs.map((run) => <button type="button" key={run.id} className={selectedRun?.id === run.id ? "is-selected" : ""} onClick={() => void inspectRun(run.id)}>
              <span className={`is-${run.status}`}>{run.status === "completed" ? <Check size={13} /> : run.status === "failed" ? <AlertTriangle size={13} /> : <Clock3 size={13} />}</span>
              <i><b>{statusLabel(run.status)}</b><small>{run.runKind} · {when(run.createdAt)}</small></i>
              <em>{run.chargedCredits} units</em>
            </button>)}
          </div>
          <div className="automation-run-inspector">
            {!selectedRun ? <div className="automation-operations-empty"><GitBranch size={22} /><p>{runs.length ? "Opening the latest run…" : "Run this workflow once to inspect every step, chosen branch, retry and charge here."}</p></div> : <>
              <div className="automation-run-summary"><span><small>STATUS</small><b>{statusLabel(selectedRun.status)}</b></span><span><small>STARTED</small><b>{when(selectedRun.startedAt || selectedRun.createdAt)}</b></span><span><small>TOTAL USAGE</small><b>{selectedRun.treeChargedCredits} units</b></span><span><small>EXECUTION TREE</small><b>{selectedRun.treeRunCount} run{selectedRun.treeRunCount === 1 ? "" : "s"} · {selectedRun.treeNodeExecutions} steps · {selectedRun.treeGeneratedAssets} assets</b></span></div>
              {selectedRun.error && <div className="automation-run-error"><b>{selectedRun.code || "RUN_FAILED"}</b><p>{selectedRun.error}</p></div>}
              {selectedRun.replayOfRunId && <div className="automation-run-error"><b>EXPLICIT REPLAY</b><p>This run restarts from a chosen step in run {selectedRun.replayOfRunId.slice(0, 8)} and reuses {selectedRun.reusedNodeCount} completed upstream step{selectedRun.reusedNodeCount === 1 ? "" : "s"} exactly.</p></div>}
              <div className="automation-run-timeline">{selectedRun.nodeRuns.map((nodeRun) => <article key={nodeRun.id} className={`is-${nodeRun.status}`}>
                <span>{nodeRun.reusedFromNodeRunId ? <RotateCcw size={12} /> : nodeRun.status === "completed" ? <Check size={12} /> : nodeRun.status === "failed" ? <AlertTriangle size={12} /> : <Clock3 size={12} />}</span>
                <div><small>{nodeRun.nodeType} · attempt {nodeRun.attempt}</small><b>{nodeRun.nodeId}</b>{nodeRun.reusedFromNodeRunId && <p>Reused exact output from node run {nodeRun.reusedFromNodeRunId.slice(0, 8)}</p>}{nodeRun.outputPorts.length > 0 && <p>Path: {nodeRun.outputPorts.join(" · ")}</p>}{nodeRun.error && <p className="is-error">{nodeRun.error}</p>}</div>
                {capabilities.edit && nodeRun.hasCapturedInput && <button type="button" disabled={Boolean(busyId)} onClick={() => void captureRunNodeFixture(selectedRun, nodeRun)}><FlaskConical size={12} /> Save fixture</button>}
                {capabilities.run && (selectedRun.status === "failed" || selectedRun.status === "completed_with_warnings") && <button type="button" disabled={Boolean(busyId)} onClick={() => void retryRun(selectedRun.id, nodeRun.nodeId)}><RotateCcw size={12} /> Retry from here</button>}
              </article>)}</div>
            </>}
          </div>
        </> : view === "versions" ? <div className="automation-version-list">
          {!versions.length && <p className="automation-operations-empty">No saved versions yet.</p>}
          {versions.map((version) => <article key={version.id}>
            <span className={`is-${version.status}`}>v{version.version}</span>
            <div><b>{version.status === "published" ? "Live version" : version.status === "draft" ? "Current auto-saved draft" : "Previous version"}</b><small>{when(version.publishedAt || version.createdAt)}{version.changeNote ? ` · ${version.changeNote}` : ""}</small><p>{version.validation.valid ? "Valid workflow" : `${version.validation.issues.length} validation issues`}</p></div>
            {capabilities.edit && !readOnly && version.status !== "draft" && <button type="button" disabled={Boolean(busyId)} onClick={() => void restoreVersion(version.id)}><RotateCcw size={13} /> Restore as draft</button>}
          </article>)}
        </div> : view === "triggers" ? <div className="automation-trigger-manager">
          {capabilities.manageTriggers && !readOnly && <section><small>NEW TRIGGER</small><div>
            <label><span>Start workflow with</span><select value={triggerType} onChange={(event) => { const type = event.target.value as TriggerSummary["type"]; setTriggerType(type); setTriggerName(type === "schedule" ? "Scheduled run" : type === "webhook" ? "Incoming webhook" : "Canvas event"); setTriggerValue("tiktok.imported"); }}><option value="schedule">Calendar schedule</option><option value="webhook">Webhook</option><option value="canvas-event">Canvas event</option></select></label>
            <label><span>Name</span><input value={triggerName} onChange={(event) => setTriggerName(event.target.value)} placeholder="Weekday content run…" /></label>
            {triggerType === "schedule" && <><label><span>CRON · MIN HOUR DAY MONTH WEEKDAY</span><input value={triggerCron} onChange={(event) => setTriggerCron(event.target.value)} placeholder="0 9 * * 1-5" /></label><label><span>TIMEZONE</span><input value={triggerTimezone} onChange={(event) => setTriggerTimezone(event.target.value)} placeholder="America/New_York" /></label><label><span>MISSED RUN</span><select value={triggerMisfirePolicy} onChange={(event) => setTriggerMisfirePolicy(event.target.value as "skip" | "catch-up-once")}><option value="catch-up-once">Run once after recovery</option><option value="skip">Skip missed occurrence</option></select></label></>}
            {triggerType === "canvas-event" && <label><span>Canvas event</span><select value={triggerValue} onChange={(event) => setTriggerValue(event.target.value)}><option value="tiktok.imported">TikTok imported</option><option value="generation.completed">Canvas generation completed</option></select></label>}
            {runInputFields.length > 0 && <details className="automation-progressive"><summary>Run inputs <i>{runInputFields.length}</i></summary><div>{runInputFields.map((field) => <label key={field.key}><span>{field.label}{field.required ? " *" : ""}</span>{field.fieldKind === "boolean" ? <input type="checkbox" checked={Boolean(triggerInputs[field.key])} onChange={(event) => setTriggerInputs((current) => ({ ...current, [field.key]: event.target.checked }))} /> : field.options?.length ? <select value={String(triggerInputs[field.key] ?? "")} onChange={(event) => setTriggerInputs((current) => ({ ...current, [field.key]: event.target.value }))}>{!field.required && <option value="">None</option>}{field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <input type={field.fieldKind === "number" ? "number" : "text"} value={String(triggerInputs[field.key] ?? "")} onChange={(event) => setTriggerInputs((current) => ({ ...current, [field.key]: field.fieldKind === "number" ? Number(event.target.value) : event.target.value }))} />}</label>)}</div></details>}
            <details className="automation-progressive"><summary>Advanced run behavior</summary><div><label><span>IF ANOTHER RUN IS ACTIVE</span><select value={triggerOverlapPolicy} onChange={(event) => setTriggerOverlapPolicy(event.target.value as "queue" | "skip" | "cancel-previous")}><option value="queue">Queue this run</option><option value="skip">Skip this occurrence</option><option value="cancel-previous">Cancel previous run</option></select></label><label><span>MAX PARALLEL RUNS</span><input type="number" min={1} max={32} value={triggerMaxConcurrentRuns} onChange={(event) => setTriggerMaxConcurrentRuns(Math.min(32, Math.max(1, Number(event.target.value) || 1)))} /></label></div></details>
            <button type="button" disabled={Boolean(busyId)} onClick={() => void createTrigger()}><Plus size={12} /> Add paused</button>
          </div>{webhookUrl && <p><b>Copy this URL now. It is shown once:</b><code>{webhookUrl}</code><button type="button" onClick={() => void navigator.clipboard.writeText(webhookUrl)}><Copy size={12} /> Copy URL</button></p>}</section>}
          <div>{!triggers.length && <p className="automation-operations-empty">No triggers. Manual runs remain available.</p>}{triggers.map((trigger) => <article key={trigger.id}><span className={`is-${trigger.status}`}><Radio size={13} /></span><div><b>{trigger.name}</b><small>{trigger.type} · {trigger.status} · {trigger.overlapPolicy} · max {trigger.maxConcurrentRuns}{trigger.config.mode === "calendar" ? ` · ${String(trigger.config.cron)} · ${String(trigger.config.timezone)}` : ""}{trigger.nextFireAt ? ` · next ${when(trigger.nextFireAt)}` : ""}</small></div>{capabilities.manageTriggers && <button type="button" disabled={Boolean(busyId)} onClick={() => void toggleTrigger(trigger)}>{trigger.status === "active" ? "Pause" : "Activate"}</button>}{capabilities.manageTriggers && (confirmDeleteId === `trigger:${trigger.id}` ? <span className="automation-inline-confirm"><button type="button" onClick={() => setConfirmDeleteId("")}>Keep</button><button type="button" className="is-danger" disabled={Boolean(busyId)} onClick={() => void deleteTrigger(trigger)}>Delete</button></span> : <button type="button" aria-label={`Delete ${trigger.name}`} disabled={Boolean(busyId)} onClick={() => setConfirmDeleteId(`trigger:${trigger.id}`)}><Trash2 size={13} /></button>)}</article>)}</div>
          <section><small>DELIVERY HISTORY · RETRY + DLQ</small><div>{!deliveries.length && <p className="automation-operations-empty">No trigger deliveries yet.</p>}{deliveries.map((delivery) => <article key={delivery.id} className={delivery.alertOpen ? "has-open-alert" : undefined}><span className={`is-${delivery.status}`}>{delivery.alertOpen ? <AlertTriangle size={13} /> : <Radio size={13} />}</span><div><b>{delivery.triggerName}{delivery.alertOpen ? " · Needs attention" : ""}</b><small>{delivery.status.replace("_", " ")} · attempt {delivery.attempts}/{delivery.maxAttempts} · {when(delivery.createdAt)}</small>{delivery.error && <p className="is-error">{delivery.errorCode}: {delivery.error}</p>}</div>{delivery.runId && <button type="button" onClick={() => { setView("runs"); void inspectRun(delivery.runId!); }}>Open run</button>}{capabilities.manageTriggers && delivery.status === "dead_letter" && <button type="button" disabled={Boolean(busyId)} onClick={() => void replayDelivery(delivery)}><RotateCcw size={12} /> Replay</button>}</article>)}</div></section>
        </div> : <div className="automation-fixture-manager">
          {capabilities.edit && !readOnly && <section><small>SAVED EXAMPLE</small><p>Test one step with known data without running the full workflow.</p><div>
            <label><span>Name</span><input value={fixtureName} onChange={(event) => setFixtureName(event.target.value)} placeholder="Saved identity import example…" /></label>
            <label><span>Step to preview</span><select value={fixtureNodeId} onChange={(event) => { const nodeId = event.target.value; setFixtureNodeId(nodeId); const node = previewableNodes.find((candidate) => candidate.id === nodeId); setFixtureNodeInputs(JSON.stringify(Object.fromEntries((node?.inputs || []).map((port) => [port.id, null])), null, 2)); }}>{previewableNodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}</select></label>
            <details className="automation-progressive"><summary>Advanced input data</summary><div><label><span>RUNTIME VALUES JSON</span><textarea value={fixtureRuntimeInputs} onChange={(event) => setFixtureRuntimeInputs(event.target.value)} spellCheck={false} /></label><label><span>INPUT PORTS JSON</span><textarea value={fixtureNodeInputs} onChange={(event) => setFixtureNodeInputs(event.target.value)} spellCheck={false} /></label></div></details>
            <button type="button" disabled={Boolean(busyId) || !fixtureNodeId} onClick={() => void createFixture()}><Plus size={12} /> Save fixture</button>
          </div></section>}
          <div>{!fixtures.length && <p className="automation-operations-empty">No fixtures yet. Save one example to inspect a step in isolation.</p>}{fixtures.map((fixture) => {
            const availableNodeIds = previewableNodes.filter((node) => fixture.nodeInputs[node.id] !== undefined);
            const nodeId = availableNodeIds[0]?.id || "";
            return <article key={fixture.id}><span><FlaskConical size={13} /></span><div><b>{fixture.name}</b><small>{Object.keys(fixture.nodeInputs).length} captured step{Object.keys(fixture.nodeInputs).length === 1 ? "" : "s"} · {when(fixture.updatedAt)}</small></div>{capabilities.run && <button type="button" disabled={Boolean(busyId) || !nodeId} onClick={() => void previewFixture(fixture, nodeId)}><Play size={12} /> Preview step</button>}{capabilities.edit && (confirmDeleteId === `fixture:${fixture.id}` ? <span className="automation-inline-confirm"><button type="button" onClick={() => setConfirmDeleteId("")}>Keep</button><button type="button" className="is-danger" disabled={Boolean(busyId)} onClick={() => void deleteFixture(fixture)}>Delete</button></span> : <button type="button" aria-label={`Delete ${fixture.name}`} disabled={Boolean(busyId)} onClick={() => setConfirmDeleteId(`fixture:${fixture.id}`)}><Trash2 size={13} /></button>)}</article>;
          })}</div>
          {previewRun && <section className="automation-preview-result"><small>PORT DATA · {previewRun.status}</small>{previewRun.error && <div className="automation-run-error"><b>{previewRun.code || "PREVIEW_FAILED"}</b><p>{previewRun.error}</p></div>}{previewRun.nodeRuns.map((nodeRun) => <article key={nodeRun.id}><div><b>{nodeRun.nodeId}</b><small>INPUT</small><pre>{JSON.stringify(nodeRun.input ?? {}, null, 2)}</pre><small>OUTPUT</small><pre>{JSON.stringify(nodeRun.output ?? {}, null, 2)}</pre></div></article>)}</section>}
        </div>}
      </div>
    </section>
  </div>;
}
