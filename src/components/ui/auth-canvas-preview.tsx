"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { ReactFlow, ReactFlowProvider, type NodeTypes } from "@xyflow/react";
import { BarChart3, Bookmark, CalendarDays, Check, Clapperboard, Copy, ExternalLink, Eye, Heart, ImagePlus, LoaderCircle, MessageCircle, MousePointer2, Quote, RefreshCcw, Settings2, Share2, Sparkles, Upload, UserRound, Video, X } from "lucide-react";
import "@xyflow/react/dist/style.css";
import { AssistantGlyph, FrameNodeCard, GeneratorNodeContext, type GeneratorModelOption } from "@/components/FrameNode";
import type { FrameEdge, FrameNode } from "@/lib/types";
import { landingMedia } from "@/lib/public-media";

const nodeTypes: NodeTypes = { frameNode: FrameNodeCard };
const models: GeneratorModelOption[] = [{
  id: "nano-banana-2",
  label: "Nano Banana 2",
  mediaType: "image",
  description: "Fast image generation",
  maxReferences: 14,
  ratios: ["1:1", "4:5", "9:16", "16:9"],
  resolutions: ["1K", "2K", "4K"],
}];

const ASSISTANT_PROMPT = `{
  "title": "Replace the subject in the source scene",
  "task": "Recreate @Screen_01_1 while replacing only the woman with the identity from @Emma_2.",
  "reference_plan": [
    {
      "token": "@Screen_01_1",
      "title": "Screen 01",
      "role": "source composition",
      "instruction": "Preserve the original pose, framing, camera angle, environment and lighting."
    },
    {
      "token": "@Emma_2",
      "title": "Emma",
      "role": "identity",
      "instruction": "Use Emma's facial identity and natural appearance for the woman."
    }
  ],
  "subject": {
    "identity": "@Emma_2",
    "appearance": ["natural skin texture", "dark hair", "black hoodie"],
    "pose": "Match the seated pose and hand placement from @Screen_01_1.",
    "expression": "Calm, candid expression directed toward camera."
  },
  "scene": {
    "environment": "Keep the existing indoor background from @Screen_01_1.",
    "composition": "Preserve the vertical close portrait crop and subject scale.",
    "lighting": "Match the soft natural ambient light of the source.",
    "camera": "Photorealistic smartphone photograph at the original perspective."
  },
  "preserve": ["pose", "composition", "background", "lighting", "wardrobe"],
  "change": ["replace only the woman's identity with @Emma_2"],
  "avoid": ["changing the pose", "beauty-filter skin", "altering the room", "extra fingers"],
  "output": {
    "format": "9:16 vertical image",
    "style": "photorealistic candid social media frame"
  }
}`;

const sourceNode = (position: { x: number; y: number }): FrameNode => ({
  id: "tour-source", type: "frameNode", position, initialWidth: 300, initialHeight: 124,
  data: { kind: "source", title: "pov: you stuck to the plan", subtitle: "slideshow · 2 assets · 663 KB", author: "luisagiuliet", status: "ready" },
});

const slideNode = (id: string, position: { x: number; y: number }, imageUrl: string, title: string, role: string): FrameNode => ({
  id, type: "frameNode", position, initialWidth: 250, initialHeight: 475,
  data: { kind: "scene", title, subtitle: "Original slideshow screen", role, imageUrl, status: "ready", nodeWidth: 250 },
});

function generatorNode(position: { x: number; y: number }, phase: number): FrameNode {
  const referenceAttached = phase >= 5;
  const promptReady = phase >= 10;
  const generated = phase >= 12;
  return {
    id: "tour-generator", type: "frameNode", position, selected: true, initialWidth: 430, initialHeight: 790,
    data: {
      kind: "prompt", title: "Image Generator", subtitle: "Replace subject in scene",
      prompt: promptReady ? ASSISTANT_PROMPT : "",
      mediaType: "image", modelId: "nano-banana-2", aspectRatio: "9:16", resolution: "1K", generationCount: 1,
      nodeWidth: 430, status: "ready",
      attachedReferences: referenceAttached
        ? [{ assetId: "tour-emma", url: landingMedia("emma-reference.webp"), title: "Emma", variant: "after" }]
        : [],
      demoAssistantOpen: phase >= 6 && phase <= 9,
      demoAssistantTypingText: phase === 6
        ? "In this image "
        : phase === 7
          ? "In this image @Screen_01_1, replace the woman with "
          : phase === 8 || phase === 9
            ? "In this image @Screen_01_1, replace the woman with @Emma_2. Preserve the original composition, pose and lighting."
            : undefined,
      demoAssistantReferenceId: phase === 6 ? "tour-slide-1" : phase === 7 ? "tour-emma" : undefined,
      demoAssistantReferenceDelayMs: phase === 6 ? 600 : phase === 7 ? 980 : undefined,
      demoAssistantBuild: phase === 8,
      demoAssistantBusy: phase === 9,
      ...(generated ? { outputUrl: landingMedia("identity-result.webp"), generatedOutputs: [{ url: landingMedia("identity-result.webp"), mediaType: "image" as const, modelId: "nano-banana-2" }], activeGeneratedOutputIndex: 0 } : {}),
    },
  };
}

function imageEdge(id: string, source: string, target: string, sourceHandle: string, targetHandle: string): FrameEdge {
  return { id, source, target, sourceHandle, targetHandle, animated: true, data: { portType: "image" } };
}

function importedGraph(): { nodes: FrameNode[]; edges: FrameEdge[] } {
  return {
    nodes: [
      sourceNode({ x: 210, y: 300 }),
      slideNode("tour-slide-1", { x: 570, y: 20 }, landingMedia("tiktok-hook.webp"), "Screen 01", "HOOK"),
      slideNode("tour-slide-2", { x: 870, y: 20 }, landingMedia("tiktok-result.webp"), "Screen 02", "CTA"),
    ],
    edges: [imageEdge("source-slide-1", "tour-source", "tour-slide-1", "output", "input"), imageEdge("source-slide-2", "tour-source", "tour-slide-2", "output", "input")],
  };
}

function tourGraph(step: number, phase: number, importPhase = 0): { nodes: FrameNode[]; edges: FrameEdge[] } {
  if (step === 0) return importPhase >= 4 ? importedGraph() : { nodes: [], edges: [] };
  if (step === 1) return {
    ...importedGraph(),
  };
  const generatorVisible = phase >= 3;
  const nodes = [
    slideNode("tour-slide-1", { x: 0, y: 55 }, landingMedia("tiktok-hook.webp"), "Screen 01", "COMPOSITION"),
  ];
  if (generatorVisible) nodes.push(generatorNode({ x: 420, y: 0 }, phase));

  const edges: FrameEdge[] = [];
  if (generatorVisible) edges.push(imageEdge("slide-generator", "tour-slide-1", "tour-generator", "output", "image-input"));
  return { nodes, edges };
}

function viewportFor(step: number, pace: "default" | "fast", phase: number) {
  const assistantFocused = step === 2 && phase >= 6 && phase <= 7;
  if (pace === "fast") {
    if (step === 0 || step === 1) return { x: 8, y: 72, zoom: 0.58 };
    if (assistantFocused) return { x: -190, y: -407, zoom: 1.15 };
    return { x: 46, y: -54, zoom: 0.56 };
  }
  if (step === 0 || step === 1) return { x: 8, y: 92, zoom: 0.42 };
  if (assistantFocused) return { x: -190, y: -407, zoom: 1.15 };
  return { x: 34, y: 68, zoom: 0.42 };
}

const TOUR_TIKTOK_URL = "https://www.tiktok.com/@luisagiuliet/photo/7624448391024174367";

function ImportFlowTour({ phase, typedUrl }: { phase: number; typedUrl: string }) {
  if (phase >= 4) return <div className="auth-import-complete"><Check size={14} /><span>2 slides imported to canvas</span></div>;

  return <div className="auth-tour-import-shell" aria-hidden="true">
    <form className={`source-bar auth-tour-source-bar ${phase === 2 ? "is-clicking" : ""}`}>
      <Clapperboard size={16} />
      <input value={typedUrl} readOnly placeholder="Paste a direct TikTok video or slideshow link…" />
      <button type="button" disabled={!typedUrl || phase === 3}>
        {phase === 3 ? <LoaderCircle className="spin" size={15} /> : <Upload size={15} />}
        {phase === 3 ? "Extracting" : "Import"}
        {phase === 2 && <i className="auth-tour-pointer auth-tour-pointer--import"><MousePointer2 size={18} /></i>}
      </button>
    </form>
    {phase === 3 && <div className="auth-tour-import-reading"><LoaderCircle size={14} /><span>Reading slideshow frames</span></div>}
  </div>;
}

type TourAnchors = {
  source?: { x: number; y: number };
  output?: { x: number; y: number };
  reference?: { x: number; y: number };
  generate?: { x: number; y: number };
  assistant?: { x: number; y: number };
};

const anchorStyle = (point?: { x: number; y: number }): CSSProperties | undefined => point
  ? { left: point.x, top: point.y }
  : undefined;

function useTourAnchors(containerRef: RefObject<HTMLDivElement | null>, phase: number) {
  const [anchors, setAnchors] = useState<TourAnchors>({});

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = () => {
      const containerRect = container.getBoundingClientRect();
      const pointFor = (selector: string) => {
        const element = container.querySelector<HTMLElement>(selector);
        if (!element) return undefined;
        const rect = element.getBoundingClientRect();
        return {
          x: rect.left - containerRect.left + rect.width / 2,
          y: rect.top - containerRect.top + rect.height / 2,
        };
      };
      setAnchors({
        source: pointFor('.react-flow__node[data-id="tour-source"] .frame-node'),
        output: pointFor('.react-flow__node[data-id="tour-slide-1"] .scene-next-button'),
        reference: pointFor('.react-flow__node[data-id="tour-generator"] .generator-semantic-port[data-port-id="reference-image"] > button'),
        generate: pointFor('.react-flow__node[data-id="tour-generator"] .generator-run'),
        assistant: pointFor('.react-flow__node[data-id="tour-generator"] .generator-assistant-trigger'),
      });
    };

    const frame = window.requestAnimationFrame(measure);
    const settleTimers = [180, 760].map((delay) => window.setTimeout(measure, delay));
    const viewport = container.querySelector<HTMLElement>(".react-flow__viewport");
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    viewport?.addEventListener("transitionend", measure);
    window.addEventListener("resize", measure);
    return () => {
      window.cancelAnimationFrame(frame);
      settleTimers.forEach((timer) => window.clearTimeout(timer));
      observer.disconnect();
      viewport?.removeEventListener("transitionend", measure);
      window.removeEventListener("resize", measure);
    };
  }, [containerRef, phase]);

  return anchors;
}

function SourceInspectorTour({ containerRef }: { containerRef: RefObject<HTMLDivElement | null> }) {
  const anchors = useTourAnchors(containerRef, 1);
  const [hookPhase, setHookPhase] = useState(0);

  useEffect(() => {
    const timers = [
      window.setTimeout(() => setHookPhase(1), 2050),
      window.setTimeout(() => setHookPhase(2), 2780),
      window.setTimeout(() => setHookPhase(3), 3480),
    ];
    return () => timers.forEach(window.clearTimeout);
  }, []);

  return <div className="auth-tour-overlay auth-tour-source-inspection" aria-hidden="true">
    <div className="auth-tour-pointer auth-tour-pointer--source" style={anchorStyle(anchors.source)}><MousePointer2 size={18} /></div>
    <aside className="inspector inspector-source auth-tour-source-inspector">
      <div className="inspector-head"><div><p className="eyebrow">SOURCE · TIKTOK</p><h2>Post details</h2></div><button className="icon-button" aria-label="Close inspector"><X size={15} /></button></div>
      <div className="inspector-body">
        <div className="inspector-title-field"><label className="field-label">Name</label><input className="panel-input" value="pov: you stuck to the plan" readOnly /></div>
        <div className="post-insights">
          <div className="post-insights-head"><span><BarChart3 size={14} /><strong>Publication</strong></span><button title="Refresh TikTok stats"><RefreshCcw size={13} /></button></div>
          <div className="post-link-box"><span>tiktok.com/@luisagiuliet/photo/762444…</span><button title="Copy post link"><Copy size={13} /></button><span title="Open TikTok"><ExternalLink size={13} /></span></div>
          <div className="post-meta"><span>@luisagiuliet</span><span><CalendarDays size={12} />Jul 28, 2026</span></div>
          <div className="post-stat-grid">
            <div><Eye size={14} /><strong>1.8M</strong><span>Views</span></div>
            <div><Heart size={14} /><strong>214K</strong><span>Likes</span></div>
            <div><MessageCircle size={14} /><strong>1.6K</strong><span>Comments</span></div>
            <div><Share2 size={14} /><strong>18K</strong><span>Shares</span></div>
            <div><Bookmark size={14} /><strong>42K</strong><span>Saves</span></div>
          </div>
        </div>
        <div className="source-hook-card">
          <div className="source-hook-head"><span><Quote size={13} />Extracted hook</span><div className="source-hook-head-actions">{hookPhase === 3 && <button title="Copy generated hook"><Copy size={13} /></button>}<button title="Edit generation role"><Settings2 size={13} /></button><button className="auth-tour-hook-generate" title="Regenerate hook variant"><RefreshCcw className={hookPhase === 2 ? "spin" : ""} size={13} />{hookPhase === 1 && <i className="auth-tour-pointer auth-tour-pointer--hook"><MousePointer2 size={17} /></i>}</button></div></div>
          <p className="source-hook-original">pov: you stuck to the plan</p>
          <div className={`source-hook-result ${hookPhase === 3 ? "has-result" : ""}`}><span>AI result</span><p>{hookPhase === 2 ? "Generating a new hook…" : hookPhase === 3 ? "pov: you became the person who actually sticks to the plan" : "Not generated yet"}</p></div>
        </div>
      </div>
    </aside>
  </div>;
}

function BuildFlowOverlay({ phase, containerRef }: { phase: number; containerRef: RefObject<HTMLDivElement | null> }) {
  const anchors = useTourAnchors(containerRef, phase);

  if (phase === 0) {
    return <div className="auth-tour-pointer auth-tour-pointer--output" style={anchorStyle(anchors.output)} aria-hidden="true"><MousePointer2 size={18} /></div>;
  }

  if (phase === 1 || phase === 2) {
    return <div className="auth-tour-overlay" aria-hidden="true">
      <div className="auth-tour-click auth-tour-click--output" style={anchorStyle(anchors.output)}><MousePointer2 size={17} /></div>
      <div className={`auth-tour-node-menu ${phase === 2 ? "is-choosing" : ""}`} style={anchors.output ? { left: anchors.output.x + 18, top: Math.max(12, anchors.output.y - 24) } : undefined}>
        <div className="auth-tour-node-menu-head"><span>Continue from image</span><X size={13} /></div>
        <div className="auth-tour-node-option is-image">
          <span className="node-creator-icon image"><ImagePlus size={16} /></span>
          <span><strong>Image Generator</strong><small>Use this scene as composition</small></span>
          {phase === 2 && <div className="auth-tour-pointer auth-tour-pointer--inside-option"><MousePointer2 size={18} /></div>}
        </div>
        <div className="auth-tour-node-option">
          <span className="node-creator-icon video"><Video size={16} /></span>
          <span><strong>Video Generator</strong><small>Animate this scene</small></span>
        </div>
        <div className="auth-tour-node-option">
          <span className="node-creator-icon assistant"><AssistantGlyph size={16} /></span>
          <span><strong>Assistant</strong><small>Build a prompt from this scene</small></span>
        </div>
      </div>
    </div>;
  }

  if (phase === 3) {
    return <div className="auth-tour-pointer auth-tour-pointer--reference" style={anchorStyle(anchors.reference)} aria-hidden="true"><MousePointer2 size={18} /></div>;
  }

  if (phase === 4) {
    return <div className="auth-tour-overlay" aria-hidden="true">
      <div className="auth-tour-reference-picker" style={anchors.reference ? { left: Math.max(12, anchors.reference.x - 262), top: Math.max(12, anchors.reference.y - 108) } : undefined}>
        <div className="auth-tour-reference-head"><span>Add reference</span><b>0 / 14</b></div>
        <div className="auth-tour-reference-label">SAVED IDENTITIES</div>
        <div className="auth-tour-reference-option is-selecting">
          <img src={landingMedia("emma-reference.webp")} alt="" />
          <span><strong>Emma · identity</strong><small>Saved identity reference</small></span>
          <UserRound size={15} />
          <div className="auth-tour-pointer auth-tour-pointer--inside-reference"><MousePointer2 size={18} /></div>
        </div>
      </div>
    </div>;
  }

  if (phase === 5) {
    return <div className="auth-tour-pointer auth-tour-pointer--assistant" style={anchorStyle(anchors.assistant)} aria-hidden="true"><MousePointer2 size={18} /></div>;
  }

  if (phase >= 6 && phase <= 9) return null;

  if (phase === 10) {
    return <div className="auth-tour-pointer auth-tour-pointer--generate" style={anchorStyle(anchors.generate)} aria-hidden="true"><MousePointer2 size={18} /></div>;
  }

  if (phase === 11) return <div className="auth-tour-ready auth-tour-generating" aria-hidden="true"><LoaderCircle size={14} /><span>Generating new scene</span></div>;

  return <div className="auth-tour-ready" aria-hidden="true"><Check size={14} /><span>New scene generated</span></div>;
}

export default function AuthCanvasPreview({ activeStep, buildPhase = 0, pace = "default" }: { activeStep: number; buildPhase?: number; pace?: "default" | "fast" }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [importPhase, setImportPhase] = useState(0);
  const [typedImportUrl, setTypedImportUrl] = useState("");
  const graph = useMemo(() => tourGraph(activeStep, buildPhase, importPhase), [activeStep, buildPhase, importPhase]);

  useEffect(() => {
    if (activeStep !== 0) return;
    queueMicrotask(() => {
      setImportPhase(0);
      setTypedImportUrl("");
    });
    const timers: number[] = [];
    const importTiming = pace === "fast" ? [180, 620, 980, 1750] : [720, 1650, 2250, 3850];
    timers.push(window.setTimeout(() => {
      setImportPhase(1);
      setTypedImportUrl(TOUR_TIKTOK_URL);
    }, importTiming[0]));
    timers.push(window.setTimeout(() => setImportPhase(2), importTiming[1]));
    timers.push(window.setTimeout(() => setImportPhase(3), importTiming[2]));
    timers.push(window.setTimeout(() => setImportPhase(4), importTiming[3]));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [activeStep, pace]);
  const actions = useMemo(() => ({
    models, personas: [], selectNode: () => undefined, focusMasterClipSource: () => undefined, updateNode: () => undefined, saveNow: () => undefined, composePrompt: async () => "", composeMasterPrompt: async () => "", generateNode: () => undefined, generateMasterClip: () => undefined, updateMasterClipModel: () => undefined, removeMasterClip: () => undefined, uploadMasterClips: () => undefined, downloadMasterMedia: async () => false, captureVideoFrame: async () => undefined, extractVideoSegment: () => undefined,
    runAssistant: () => undefined, generateChain: () => undefined, openPreview: () => undefined, openEdit: () => undefined, addToIdentity: async () => ({}), createIdentityFromAsset: async () => undefined, deleteNode: () => undefined,
    hasDownstreamGenerator: () => false, disconnectReference: () => undefined,
    getReferences: (nodeId: string) => {
      const node = graph.nodes.find((item) => item.id === nodeId);
      const connectedScene = nodeId === "tour-generator" ? [{
        id: "tour-slide-1",
        assetId: "tour-slide-1",
        sourceNodeId: "tour-slide-1",
        url: landingMedia("tiktok-hook.webp"),
        title: "Screen 01",
        removable: false,
      }] : [];
      const attached = (node?.data.attachedReferences || []).map((reference) => ({
        id: reference.assetId,
        assetId: reference.assetId,
        url: reference.url,
        title: reference.title,
        variant: reference.variant,
        removable: true,
      }));
      return [...connectedScene, ...attached];
    },
    getTextInput: () => null,
    generatingNodeIds: activeStep === 2 && buildPhase === 11 ? ["tour-generator"] : [],
    preparingMasterClipIds: {},
    generationConcurrency: 2,
    queueLabel: "instance",
    runningAssistantNodeId: null,
    activePreviewNodeId: null,
  }), [activeStep, buildPhase, graph.nodes]);

  const assistantFocused = activeStep === 2 && buildPhase >= 6 && buildPhase <= 7;

  return <div ref={containerRef} className={`auth-canvas-preview is-step-${activeStep} is-pace-${pace}${assistantFocused ? " is-assistant-focus" : ""}`} aria-label="Animated Frameflow TikTok workflow">
    {activeStep === 0 && <ImportFlowTour phase={importPhase} typedUrl={typedImportUrl} />}
    {activeStep === 1 && <><div className="auth-import-complete"><Check size={14} /><span>2 slides imported to canvas</span></div><SourceInspectorTour containerRef={containerRef} /></>}
    {activeStep === 2 && <BuildFlowOverlay phase={buildPhase} containerRef={containerRef} />}
    <GeneratorNodeContext.Provider value={actions}>
      <ReactFlowProvider>
        <ReactFlow nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} viewport={viewportFor(activeStep, pace, buildPhase)} onViewportChange={() => undefined}
          nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} panOnDrag={false} zoomOnDoubleClick={false} zoomOnPinch={false} zoomOnScroll={false} preventScrolling={false} proOptions={{ hideAttribution: true }} />
      </ReactFlowProvider>
    </GeneratorNodeContext.Provider>
  </div>;
}
