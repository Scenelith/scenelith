"use client";

import * as React from "react";
import { motion, usePageInView, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

export interface ImageGenerationProps {
  children: React.ReactNode;
  className?: string;
  startingLabel?: string;
  generatingLabel?: string;
}

export function ImageGeneration({
  children,
  className,
  startingLabel = "Preparing references…",
  generatingLabel = "Creating image. This may take a moment.",
}: ImageGenerationProps) {
  const [loadingState, setLoadingState] = React.useState<"starting" | "generating">("starting");
  const pageInView = usePageInView();
  const reducedMotion = useReducedMotion();
  const animateSweep = pageInView && !reducedMotion;
  const visibleLabel = loadingState === "starting" ? startingLabel : generatingLabel;

  React.useEffect(() => {
    const startingTimeout = window.setTimeout(() => setLoadingState("generating"), 1200);
    return () => window.clearTimeout(startingTimeout);
  }, []);

  return (
    <div className={cn("image-generation-state", className)}>
      <span className="image-generation-label" role="status" aria-live="polite" aria-label={visibleLabel} data-label={visibleLabel} />
      <div className="image-generation-frame">
        {children}
        <div className="image-generation-scrim" aria-hidden="true" />
        <motion.div
          className="image-generation-shimmer"
          aria-hidden="true"
          initial={false}
          animate={animateSweep
            ? { transform: ["translate3d(-160%,0,0) skewX(-12deg)", "translate3d(260%,0,0) skewX(-12deg)"] }
            : { transform: "translate3d(-160%,0,0) skewX(-12deg)" }}
          transition={animateSweep
            ? { repeat: Infinity, repeatDelay: 0.25, duration: 2.4, ease: "linear" }
            : { duration: 0 }}
        />
      </div>
    </div>
  );
}

ImageGeneration.displayName = "ImageGeneration";
