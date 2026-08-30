"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

export function CopyMcpUrl({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" onClick={async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? "Copied" : "Copy MCP link"}</button>;
}
