"use client";

import { useRef } from "react";
import { useInView, usePageInView, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

/** Bound SVG paint damage without forcing bitmap resampling at fractional canvas zoom. */
export function GenerationOutline({ className, radius = 26 }: { className?: string; radius?: number }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inView = useInView(rootRef, { initial: true });
  const pageInView = usePageInView();
  const reducedMotion = useReducedMotion();
  const animate = inView && pageInView;
  return <div ref={rootRef} className={cn("generator-running-outline", className)} style={{ willChange: animate && !reducedMotion ? "opacity" : "auto" }} aria-hidden="true">
    <svg className="generator-running-outline-svg">
      <rect className="generator-running-runner" x="2" y="2" width="calc(100% - 4px)" height="calc(100% - 4px)" rx={radius} pathLength="100" style={{ animationPlayState: animate ? "running" : "paused" }} />
    </svg>
  </div>;
}
