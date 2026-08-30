"use client";

import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number; width: number; maxHeight: number; placement: "above" | "below" } | null>(null);
  const selected = options.find((option) => option.value === value) || options[0];
  const groups = Array.from(new Set(options.map((option) => option.group || "")));

  const positionMenu = () => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const gap = 6;
    const viewportPadding = 10;
    const below = window.innerHeight - rect.bottom - viewportPadding - gap;
    const above = rect.top - viewportPadding - gap;
    const placement = below >= Math.min(220, above) ? "below" : "above";
    const maxHeight = Math.max(120, Math.min(300, placement === "below" ? below : above));
    setMenuPosition({
      left: Math.max(viewportPadding, Math.min(rect.left, window.innerWidth - rect.width - viewportPadding)),
      top: placement === "below" ? rect.bottom + gap : rect.top - gap,
      width: rect.width,
      maxHeight,
      placement,
    });
  };

  useEffect(() => {
    if (!open) return;
    positionMenu();
    const updatePosition = () => positionMenu();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
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
      {open && menuPosition && createPortal(
        <div
          ref={menuRef}
          className={`inspector-select-menu is-portal is-${menuPosition.placement}`}
          role="listbox"
          aria-label={label}
          style={{ left: menuPosition.left, top: menuPosition.top, width: menuPosition.width, maxHeight: menuPosition.maxHeight }}
          onWheel={(event) => event.stopPropagation()}
        >
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
        </div>,
        document.body,
      )}
    </div>
  );
}
