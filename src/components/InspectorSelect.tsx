"use client";

import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type InspectorSelectOption = {
  value: string;
  label: string;
  description?: string;
  group?: string;
  badge?: string;
};

export function InspectorSelect({ value, options, label, onChange, disabled = false }: {
  value: string;
  options: InspectorSelectOption[];
  label: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) || options[0];
  const groups = Array.from(new Set(options.map((option) => option.group || "")));

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutside, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={`inspector-select ${open ? "is-open" : ""}`}>
      <button type="button" className="inspector-select-trigger" aria-label={label} aria-expanded={open} disabled={disabled} onClick={() => setOpen((current) => !current)}>
        <span><span>{selected?.label || value}</span>{selected?.badge && <b className="inspector-select-badge">{selected.badge}</b>}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="inspector-select-menu" role="listbox" aria-label={label} onWheel={(event) => event.stopPropagation()}>
          {groups.map((group) => (
            <div className="inspector-select-group" key={group || "options"}>
              {group && <div className="inspector-select-group-label">{group}</div>}
              {options.filter((option) => (option.group || "") === group).map((option) => (
                <button key={option.value} type="button" role="option" aria-selected={option.value === value} className={option.value === value ? "is-selected" : ""} onClick={() => { onChange(option.value); setOpen(false); }}>
                  <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
                  <span className="inspector-select-option-state">{option.badge && <b className="inspector-select-badge">{option.badge}</b>}{option.value === value && <Check size={13} />}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
