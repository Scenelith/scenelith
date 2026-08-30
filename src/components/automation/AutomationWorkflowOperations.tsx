"use client";

import { AlertTriangle, Check, Clock3, GitBranch, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AutomationCapabilities } from "@/editions/contracts/access";

type RunSummary = {
  id: string;
  workflowVersionId: string;
  status: "queued" | "running" | "completed" | "completed_with_warnings" | "failed" | "cancelled";
  runKind: "production" | "test" | "replay" | "trigger" | "subworkflow" | "node-preview";
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
    reusedFromNodeRunId: string | null;
    startedAt: string | null;
    completedAt: string | null;
  }>;
};

type WorkflowNodeOption = { id: string; name: string };

function when(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function duration(startedAt: string | null, completedAt: string | null) {
  if (!startedAt) return "—";
  const elapsed = Math.max(0, new Date(completedAt || Date.now()).getTime() - new Date(startedAt).getTime());
  if (elapsed < 1_000) return "<1s";
  const seconds = Math.round(elapsed / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m${remainder ? ` ${remainder}s` : ""}`;
}

function statusLabel(status: RunSummary["status"] | string) {
  if (status === "completed_with_warnings") return "Completed with warnings";
  return status.charAt(0).toUpperCase() + status.slice(1).replaceAll("_", " ");
}

function runKindLabel(kind: RunSummary["runKind"]) {
  if (kind === "production") return "Live run";
  if (kind === "replay") return "Retry";
  if (kind === "trigger") return "Automatic run";
  if (kind === "subworkflow") return "Child workflow";
  if (kind === "node-preview") return "Step preview";
  return "Test run";
}

function StatusIcon({ status, size = 13 }: { status: string; size?: number }) {
  if (status === "completed") return <Check size={size} />;
  if (status === "failed" || status === "completed_with_warnings") return <AlertTriangle size={size} />;
  return <Clock3 size={size} />;
}

const routineOutputPorts = new Set(["run", "result", "output", "data", "source", "identity", "settings", "references"]);

function readablePort(value: string) {
  const words = value.replaceAll(/[-_.]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : value;
}

export function AutomationWorkflowOperations({ projectId, workflowId, capabilities, workflowNodes, onClose }: {
  projectId: string;
  workflowId: string;
  capabilities: AutomationCapabilities;
  workflowNodes: WorkflowNodeOption[];
  onClose: () => void;
}) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRun, setSelectedRun] = useState<RunSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const workflowNodeNames = useMemo(() => new Map(workflowNodes.map((node) => [node.id, node.name])), [workflowNodes]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const inspectRun = useCallback(async (runId: string, quiet = false) => {
    if (!quiet) setBusyId(runId);
    try {
      const response = await fetch(`/api/automation-runs/${encodeURIComponent(runId)}`, { cache: "no-store" });
      const body = await response.json() as { run?: RunSummary; error?: string };
      if (!response.ok || !body.run) throw new Error(body.error || "Could not inspect this run");
      setSelectedRun(body.run);
      setError("");
    } catch (inspectError) {
      setError(inspectError instanceof Error ? inspectError.message : "Could not inspect this run");
    } finally {
      if (!quiet) setBusyId("");
    }
  }, []);

  const loadRuns = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/automation-runs?projectId=${encodeURIComponent(projectId)}&workflowId=${encodeURIComponent(workflowId)}&limit=50`, { cache: "no-store" });
      const body = await response.json() as { runs?: RunSummary[]; error?: string };
      if (!response.ok) throw new Error(body.error || "Could not load run history");
      const runList = body.runs || [];
      setRuns(runList);
      setError("");
      if (runList[0]) await inspectRun(runList[0].id, true);
      else setSelectedRun(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load run history");
    } finally {
      setLoading(false);
    }
  }, [inspectRun, projectId, workflowId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadRuns(), 0);
    return () => window.clearTimeout(timer);
  }, [loadRuns]);

  async function retryRun(runId: string, nodeId: string) {
    setBusyId(`${runId}:${nodeId}`);
    try {
      const response = await fetch(`/api/automation-runs/${encodeURIComponent(runId)}/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeId }),
      });
      const body = await response.json() as { runId?: string; error?: string };
      if (!response.ok || !body.runId) throw new Error(body.error || "Could not retry this run");
      await loadRuns();
      await inspectRun(body.runId);
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : "Could not retry this run");
    } finally {
      setBusyId("");
    }
  }

  return <div className="automation-operations-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="automation-operations" role="dialog" aria-modal="true" aria-label="Run history">
      <header>
        <div><small>WORKFLOW ACTIVITY</small><h2>Run history</h2><p>See what ran, where it stopped and what each run produced.</p></div>
        <button type="button" className="automation-operations-close" onClick={onClose} aria-label="Close run history"><X size={17} /></button>
      </header>
      {error && <div className="automation-operations-error" role="alert"><AlertTriangle size={14} />{error}</div>}
      <div className="automation-operations-body">
        {loading ? <div className="automation-run-skeleton" aria-live="polite"><i /><i /><i /><span>Loading runs…</span></div> : <>
          <aside className="automation-operations-list" aria-label="Workflow runs">
            <div className="automation-operations-list-heading"><span>Recent runs</span><em>{runs.length}</em></div>
            {!runs.length && <div className="automation-operations-empty"><GitBranch size={20} /><p>Runs will appear here after this workflow starts.</p></div>}
            {runs.map((run) => <button type="button" key={run.id} className={selectedRun?.id === run.id ? "is-selected" : ""} disabled={busyId === run.id} onClick={() => void inspectRun(run.id)}>
              <span className={`is-${run.status}`}><StatusIcon status={run.status} /></span>
              <i><b>{statusLabel(run.status)}</b><small>{runKindLabel(run.runKind)} · {when(run.createdAt)}</small></i>
              <em>{run.treeChargedCredits} units</em>
            </button>)}
          </aside>
          <main className="automation-run-inspector">
            {!selectedRun ? <div className="automation-operations-empty"><GitBranch size={22} /><p>{runs.length ? "Opening the latest run…" : "Start the workflow once to see its route, errors and output here."}</p></div> : <>
              <section className="automation-run-overview">
                <div className={`automation-run-overview-status is-${selectedRun.status}`}><span><StatusIcon status={selectedRun.status} size={15} /></span><div><small>{runKindLabel(selectedRun.runKind)}</small><h3>{statusLabel(selectedRun.status)}</h3><p>{when(selectedRun.startedAt || selectedRun.createdAt)} · {duration(selectedRun.startedAt, selectedRun.completedAt)}</p></div></div>
                <dl>
                  <div><dt>Steps</dt><dd>{selectedRun.treeNodeExecutions}</dd></div>
                  <div><dt>Assets</dt><dd>{selectedRun.treeGeneratedAssets}</dd></div>
                  <div><dt>Usage</dt><dd>{selectedRun.treeChargedCredits} units</dd></div>
                  {selectedRun.treeRunCount > 1 && <div><dt>Workflow runs</dt><dd>{selectedRun.treeRunCount}</dd></div>}
                </dl>
              </section>
              {selectedRun.error && <div className="automation-run-error"><b>{selectedRun.code || "RUN_FAILED"}</b><p>{selectedRun.error}</p></div>}
              {selectedRun.replayOfRunId && <div className="automation-run-note"><RotateCcw size={13} /><p>Retried from a previous run and reused {selectedRun.reusedNodeCount} completed upstream step{selectedRun.reusedNodeCount === 1 ? "" : "s"}.</p></div>}
              <div className="automation-run-steps-heading"><span>Run route</span><em>{selectedRun.nodeRuns.length} executed steps</em></div>
              <div className="automation-run-timeline">{selectedRun.nodeRuns.map((nodeRun, index) => {
                const stepName = workflowNodeNames.get(nodeRun.nodeId) || nodeRun.nodeId.replaceAll("-", " ");
                const meaningfulPorts = nodeRun.outputPorts.filter((port) => !routineOutputPorts.has(port.toLowerCase()));
                const canRetry = capabilities.run && (selectedRun.status === "failed" || selectedRun.status === "completed_with_warnings") && nodeRun.status === "failed";
                return <article key={nodeRun.id} className={`is-${nodeRun.status}`}>
                  <span><StatusIcon status={nodeRun.status} size={12} /></span>
                  <em>{String(index + 1).padStart(2, "0")}</em>
                  <div><b>{stepName}</b><small>{statusLabel(nodeRun.status)}{nodeRun.attempt > 1 ? ` · attempt ${nodeRun.attempt}` : ""}{nodeRun.reusedFromNodeRunId ? " · reused previous output" : ""}</small>{meaningfulPorts.length > 0 && <p>Route: {meaningfulPorts.map(readablePort).join(" · ")}</p>}{nodeRun.error && <p className="is-error">{nodeRun.error}</p>}</div>
                  <aside>{nodeRun.chargedCredits > 0 && <small>{nodeRun.chargedCredits} units</small>}<small>{duration(nodeRun.startedAt, nodeRun.completedAt)}</small>{canRetry && <button type="button" disabled={Boolean(busyId)} onClick={() => void retryRun(selectedRun.id, nodeRun.nodeId)}><RotateCcw size={12} /> Retry</button>}</aside>
                </article>;
              })}</div>
            </>}
          </main>
        </>}
      </div>
    </section>
  </div>;
}
