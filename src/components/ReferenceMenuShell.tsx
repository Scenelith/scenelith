"use client";

import type { ReactNode, WheelEventHandler } from "react";

export function ReferenceMenuShell({
  attachedLabel,
  capacityTitle,
  capacityDescription,
  children,
  className = "",
  footer,
  ariaLabel = "Choose visual references",
  onScrollWheelCapture,
}: {
  attachedLabel: string;
  capacityTitle: string;
  capacityDescription: string;
  children: ReactNode;
  className?: string;
  footer?: ReactNode;
  ariaLabel?: string;
  onScrollWheelCapture?: WheelEventHandler<HTMLDivElement>;
}) {
  return <div
    className={`generator-reference-menu nodrag nopan nowheel ${className}`.trim()}
    role="dialog"
    aria-modal="false"
    aria-label={ariaLabel}
    onPointerDown={(event) => event.stopPropagation()}
    onPointerMove={(event) => event.stopPropagation()}
    onWheelCapture={(event) => event.stopPropagation()}
    onTouchMove={(event) => event.stopPropagation()}
  >
    <div className="generator-reference-menu-head"><span>REFERENCES</span><b>{attachedLabel}</b></div>
    <div className="generator-reference-capacity"><span>{capacityTitle}</span><small>{capacityDescription}</small></div>
    <div className="generator-reference-scroll nowheel" onWheelCapture={onScrollWheelCapture || ((event) => event.stopPropagation())} onTouchMove={(event) => event.stopPropagation()}>
      {children}
    </div>
    {footer}
  </div>;
}
