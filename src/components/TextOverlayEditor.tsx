"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState, type RefObject, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { Check, Type, X } from "lucide-react";
import { getTextOverlay, previewTextOverlay } from "@/lib/text-overlay/client";
import { clampOverlayPosition, type OverlayPreview, type TextOverlayDocument } from "@/lib/text-overlay/document";
import type { TextOverlaySettings } from "@/lib/text-overlay/settings";

export type ApplyTextOverlay = (assetId: string, text: string, settings: TextOverlaySettings) => Promise<void>;

function OverlayForm({ document, busy, error, onText, onApply, children, applyDisabled }: {
  document: TextOverlayDocument | null; busy: boolean; error: string;
  onText: (text: string) => void; onApply: () => void; children?: React.ReactNode; applyDisabled?: boolean;
}) {
  return <div className="text-overlay-form" onKeyDown={(event) => event.stopPropagation()}>
    <label htmlFor="image-overlay-text">TEXT</label>
    <textarea id="image-overlay-text" aria-label="Overlay text" placeholder="Add a few words…" maxLength={2000}
      value={document?.text || ""} disabled={!document || busy} onChange={(event) => onText(event.target.value)} />
    {children}
    {error && <p role="alert" className="text-overlay-error">{error}</p>}
    <button type="button" className="text-overlay-apply" disabled={!document || busy || applyDisabled} onClick={onApply}>
      {busy ? <span className="generator-spinner" /> : <Check size={14} />}<span>{busy ? "Saving…" : "Apply text"}</span>
    </button>
  </div>;
}

export function TextOverlayPopover({ projectId, assetId, disabled, onApply, onEdit }: {
  projectId: string; assetId: string; disabled?: boolean; onApply: ApplyTextOverlay; onEdit: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [document, setDocument] = useState<TextOverlayDocument | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const busyRef = useRef(busy);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  const open = Boolean(position);
  const close = () => { setPosition(null); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    getTextOverlay(projectId, assetId, controller.signal).then(setDocument).catch((error) => {
      if (!controller.signal.aborted) setError(error.message);
    });
    const outside = (event: globalThis.PointerEvent) => {
      if (!busyRef.current && !popup.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setPosition(null);
    };
    window.addEventListener("pointerdown", outside);
    return () => { controller.abort(); window.removeEventListener("pointerdown", outside); };
  }, [open, projectId, assetId]);
  async function apply(edit = false) {
    if (!document || busy) return;
    setBusy(true); setError("");
    try { await onApply(assetId, document.text, document.settings); close(); if (edit) onEdit(); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not save text"); }
    finally { setBusy(false); }
  }
  return <>
    <button ref={trigger} className="text-overlay-trigger" type="button" title="Text overlay" aria-label="Text overlay" aria-expanded={open} aria-haspopup="dialog" disabled={disabled}
      onPointerDown={(event) => event.stopPropagation()} onClick={(event) => {
        event.stopPropagation();
        if (open) { close(); return; }
        const rect = trigger.current!.getBoundingClientRect();
        setDocument(null); setError("");
        setPosition({ left: Math.max(12, Math.min(window.innerWidth - 300, rect.left)), top: Math.max(12, Math.min(window.innerHeight - 320, rect.bottom + 8)) });
      }}><Type size={15} /><span>Text</span></button>
    {position && createPortal(<div ref={popup} className="text-overlay-popover nodrag nopan" style={position} role="dialog" aria-label="Text overlay"
      onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape" && !busy) close(); }}>
      <header><span>Text overlay</span><button type="button" aria-label="Close text overlay" disabled={busy} onClick={close}><X size={14} /></button></header>
      <OverlayForm document={document} busy={busy} error={error} onText={(text) => setDocument((value) => value && { ...value, text })} onApply={() => void apply()} />
      <button type="button" className="text-overlay-edit-link" disabled={!document || busy} onClick={() => void apply(true)}>Move & resize in Edit <span>↗</span></button>
    </div>, window.document.body)}
  </>;
}

export function TextOverlayEditor({ projectId, assetId, fallbackUrl, imageRef, onImageLoad, panel, disabled, onApply, onDraftChange }: {
  projectId: string; assetId: string; fallbackUrl: string; imageRef: RefObject<HTMLImageElement | null>; onImageLoad: () => void;
  panel: HTMLElement | null; disabled: boolean; onApply: ApplyTextOverlay; onDraftChange: (dirty: boolean) => void;
}) {
  const [document, setDocument] = useState<TextOverlayDocument | null>(null);
  const [saved, setSaved] = useState("");
  const [preview, setPreview] = useState<OverlayPreview | null>(null);
  const [previewScale, setPreviewScale] = useState(1);
  const [rendering, setRendering] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const drag = useRef<{ x: number; y: number; settings: TextOverlaySettings; width: number; height: number; resize: boolean } | null>(null);
  const dirty = Boolean(document && JSON.stringify(document) !== saved);
  useEffect(() => { onDraftChange(dirty || saving); return () => onDraftChange(false); }, [dirty, saving, onDraftChange]);
  useEffect(() => {
    const controller = new AbortController();
    // Reset the draft when the external asset changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDocument(null); setPreview(null); setSaved(""); setError("");
    getTextOverlay(projectId, assetId, controller.signal).then((value) => {
      setDocument(value); setSaved(JSON.stringify(value));
    }).catch((error) => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [assetId, projectId]);
  // Position changes use the already-rendered layer; only typography needs a preview request.
  const renderKey = document ? JSON.stringify({ text: document.text, settings: { ...document.settings, x: 50, y: 50 } }) : "";
  useEffect(() => {
    if (!renderKey) return;
    const value = JSON.parse(renderKey) as TextOverlayDocument;
    // Synchronize the pending state with the debounced external renderer.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!value.text.trim()) { setPreview(null); setRendering(false); return; }
    const controller = new AbortController();
    setRendering(true); setError("");
    const timer = window.setTimeout(() => {
      previewTextOverlay(projectId, assetId, value.text, value.settings, controller.signal).then((result) => {
        if (controller.signal.aborted) return;
        setPreview(result); setPreviewScale(value.settings.sizeScale);
        setDocument((current) => current && { ...current, settings: clampOverlayPosition(current.settings, result) });
        setRendering(false);
      }).catch((error) => { if (!controller.signal.aborted) { setError(error.message); setRendering(false); setPreview(null); } });
    }, 450);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [assetId, projectId, renderKey]);
  function changeSettings(settings: TextOverlaySettings) {
    setDocument((value) => value && { ...value, settings: preview ? clampOverlayPosition(settings, preview) : settings });
  }
  function start(event: PointerEvent<HTMLElement>, resize: boolean) {
    if (!document || disabled || saving) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
    const rect = imageRef.current!.getBoundingClientRect();
    drag.current = { x: event.clientX, y: event.clientY, settings: document.settings, width: rect.width, height: rect.height, resize };
  }
  function move(event: PointerEvent<HTMLElement>) {
    const current = drag.current;
    if (!current) return;
    if (current.resize) changeSettings({ ...current.settings, sizeScale: Math.max(.25, Math.min(3, current.settings.sizeScale + (event.clientX - current.x) / current.width * 3)) });
    else changeSettings({ ...current.settings, x: current.settings.x + (event.clientX - current.x) / current.width * 100, y: current.settings.y + (event.clientY - current.y) / current.height * 100 });
  }
  async function apply() {
    if (!document || saving || rendering) return;
    setSaving(true); setError("");
    try { await onApply(assetId, document.text, document.settings); setSaved(JSON.stringify(document)); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not save text"); }
    finally { setSaving(false); }
  }
  const bounds = preview?.bounds;
  return <>
    <img ref={imageRef} src={document ? `/api/assets/${document.sourceAssetId}?delivery=direct` : fallbackUrl} alt="Image with editable text" onLoad={onImageLoad} draggable={false} />
    {document && preview && bounds && !disabled && <div className="text-overlay-layer" style={{
      left: `${document.settings.x + (bounds[0] / preview.width - .5) * 100}%`,
      top: `${document.settings.y + (bounds[1] / preview.height - .5) * 100}%`,
      transform: `scale(${document.settings.sizeScale / previewScale})`,
      width: `${(bounds[2] - bounds[0]) / preview.width * 100}%`, height: `${(bounds[3] - bounds[1]) / preview.height * 100}%`,
    }}>
      <button type="button" className="text-overlay-drag" aria-label="Move overlay text" disabled={saving} onPointerDown={(event) => start(event, false)} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
        onKeyDown={(event) => {
          event.stopPropagation(); const step = event.shiftKey ? 5 : 1;
          const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
          const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
          if (dx || dy) { event.preventDefault(); changeSettings({ ...document.settings, x: document.settings.x + dx, y: document.settings.y + dy }); }
        }}><img src={preview.url} alt={document.text} draggable={false} /></button>
      <button type="button" className="text-overlay-resize" aria-label="Resize overlay text" disabled={saving} onPointerDown={(event) => start(event, true)} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }} />
    </div>}
    {panel && createPortal(<div className="text-overlay-panel-content">
      <header><Type size={16} /><strong>Text overlay</strong></header>
      <OverlayForm document={document} applyDisabled={rendering || Boolean(document?.text.trim() && !preview) || !dirty} busy={saving || disabled} error={error} onText={(text) => setDocument((value) => value && { ...value, text })} onApply={() => void apply()}>
        <label className="text-overlay-size">Size <output>{Math.round((document?.settings.sizeScale || 1) * 100)}%</output>
          <input aria-label="Text size" type="range" min="0.25" max="3" step="0.05" value={document?.settings.sizeScale || 1} disabled={!document || saving || disabled}
            onChange={(event) => document && changeSettings({ ...document.settings, sizeScale: Number(event.target.value) })} />
        </label>
        <p className="text-overlay-hint" aria-live="polite">{rendering ? "Updating preview…" : "Drag the text to move it. Pull the corner to resize."}</p>
      </OverlayForm>
      {dirty && <button type="button" className="text-overlay-edit-link" disabled={saving || disabled} onClick={() => { setDocument(JSON.parse(saved)); setError(""); }}>Reset changes</button>}
      <p className="text-overlay-hint">Apply to save. Downloads include your text.</p>
    </div>, panel)}
  </>;
}
