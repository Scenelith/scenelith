"use client";

/* eslint-disable @next/next/no-img-element */

import { Check, Images, Library, LoaderCircle, Search, UserRound, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ReferenceMenuShell } from "@/components/ReferenceMenuShell";
import type { LibraryMediaAsset, PersonaRecord } from "@/lib/types";

export type AutomationReferenceCandidate = {
  assetId: string;
  url: string;
  thumbnailUrl?: string;
  title: string;
  detail: string;
};

type ReferenceTab = "canvas" | "library" | "identities";

function uniqueCandidates(candidates: AutomationReferenceCandidate[]) {
  return candidates.filter((candidate, index, all) => all.findIndex((item) => item.assetId === candidate.assetId) === index);
}

export function AutomationReferencePicker({
  workspaceId,
  projectId,
  canvasReferences,
  personas = [],
  selectedIds,
  maxItems,
  disabled,
  placement,
  onChange,
}: {
  workspaceId: string;
  projectId: string;
  canvasReferences: AutomationReferenceCandidate[];
  personas?: PersonaRecord[];
  selectedIds: string[];
  maxItems: number;
  disabled?: boolean;
  placement: "run-panel" | "editor" | "node";
  onChange: (assetIds: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ReferenceTab>("canvas");
  const [search, setSearch] = useState("");
  const [libraryAssets, setLibraryAssets] = useState<AutomationReferenceCandidate[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const libraryRequestRef = useRef(0);
  const fieldRef = useRef<HTMLDivElement>(null);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
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

  useEffect(() => {
    if (!open || placement !== "node") return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof globalThis.Node && !fieldRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, placement]);

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

  const identityReferences = useMemo(() => personas.flatMap((persona) => persona.assets.map((asset) => ({
    assetId: asset.id,
    url: asset.url,
    thumbnailUrl: asset.thumbnailUrl,
    title: `${persona.name} · ${asset.role === "reference" ? "Identity" : asset.role === "before" ? "Before" : "After"}`,
    detail: persona.name,
  } satisfies AutomationReferenceCandidate))), [personas]);
  const candidates = tab === "canvas" ? canvasReferences : tab === "library" ? libraryAssets : identityReferences;
  const toggle = (assetId: string) => {
    setError("");
    if (selected.has(assetId)) {
      onChange(selectedIds.filter((id) => id !== assetId));
      return;
    }
    if (selectedIds.length >= limit) {
      setError(`Choose up to ${limit} reference${limit === 1 ? "" : "s"}`);
      return;
    }
    onChange([...selectedIds, assetId]);
  };

  const openPicker = () => {
    if (disabled) return;
    setError("");
    setOpen(true);
  };
  const togglePicker = () => { if (open) setOpen(false); else openPicker(); };

  const compact = placement === "node";
  const sourceTabs = <nav className="automation-reference-tabs" aria-label="Reference source">
    <button type="button" className={tab === "canvas" ? "is-active" : ""} onClick={() => { setTab("canvas"); setError(""); }}><Images size={14} /><span>Canvas</span><b>{canvasReferences.length}</b></button>
    <button type="button" className={tab === "library" ? "is-active" : ""} onClick={() => { setTab("library"); setError(""); }}><Library size={14} /><span>Library</span></button>
    <button type="button" className={tab === "identities" ? "is-active" : ""} onClick={() => { setTab("identities"); setError(""); }}><UserRound size={14} /><span>Identities</span><b>{identityReferences.length}</b></button>
  </nav>;
  const referenceTile = (candidate: AutomationReferenceCandidate, compactIdentity = false) => <button
    type="button"
    key={candidate.assetId}
    className={`${selected.has(candidate.assetId) ? "is-selected" : ""} ${compactIdentity ? "is-identity-tile" : ""}`}
    aria-pressed={selected.has(candidate.assetId)}
    aria-label={`${selected.has(candidate.assetId) ? "Remove" : "Add"} ${candidate.title}`}
    title={candidate.title}
    disabled={!selected.has(candidate.assetId) && selectedIds.length >= limit}
    onClick={() => toggle(candidate.assetId)}
  >
    <span><img src={candidate.thumbnailUrl || candidate.url} alt="" loading="lazy" decoding="async" />{selected.has(candidate.assetId) && <i><Check size={12} /></i>}</span>
    {!compactIdentity && <><b title={candidate.title}>{candidate.title}</b><small>{candidate.detail}</small></>}
  </button>;
  const choices = <>
    {sourceTabs}
    {tab === "library" && <label className="automation-reference-search"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search images and canvases…" /></label>}
    {tab === "identities" && identityReferences.length > 0
      ? <div className="automation-reference-personas">
        {personas.filter((persona) => persona.assets.length).map((persona) => <section key={persona.id}>
          <header>{persona.avatarUrl ? <img src={persona.avatarUrl} alt="" /> : <span><UserRound size={13} /></span>}<strong>{persona.name}</strong><small>{persona.assets.length}</small></header>
          {(["reference", "before", "after"] as const).map((role) => {
            const assets = persona.assets.filter((asset) => asset.role === role);
            if (!assets.length) return null;
            return <div className={`automation-reference-persona-role is-${role}`} key={role}>
              <div><strong>{role === "reference" ? "IDENTITY" : role.toUpperCase()}</strong><span>{assets.length}</span></div>
              <div className="automation-reference-grid is-identity-grid">{assets.map((asset) => referenceTile({ assetId: asset.id, url: asset.url, thumbnailUrl: asset.thumbnailUrl, title: `${persona.name} · ${role === "reference" ? "Identity" : role === "before" ? "Before" : "After"}`, detail: persona.name }, true))}</div>
            </div>;
          })}
        </section>)}
      </div>
      : <div className="automation-reference-grid">
        {candidates.map((candidate) => referenceTile(candidate))}
        {loading && !candidates.length && <div className="automation-reference-empty"><LoaderCircle size={19} className="is-spinning" /><b>Loading images…</b></div>}
        {!loading && !candidates.length && <div className="automation-reference-empty">{tab === "identities" ? <UserRound size={20} /> : <Images size={20} />}<b>{tab === "canvas" ? "No image assets on this canvas" : tab === "library" ? "No Library images found" : "No identity references yet"}</b><small>{tab === "canvas" ? "Generated and imported images with saved assets appear here." : tab === "library" ? "Try another search or add images to the Library." : "Add a person or character in Identities, then return here."}</small></div>}
      </div>}
    {tab === "library" && nextCursor && <button type="button" className="automation-reference-more" disabled={loading} onClick={() => void loadMore()}>{loading ? "Loading…" : "Load more"}</button>}
  </>;
  const footer = <footer className="automation-reference-footer"><span>{error || `${Math.max(0, limit - selectedIds.length)} slots available · selections apply immediately`}</span>{selectedIds.length > 0 && <button type="button" className="is-clear" onClick={() => { onChange([]); setError(""); }}>Clear</button>}</footer>;

  return <div ref={fieldRef} className={`automation-reference-field ${compact ? "is-node" : ""}`} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
    <button
      type="button"
      className="automation-reference-trigger"
      disabled={disabled}
      aria-expanded={open}
      onPointerDown={compact ? (event) => { event.preventDefault(); event.stopPropagation(); togglePicker(); } : undefined}
      onClick={(event) => { event.preventDefault(); event.stopPropagation(); if (!compact || event.detail === 0) togglePicker(); }}
    >
      <Images size={15} />
      <span><b>{selectedIds.length ? `${selectedIds.length} reference${selectedIds.length === 1 ? "" : "s"}` : compact ? "Add references" : "Choose reference images"}</b><small>{compact ? "Canvas · Library · Identities" : "From the canvas, Library or Identities"}</small></span>
      <em>{selectedIds.length}/{limit}</em>
    </button>
    {open && compact && <ReferenceMenuShell
      attachedLabel={`${selectedIds.length} ATTACHED`}
      capacityTitle="Visual references"
      capacityDescription={`Choose up to ${limit} images from Canvas, Library or Identities`}
      className="automation-reference-node-menu"
      footer={footer}
    >
      {choices}
    </ReferenceMenuShell>}
    {open && !compact && typeof document !== "undefined" && createPortal(<>
      <button type="button" className="automation-reference-dismiss" aria-label="Close reference picker" onClick={() => setOpen(false)} />
      <section className={`automation-reference-drawer is-${placement}`} role="dialog" aria-modal="false" aria-label="Choose visual references" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
        <header><span><b>Visual references</b><small>Choose only the images this workflow needs</small></span><em>{selectedIds.length}/{limit}</em><button type="button" aria-label="Close" onClick={() => setOpen(false)}><X size={16} /></button></header>
        {choices}
        {footer}
      </section>
    </>, document.body)}
  </div>;
}
