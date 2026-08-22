"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BackgroundTaskRecord } from "@/lib/types";

function relativeTime(value: string) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d` : new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function TaskCenter({ onNavigate }: { onNavigate: (task: BackgroundTaskRecord) => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<BackgroundTaskRecord[]>([]);
  const [activeCount, setActiveCount] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/tasks", { cache: "no-store" });
      const body = await response.json() as { tasks: BackgroundTaskRecord[]; activeCount: number };
      if (!response.ok) return;
      setItems(body.tasks);
      setActiveCount(body.activeCount);
      window.dispatchEvent(new CustomEvent("scenelith:tasks-updated", { detail: body }));
    } catch {}
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), activeCount > 0 ? 5_000 : 20_000);
    const refreshWhenVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", refreshWhenVisible);
    window.addEventListener("scenelith:tasks-changed", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshWhenVisible);
      window.removeEventListener("scenelith:tasks-changed", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [activeCount, refresh]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", escape); };
  }, [open]);

  const activeItems = items.filter((item) => item.status === "queued" || item.status === "running");
  const recentItems = items.filter((item) => item.status === "completed" || item.status === "failed").slice(0, 6);
  const visibleItems = [...activeItems, ...recentItems];
  const renderTask = (item: BackgroundTaskRecord) => {
    const active = item.status === "queued" || item.status === "running";
    const progress = Math.max(0, Math.min(100, item.progress));
    const detail = item.status === "failed" ? item.error || "This task stopped before it finished." : item.stageLabel;
    const stateLabel = item.status === "queued" ? "Queued" : item.status === "running" ? `${Math.round(progress)}%` : item.status === "completed" ? "Done" : "Failed";
    return <button type="button" key={`${item.kind}-${item.id}`} className={`task-row is-${item.status}`} onClick={() => { onNavigate(item); setOpen(false); }}>
      <span className="task-copy">
        <strong>{item.title}</strong>
        <span className="task-meta"><small>{item.projectName}</small><i aria-hidden="true" /><small>{relativeTime(item.updatedAt)}</small></span>
        <p className={item.status === "failed" ? "task-error" : undefined}>{detail}</p>
        {active && <span className="task-progress" role="progressbar" aria-label={`${Math.round(progress)}% complete`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}><i style={{ transform: `scaleX(${progress / 100})` }} /></span>}
      </span>
      <span className={`task-state is-${item.status}`}><b>{stateLabel}</b></span>
    </button>;
  };

  return <div className={`task-center ${open ? "is-open" : ""}`} ref={rootRef}>
    <button type="button" className="task-trigger" aria-label={`${activeCount} active tasks`} aria-expanded={open} onClick={() => { setOpen((value) => !value); if (!open) void refresh(); }}>
      <span>Tasks</span>{activeCount > 0 && <b>{activeCount > 9 ? "9+" : activeCount}</b>}
    </button>
    {open && <div className="task-popover">
      <header><strong>Tasks</strong><small>{activeCount > 0 ? `${activeCount} active` : `${recentItems.length} recent`}</small></header>
      <div className="task-list">
        {visibleItems.map(renderTask)}
        {!items.length && <div className="task-empty"><strong>No background tasks</strong><span>Generations and automations will appear here.</span></div>}
      </div>
    </div>}
  </div>;
}
