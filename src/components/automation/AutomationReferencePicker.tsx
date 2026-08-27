"use client";

/* eslint-disable @next/next/no-img-element */

import { Check, Images, Library, LoaderCircle, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LibraryMediaAsset } from "@/lib/types";

export type AutomationReferenceCandidate = {
  assetId: string;
  url: string;
  thumbnailUrl?: string;
  title: string;
  detail: string;
};

type ReferenceTab = "canvas" | "library";

function uniqueCandidates(candidates: AutomationReferenceCandidate[]) {
  return candidates.filter((candidate, index, all) => all.findIndex((item) => item.assetId === candidate.assetId) === index);
}

export function AutomationReferencePicker({
  workspaceId,
  projectId,
  canvasReferences,
  selectedIds,
  maxItems,
  disabled,
  placement,
  onChange,
}: {
  workspaceId: string;
  projectId: string;
  canvasReferences: AutomationReferenceCandidate[];
  selectedIds: string[];
  maxItems: number;
  disabled?: boolean;
  placement: "run-panel" | "editor";
  onChange: (assetIds: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ReferenceTab>("canvas");
  const [search, setSearch] = useState("");
  const [libraryAssets, setLibraryAssets] = useState<AutomationReferenceCandidate[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [draftIds, setDraftIds] = useState<string[]>(selectedIds);
  const libraryRequestRef = useRef(0);
  const selected = useMemo(() => new Set(draftIds), [draftIds]);
  const limit = Math.min(32, Math.max(1, maxItems || 8));

  useEffect(() => {
    if (!open || tab !== "library" || !workspaceId) return;
    const controller = new AbortController();
    const requestId = libraryRequestRef.current + 1;
    libraryRequestRef.current = requestId;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      const query = new URLSearchParams({ workspaceId, mediaType: "image" });
      if (search.trim()) query.set("search", search.trim());
      void fetch(`/api/assets?${query.toString()}`, { cache: "no-store", signal: controller.signal })
        .then(async (response) => {
          const body = await response.json() as { assets?: LibraryMediaAsset[]; nextCursor?: string | null; error?: string };
          if (!response.ok) throw new Error(body.error || "Could not load the Library");
          if (libraryRequestRef.current !== requestId) return;
          setLibraryAssets(uniqueCandidates((body.assets || []).map((asset) => ({
            assetId: asset.id,
            url: asset.url,
            thumbnailUrl: asset.thumbnailUrl,
            title: asset.originalName || asset.filename,
            detail: asset.projectId === projectId ? "This canvas" : asset.canvasName,
          }))));
          setNextCursor(body.nextCursor || null);
        })
        .catch((reason) => {
          if (reason?.name !== "AbortError" && libraryRequestRef.current === requestId) {
            setError(reason instanceof Error ? reason.message : "Could not load the Library");
          }
        })
        .finally(() => { if (libraryRequestRef.current === requestId) setLoading(false); });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (libraryRequestRef.current === requestId) setLoading(false);
    };
  }, [open, projectId, search, tab, workspaceId]);

  const loadMore = async () => {
    if (!nextCursor || loading) return;
    setLoading(true);
    setError("");
    const query = new URLSearchParams({ workspaceId, mediaType: "image", cursor: nextCursor });
    if (search.trim()) query.set("search", search.trim());
    try {
      const response = await fetch(`/api/assets?${query.toString()}`, { cache: "no-store" });
      const body = await response.json() as { assets?: LibraryMediaAsset[]; nextCursor?: string | null; error?: string };
      if (!response.ok) throw new Error(body.error || "Could not load more images");
      setLibraryAssets((current) => uniqueCandidates([...current, ...(body.assets || []).map((asset) => ({
        assetId: asset.id,
        url: asset.url,
        thumbnailUrl: asset.thumbnailUrl,
        title: asset.originalName || asset.filename,
        detail: asset.projectId === projectId ? "This canvas" : asset.canvasName,
      }))]));
      setNextCursor(body.nextCursor || null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load more images");
    } finally {
      setLoading(false);
    }
  };

  const candidates = tab === "canvas" ? canvasReferences : libraryAssets;
  const toggle = (assetId: string) => {
    setError("");
    if (selected.has(assetId)) {
      setDraftIds((current) => current.filter((id) => id !== assetId));
      return;
    }
    if (draftIds.length >= limit) {
      setError(`Choose up to ${limit} reference${limit === 1 ? "" : "s"}`);
      return;
    }
    setDraftIds((current) => [...current, assetId]);
  };

  const openPicker = () => {
    if (disabled) return;
    setDraftIds(selectedIds);
    setError("");
    setOpen(true);
  };
  const apply = () => { onChange(draftIds); setOpen(false); };

  return <div className="automation-reference-field">
    <button type="button" className="automation-reference-trigger" disabled={disabled} onClick={openPicker}>
      <Images size={15} />
      <span><b>{selectedIds.length ? `${selectedIds.length} selected` : "Choose reference images"}</b><small>From this canvas or the workspace Library</small></span>
      <em>{selectedIds.length}/{limit}</em>
    </button>
    {open && typeof document !== "undefined" && createPortal(<>
      <button type="button" className="automation-reference-dismiss" aria-label="Close reference picker" onClick={() => setOpen(false)} />
      <section className={`automation-reference-drawer is-${placement}`} role="dialog" aria-modal="false" aria-label="Choose visual references" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
        <header><span><b>Visual references</b><small>Choose only the images this workflow needs</small></span><em>{draftIds.length}/{limit}</em><button type="button" aria-label="Close" onClick={() => setOpen(false)}><X size={16} /></button></header>
        <nav aria-label="Reference source">
          <button type="button" className={tab === "canvas" ? "is-active" : ""} onClick={() => { setTab("canvas"); setError(""); }}><Images size={14} /><span>This canvas</span><b>{canvasReferences.length}</b></button>
          <button type="button" className={tab === "library" ? "is-active" : ""} onClick={() => { setTab("library"); setError(""); }}><Library size={14} /><span>Library</span></button>
        </nav>
        {tab === "library" && <label className="automation-reference-search"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search images and canvases…" /></label>}
        <div className="automation-reference-grid">
          {candidates.map((candidate) => <button type="button" key={candidate.assetId} className={selected.has(candidate.assetId) ? "is-selected" : ""} aria-pressed={selected.has(candidate.assetId)} onClick={() => toggle(candidate.assetId)}>
            <span><img src={candidate.thumbnailUrl || candidate.url} alt="" loading="lazy" decoding="async" />{selected.has(candidate.assetId) && <i><Check size={12} /></i>}</span>
            <b title={candidate.title}>{candidate.title}</b><small>{candidate.detail}</small>
          </button>)}
          {loading && !candidates.length && <div className="automation-reference-empty"><LoaderCircle size={19} className="is-spinning" /><b>Loading images…</b></div>}
          {!loading && !candidates.length && <div className="automation-reference-empty"><Images size={20} /><b>{tab === "canvas" ? "No image assets on this canvas" : "No Library images found"}</b><small>{tab === "canvas" ? "Generated and imported images with saved assets appear here." : "Try another search or add images to the Library."}</small></div>}
        </div>
        {tab === "library" && nextCursor && <button type="button" className="automation-reference-more" disabled={loading} onClick={() => void loadMore()}>{loading ? "Loading…" : "Load more"}</button>}
        <footer><span>{error || `${Math.max(0, limit - draftIds.length)} slots available`}</span><div>{draftIds.length > 0 && <button type="button" className="is-clear" onClick={() => { setDraftIds([]); setError(""); }}>Clear</button>}<button type="button" onClick={apply}>Use {draftIds.length || "no"} reference{draftIds.length === 1 ? "" : "s"}</button></div></footer>
      </section>
    </>, document.body)}
  </div>;
}
