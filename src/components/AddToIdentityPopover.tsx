"use client";

/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowLeft, Check, ChevronDown, Images, Plus, UserRound, UserRoundPlus, X } from "lucide-react";
import type { PersonaRecord } from "@/lib/types";

type IdentityRole = "reference" | "before" | "after";

export function identityDestinationRoles(persona?: PersonaRecord): IdentityRole[] {
  if (!persona) return [];
  return persona.assets.some((asset) => asset.role === "before" || asset.role === "after")
    ? ["before", "after"]
    : ["reference"];
}

export function identityHasGeneratedAsset(persona: PersonaRecord | undefined, role: IdentityRole, sourceAssetId: string) {
  return Boolean(sourceAssetId && persona?.assets.some((asset) => asset.role === role && asset.sourceAssetId === sourceAssetId));
}

const roleLabel: Record<IdentityRole, string> = {
  reference: "Identity",
  before: "Before",
  after: "After",
};

function thumbnailUrl(url: string) {
  if (!url.startsWith("/api/assets/")) return url;
  const parsed = new URL(url, "http://scenelith.local");
  parsed.searchParams.delete("download");
  parsed.searchParams.set("variant", "thumbnail");
  parsed.searchParams.set("delivery", "direct");
  parsed.searchParams.set("v", "4");
  return `${parsed.pathname}${parsed.search}`;
}

export function AddToIdentityPopover({
  personas,
  sourceUrl,
  sourceAssetId,
  variant = "icon",
  disabled = false,
  onAdd,
  onCreate,
}: {
  personas: PersonaRecord[];
  sourceUrl: string;
  sourceAssetId: string;
  variant?: "icon" | "wide";
  disabled?: boolean;
  onAdd: (personaId: string, role: IdentityRole, sourceAssetId: string) => Promise<{ alreadyAdded?: boolean } | void>;
  onCreate: (name: string, role: IdentityRole, sourceAssetId: string) => Promise<void>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [personaPickerOpen, setPersonaPickerOpen] = useState(false);
  const [creatingNew, setCreatingNew] = useState(false);
  const [newIdentityName, setNewIdentityName] = useState("");
  const [newIdentityMode, setNewIdentityMode] = useState<"single" | "transformation">("single");
  const [personaId, setPersonaId] = useState(personas[0]?.id || "");
  const selectedPersona = personas.find((persona) => persona.id === personaId) || personas[0];
  const roles = useMemo(() => identityDestinationRoles(selectedPersona), [selectedPersona]);
  const [role, setRole] = useState<IdentityRole>(roles[0] || "reference");
  const selectedRole = roles.includes(role) ? role : roles[0] || "reference";
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState<"added" | "existing" | "created" | null>(null);
  const [error, setError] = useState("");
  const selectedAlreadyAdded = identityHasGeneratedAsset(selectedPersona, selectedRole, sourceAssetId);
  const addedAnywhere = personas.some((persona) => persona.assets.some((asset) => asset.sourceAssetId === sourceAssetId));
  const creationRole: IdentityRole = newIdentityMode === "single" ? "reference" : role === "after" ? "after" : "before";

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const stopPointer = (event: ReactPointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const add = async () => {
    if (!selectedPersona || saving) return;
    setSaving(true);
    setError("");
    try {
      const result = await onAdd(selectedPersona.id, selectedRole, sourceAssetId);
      setSuccess(result?.alreadyAdded ? "existing" : "added");
      window.setTimeout(() => {
        setOpen(false);
        setSuccess(null);
      }, 850);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not add reference");
    } finally {
      setSaving(false);
    }
  };

  const create = async () => {
    const name = newIdentityName.trim();
    if (!name || saving) return;
    setSaving(true);
    setError("");
    try {
      await onCreate(name, creationRole, sourceAssetId);
      setSuccess("created");
      window.setTimeout(() => {
        setOpen(false);
        setCreatingNew(false);
        setNewIdentityName("");
        setNewIdentityMode("single");
        setSuccess(null);
      }, 950);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create identity");
    } finally {
      setSaving(false);
    }
  };

  return <div ref={rootRef} className={`add-to-identity ${variant === "wide" ? "is-wide" : "is-icon"} ${open ? "is-open" : ""}`}>
    <button
      type="button"
      className={`add-to-identity-trigger ${addedAnywhere ? "has-added" : ""}`}
      disabled={disabled || !sourceAssetId}
      title={addedAnywhere ? "Saved to identity" : "Add to identity"}
      aria-label="Add generated image to identity"
      aria-expanded={open}
      onPointerDown={stopPointer}
      onClick={(event) => { event.preventDefault(); event.stopPropagation(); const nextOpen = !open; setOpen(nextOpen); if (nextOpen) setCreatingNew(!personas.length); setPersonaPickerOpen(false); setError(""); setSuccess(null); }}
    >
      {addedAnywhere ? <Check size={variant === "wide" ? 14 : 15} /> : <UserRoundPlus size={variant === "wide" ? 14 : 15} />}
      {variant === "wide" && <span>{addedAnywhere ? "Saved to identity" : "Add to identity"}</span>}
    </button>

    {open && <div className="add-to-identity-menu nodrag nopan nowheel" role="dialog" aria-label="Add image to identity" onPointerDown={(event) => event.stopPropagation()}>
      <header><span>{creatingNew && personas.length ? <button type="button" className="add-to-identity-back" aria-label="Back to identities" onClick={() => { setCreatingNew(false); setError(""); setSuccess(null); }}><ArrowLeft size={11} /></button> : null}{creatingNew ? "NEW IDENTITY" : "ADD TO IDENTITY"}</span><button type="button" aria-label="Close" onPointerDown={(event) => event.stopPropagation()} onClick={() => setOpen(false)}><X size={12} /></button></header>
      <div className="add-to-identity-source">
        <img src={thumbnailUrl(sourceUrl)} alt="Generated image" />
        <span><strong>Generated image</strong><small>Save as a reusable identity reference</small></span>
      </div>

      {creatingNew ? <div className="add-to-identity-create">
        <label>NAME</label>
        <input autoFocus value={newIdentityName} maxLength={80} placeholder="e.g. Olivia" aria-label="Identity name" onChange={(event) => setNewIdentityName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void create(); } }} />
        <label>IDENTITY TYPE</label>
        <div className="add-to-identity-types" role="radiogroup" aria-label="Identity type">
          <button type="button" role="radio" aria-checked={newIdentityMode === "single"} className={newIdentityMode === "single" ? "is-selected" : ""} onClick={() => { setNewIdentityMode("single"); setRole("reference"); }}><UserRound size={13} /><span><strong>Identity</strong><small>One consistent look</small></span>{newIdentityMode === "single" && <Check size={11} />}</button>
          <button type="button" role="radio" aria-checked={newIdentityMode === "transformation"} className={newIdentityMode === "transformation" ? "is-selected" : ""} onClick={() => { setNewIdentityMode("transformation"); setRole("before"); }}><Images size={13} /><span><strong>Before / After</strong><small>Two visual stages</small></span>{newIdentityMode === "transformation" && <Check size={11} />}</button>
        </div>
        {newIdentityMode === "transformation" && <><label>ADD THIS IMAGE TO</label><div className="add-to-identity-roles has-2" role="radiogroup" aria-label="Reference group">
          {(["before", "after"] as const).map((item) => <button type="button" role="radio" aria-checked={creationRole === item} className={creationRole === item ? "is-selected" : ""} key={item} onClick={() => setRole(item)}><span>{creationRole === item && <Check size={10} />}</span><strong>{roleLabel[item]}</strong></button>)}
        </div></>}
        {error && <p className="add-to-identity-error">{error}</p>}
        <button type="button" className={`add-to-identity-submit ${success === "created" ? "is-success" : ""}`} disabled={saving || !newIdentityName.trim() || success === "created"} onClick={() => void create()}>
          {saving ? <span className="generator-spinner" /> : success === "created" ? <Check size={14} /> : <UserRoundPlus size={14} />}
          {saving ? "Creating…" : success === "created" ? "Identity created" : newIdentityMode === "single" ? "Create identity" : `Create & add to ${roleLabel[creationRole]}`}
        </button>
      </div> : personas.length ? <>
        <label>IDENTITY</label>
        <div className={`add-to-identity-picker ${personaPickerOpen ? "is-open" : ""}`}>
          <button type="button" className="add-to-identity-picker-trigger" aria-expanded={personaPickerOpen} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setPersonaPickerOpen((current) => !current); }}>
            <span>{selectedPersona?.avatarUrl ? <img src={selectedPersona.avatarUrl} alt="" /> : <UserRound size={14} />}</span>
            <strong>{selectedPersona?.name || "Choose identity"}</strong>
            <ChevronDown size={13} />
          </button>
          {personaPickerOpen && <div className="add-to-identity-picker-options nowheel">
            {personas.map((persona) => {
              const savedRoles = identityDestinationRoles(persona).filter((item) => identityHasGeneratedAsset(persona, item, sourceAssetId));
              return <button type="button" className={persona.id === selectedPersona?.id ? "is-selected" : ""} key={persona.id} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setPersonaId(persona.id); setRole(identityDestinationRoles(persona)[0] || "reference"); setPersonaPickerOpen(false); setSuccess(null); }}>
              <span>{persona.avatarUrl ? <img src={persona.avatarUrl} alt="" /> : <UserRound size={14} />}</span>
              <span><strong>{persona.name}</strong><small>{savedRoles.length ? `Added to ${savedRoles.map((item) => roleLabel[item]).join(" + ")}` : `${persona.assets.length} reference${persona.assets.length === 1 ? "" : "s"}`}</small></span>
              {persona.id === selectedPersona?.id && <Check size={12} />}
            </button>})}
          </div>}
        </div>

        <button type="button" className="add-to-identity-new" onClick={() => { setCreatingNew(true); setPersonaPickerOpen(false); setNewIdentityName(""); setNewIdentityMode("single"); setRole("reference"); setError(""); setSuccess(null); }}><span><Plus size={12} /></span><span><strong>Create new identity</strong><small>Use this image as the first reference</small></span></button>

        <label>REFERENCE GROUP</label>
        <div className={`add-to-identity-roles has-${roles.length}`} role="radiogroup" aria-label="Reference group">
          {roles.map((item) => {
            const alreadyAdded = identityHasGeneratedAsset(selectedPersona, item, sourceAssetId);
            return <button type="button" role="radio" aria-checked={selectedRole === item} className={`${selectedRole === item ? "is-selected" : ""} ${alreadyAdded ? "is-added" : ""}`} key={item} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setRole(item); setSuccess(null); }}><span>{(selectedRole === item || alreadyAdded) && <Check size={10} />}</span><strong>{roleLabel[item]}</strong>{alreadyAdded && <small>Added</small>}</button>;
          })}
        </div>

        {error && <p className="add-to-identity-error">{error}</p>}
        <button type="button" className={`add-to-identity-submit ${success || selectedAlreadyAdded ? "is-success" : ""} ${selectedAlreadyAdded ? "is-existing" : ""}`} disabled={saving || Boolean(success) || selectedAlreadyAdded} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.preventDefault(); event.stopPropagation(); void add(); }}>
          {saving ? <span className="generator-spinner" /> : success || selectedAlreadyAdded ? <Check size={14} /> : <UserRoundPlus size={14} />}
          {saving ? "Adding…" : success === "added" ? "Added" : success === "existing" || selectedAlreadyAdded ? `Already in ${roleLabel[selectedRole]}` : `Add to ${roleLabel[selectedRole]}`}
        </button>
      </> : <div className="add-to-identity-empty"><UserRound size={18} /><strong>No identities yet</strong><small>Create one in Library first.</small></div>}
    </div>}
  </div>;
}
