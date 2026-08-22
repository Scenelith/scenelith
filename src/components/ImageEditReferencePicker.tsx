"use client";

/* eslint-disable @next/next/no-img-element */

import { useEffect, useRef, useState } from "react";
import { Check, Images, LockKeyhole, Paperclip, Upload, UserRound, X } from "lucide-react";

export type ImageEditReference = {
  assetId: string;
  url: string;
  thumbnailUrl?: string;
  title: string;
  origin: "canvas" | "identity" | "upload";
  detail: string;
  personaId?: string;
  variant?: "reference" | "before" | "after";
};

export type ImageEditPersona = {
  id: string;
  name: string;
  avatarUrl?: string;
  references: ImageEditReference[];
};

type PickerTab = "canvas" | "identity" | "upload";

function ReferenceTile({ reference, selected, disabled, onToggle }: {
  reference: ImageEditReference;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return <button
    type="button"
    className={`media-edit-reference-tile ${selected ? "is-selected" : ""}`}
    aria-pressed={selected}
    aria-label={`${selected ? "Remove" : "Add"} ${reference.title}`}
    title={reference.title}
    disabled={disabled && !selected}
    onPointerDown={(event) => { event.stopPropagation(); onToggle(); }}
  >
    <span className="media-edit-reference-image">
      <img src={reference.thumbnailUrl || reference.url} alt="" loading="lazy" decoding="async" />
      {selected && <span><Check size={10} /></span>}
    </span>
  </button>;
}

export function ImageEditReferencePicker({
  source,
  canvasReferences,
  personas,
  selected,
  maxAdditional,
  disabled,
  onChange,
  onUpload,
}: {
  source: { url: string; title: string; personaId?: string; personaName?: string; personaVariant?: "reference" | "before" | "after" };
  canvasReferences: ImageEditReference[];
  personas: ImageEditPersona[];
  selected: ImageEditReference[];
  maxAdditional: number;
  disabled?: boolean;
  onChange: (references: ImageEditReference[]) => void;
  onUpload: (files: File[]) => Promise<ImageEditReference[]>;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<PickerTab>("canvas");
  const [uploaded, setUploaded] = useState<ImageEditReference[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedIds = new Set(selected.map((reference) => reference.assetId));
  const remaining = Math.max(0, maxAdditional - selected.length);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  useEffect(() => {
    const restoredUploads = selected.filter((reference) => reference.origin === "upload");
    if (!restoredUploads.length) return;
    queueMicrotask(() => setUploaded((current) => [...current, ...restoredUploads].filter((reference, index, all) => all.findIndex((item) => item.assetId === reference.assetId) === index)));
  }, [selected]);

  const toggle = (reference: ImageEditReference) => {
    setError("");
    if (selectedIds.has(reference.assetId)) {
      onChange(selected.filter((item) => item.assetId !== reference.assetId));
      return;
    }
    if (!remaining) {
      setError(`This model allows ${maxAdditional} additional reference${maxAdditional === 1 ? "" : "s"}`);
      return;
    }
    onChange([...selected, reference]);
  };

  const uploadFiles = async (files: File[]) => {
    const accepted = files.filter((file) => ["image/jpeg", "image/jpg", "image/png"].includes(file.type) || /\.(jpe?g|png)$/i.test(file.name));
    if (!accepted.length) {
      setError("Upload JPG or PNG images");
      return;
    }
    if (!remaining) {
      setError("Remove a reference before uploading another one");
      return;
    }
    setUploading(true);
    setError("");
    try {
      const added = await onUpload(accepted.slice(0, remaining));
      const unique = added.filter((reference) => !selectedIds.has(reference.assetId));
      setUploaded((current) => [...current, ...unique].filter((reference, index, all) => all.findIndex((item) => item.assetId === reference.assetId) === index));
      onChange([...selected, ...unique].slice(0, maxAdditional));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not upload references");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const tabs: Array<{ id: PickerTab; label: string; icon: typeof Images; count?: number }> = [
    { id: "canvas", label: "Canvas", icon: Images, count: canvasReferences.length },
    { id: "identity", label: "Identities", icon: UserRound, count: personas.reduce((total, persona) => total + persona.references.length, 0) },
    { id: "upload", label: "Upload", icon: Upload, count: uploaded.length || undefined },
  ];
  const orderedPersonas = [...personas].sort((left, right) => Number(right.id === source.personaId) - Number(left.id === source.personaId));

  return <div ref={rootRef} className={`media-edit-reference-picker ${open ? "is-open" : ""}`}>
    <button
      type="button"
      className="media-edit-reference-trigger"
      aria-expanded={open}
      aria-label={`Edit references · ${selected.length} attached`}
      disabled={disabled}
      onPointerDown={(event) => { event.stopPropagation(); setOpen((value) => !value); setError(""); }}
    >
      <Paperclip size={13} />
      <span>References</span>
      <b>{selected.length}</b>
    </button>

    {open && <><div className="media-edit-reference-scrim" aria-hidden="true" onPointerDown={() => setOpen(false)} />
    <section className="media-edit-reference-menu" aria-label="Edit references" onWheel={(event) => event.stopPropagation()}>
      <header>
        <span><strong>Edit references</strong><small>Choose only the evidence this edit needs</small></span>
        <span className="media-edit-reference-limit">{selected.length + 1}/{maxAdditional + 1}</span>
        <button type="button" aria-label="Close edit references" onPointerDown={() => setOpen(false)}><X size={14} /></button>
      </header>

      <div className="media-edit-reference-source">
        <span className="media-edit-reference-source-image"><img src={source.url} alt="" /><LockKeyhole size={10} /></span>
        <span><strong>Current image</strong><small>{source.title} · @EditSource · {source.personaName ? `Identity: ${source.personaName}${source.personaVariant ? ` / ${source.personaVariant.toUpperCase()}` : ""}` : "No assigned identity"}</small></span>
        <em>BASE</em>
      </div>

      <nav aria-label="Reference source">
        {tabs.map((item) => <button key={item.id} type="button" className={tab === item.id ? "is-active" : ""} onPointerDown={() => { setTab(item.id); setError(""); }}>
          <item.icon size={12} /><span>{item.label}</span>{item.count !== undefined && <b>{item.count}</b>}
        </button>)}
      </nav>

      <div className="media-edit-reference-body nowheel" onWheel={(event) => event.stopPropagation()}>
        {tab === "canvas" && <>
          {canvasReferences.length ? <div className="media-edit-reference-grid">
            {canvasReferences.map((reference) => <ReferenceTile key={reference.assetId} reference={reference} selected={selectedIds.has(reference.assetId)} disabled={!remaining} onToggle={() => toggle(reference)} />)}
          </div> : <div className="media-edit-reference-empty"><Images size={20} /><strong>No other canvas images</strong><span>Generated and imported image nodes will appear here.</span></div>}
        </>}

        {tab === "identity" && <>
          {orderedPersonas.some((persona) => persona.references.length) ? <div className="media-edit-persona-groups">
            {orderedPersonas.filter((persona) => persona.references.length).map((persona) => <section className={persona.id === source.personaId ? "is-primary" : ""} key={persona.id}>
              <header>{persona.avatarUrl ? <img src={persona.avatarUrl} alt="" /> : <span><UserRound size={13} /></span>}<strong>{persona.name}</strong>{persona.id === source.personaId && <b>SOURCE IDENTITY</b>}<small>{persona.references.length}</small></header>
              {(["reference", "before", "after"] as const).map((variant) => {
                const references = persona.references.filter((reference) => (reference.variant || "reference") === variant);
                if (!references.length) return null;
                return <div className={`media-edit-persona-variant is-${variant}`} key={variant}>
                  <div><strong>{variant === "reference" ? "IDENTITY" : variant.toUpperCase()}</strong><span>{references.length}</span></div>
                  <div className="media-edit-reference-grid">{references.map((reference) => <ReferenceTile key={reference.assetId} reference={reference} selected={selectedIds.has(reference.assetId)} disabled={!remaining} onToggle={() => toggle(reference)} />)}</div>
                </div>;
              })}
            </section>)}
          </div> : <div className="media-edit-reference-empty"><UserRound size={20} /><strong>No identities yet</strong><span>Create an identity to use its named references in edits.</span></div>}
        </>}

        {tab === "upload" && <div className="media-edit-upload-panel">
          <button type="button" className={`media-edit-upload-zone ${uploading ? "is-uploading" : ""}`} disabled={uploading || !remaining} onPointerDown={() => inputRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void uploadFiles(Array.from(event.dataTransfer.files)); }}>
            <Upload size={18} />
            <span><strong>{uploading ? "Uploading references…" : "Add external references"}</strong><small>Drop images here or choose files · JPG, PNG</small></span>
          </button>
          <input ref={inputRef} type="file" accept=".jpg,.jpeg,.png,image/jpeg,image/png" multiple hidden onChange={(event) => void uploadFiles(Array.from(event.target.files || []))} />
          {uploaded.length > 0 && <><div className="media-edit-upload-label">THIS EDIT</div><div className="media-edit-reference-grid">{uploaded.map((reference) => <ReferenceTile key={reference.assetId} reference={reference} selected={selectedIds.has(reference.assetId)} disabled={!remaining} onToggle={() => toggle(reference)} />)}</div></>}
        </div>}
      </div>

      <footer>
        <span>{remaining ? `${remaining} additional slot${remaining === 1 ? "" : "s"} available` : "Reference limit reached"}</span>
        {error && <em>{error}</em>}
        <button type="button" onPointerDown={() => setOpen(false)}>Done</button>
      </footer>
    </section></>}
  </div>;
}
