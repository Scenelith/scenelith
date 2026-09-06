"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";

export function MasterModelSwitchDialog({ choice, onCancel, onConfirm }: {
  choice: { label: string; inputs: string[] };
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancel.current?.focus();
    const frame = requestAnimationFrame(() => cancel.current?.focus());
    return () => { cancelAnimationFrame(frame); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onCancel();
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [onCancel]);
  return <div className="modal-backdrop master-model-switch-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <section ref={dialog} className="modal project-create-modal" role="dialog" aria-modal="true" aria-labelledby="master-model-switch-title" onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); onCancel(); }
      if (event.key === "Tab") {
        const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>("button") || []);
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <div className="modal-head"><h2 id="master-model-switch-title">Switch to {choice.label}?</h2><button type="button" className="icon-button" aria-label="Cancel model change" onClick={onCancel}><X size={16} /></button></div>
      <p>This model does not support these inputs. Switching will disconnect them from this scene:</p>
      <ul className="master-model-switch-inputs">{choice.inputs.map((input, index) => <li key={index}>{input}</li>)}</ul>
      <p>The ORIGINAL clip and generated results stay in the timeline.</p>
      <button className="primary-button" type="button" onClick={onConfirm}>Disconnect incompatible inputs and switch</button>
      <button ref={cancel} className="secondary-button" type="button" onClick={onCancel}>Cancel</button>
    </section>
  </div>;
}
