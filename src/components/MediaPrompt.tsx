"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

/** One selectable prompt, with disclosure only when its preview overflows. */
export function MediaPrompt({ prompt }: { prompt: string }) {
  const id = useId();
  const text = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [copyState]);
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };
  useEffect(() => {
    const element = text.current;
    if (!element || expanded) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [prompt, expanded]);
  return <section>
    <div className="media-viewer-prompt-head"><label htmlFor={id}>PROMPT</label><button type="button" className="media-viewer-prompt-copy" onClick={copyPrompt} aria-label={copyState === "copied" ? "Prompt copied" : "Copy prompt"} title={copyState === "copied" ? "Copied" : "Copy prompt"}>{copyState === "copied" ? <Check size={12} /> : <Copy size={12} />}</button><span className="media-viewer-prompt-status" role="status">{copyState === "copied" ? "Prompt copied" : copyState === "failed" ? "Could not copy. Select the prompt to copy it." : ""}</span></div>
    <p ref={text} id={id} className={`media-viewer-prompt${expanded ? " is-expanded" : ""}`}>{prompt}</p>
    {(overflows || expanded) && <button type="button" className="media-viewer-prompt-toggle" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>{expanded ? "Show less" : "Show more"}</button>}
  </section>;
}
