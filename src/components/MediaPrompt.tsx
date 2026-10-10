"use client";

import { useEffect, useId, useRef, useState } from "react";

/** One selectable prompt, with disclosure only when its preview overflows. */
export function MediaPrompt({ prompt }: { prompt: string }) {
  const id = useId();
  const text = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
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
    <label htmlFor={id}>PROMPT</label>
    <p ref={text} id={id} className={`media-viewer-prompt${expanded ? " is-expanded" : ""}`}>{prompt}</p>
    {(overflows || expanded) && <button type="button" className="media-viewer-prompt-toggle" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>{expanded ? "Show less" : "Show full prompt"}</button>}
  </section>;
}
