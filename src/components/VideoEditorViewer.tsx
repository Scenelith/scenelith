"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRightLeft, Check, ChevronDown, Download, ImageIcon, Images, Link2, Play, Plus, Trash2, UserRound, Video, Volume2, X } from "lucide-react";
import type { FrameNode, PersonaRecord, VideoMasterClip, VideoSceneSegment } from "@/lib/types";
import { masterClipOriginalReference, moveUploadedMasterClipToLane, nearestVideoMasterRatio, reconciledVideoMasterClipDuration, reconciledVideoMasterGeneratedDuration, useVideoMasterGeneratedOutput as applyVideoMasterGeneratedOutput, videoMasterClipPlaybackMedia, videoMasterClipThumbnail, videoMasterGeneratedOutputs, videoMasterGenerationDuration, videoMasterGenerationDurationChoices, videoMasterModelsForScene, videoMasterSourceRatio, videoMasterTimelineDuration, type VideoMasterDownloadLane, type VideoMasterGeneratedOutput } from "@/lib/video-master";
import { assetThumbnailUrl, CanvasVideoPlayer, GeneratorReferencePreview, generatorModelCreditDescription, generatorRatiosFor, generatorReferenceRoleLabels, VideoMasterGenerationControls, VideoMasterTimeline, type GeneratorModelOption, type SelectOption } from "./FrameNode";
import { VideoSceneTimeline } from "./VideoSceneTimeline";
import { videoPlaybackManager } from "@/lib/video-playback-owner";
import { editorPlaybackUrl } from "@/lib/editor-media";
import { VideoMasterPlayer } from "@/components/VideoMasterPlayer";

type Lane = "output" | "original";

export type VideoEditorReference = {
  id: string;
  edgeId?: string;
  url: string;
  thumbnailUrl?: string;
  title: string;
  assetId?: string;
  sourceNodeId?: string;
  removable?: boolean;
  role?: string;
  durationSeconds?: number;
  mediaType?: "image" | "video" | "audio";
};

function preciseTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00.000";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(3).padStart(6, "0")}`;
}

export function VideoEditorViewer({
  node,
  url,
  videoStart = 0,
  videoEnd,
  onClose,
  onUpdateNode,
  onExtractSegment,
  onCaptureFrame,
  onUploadMasterClips,
  models = [],
  masterReferences = () => [],
  masterReferenceLibrary = [],
  personas = [],
  onDisconnectMasterReference,
  onGenerateMasterClip,
  onDownloadMaster,
  onDeleteNode,
}: {
  node: FrameNode;
  url: string;
  videoStart?: number;
  videoEnd?: number;
  onClose: () => void;
  onUpdateNode: (patch: Partial<FrameNode["data"]>) => void;
  onExtractSegment: (segment: VideoSceneSegment, clientX: number, clientY: number) => void;
  onCaptureFrame: (time: number) => Promise<void>;
  onUploadMasterClips: (files: File[]) => void;
  models?: GeneratorModelOption[];
  masterReferences?: (clipId: string) => VideoEditorReference[];
  masterReferenceLibrary?: VideoEditorReference[];
  personas?: PersonaRecord[];
  onDisconnectMasterReference?: (reference: VideoEditorReference) => void;
  onGenerateMasterClip?: (clipId: string) => void;
  onDownloadMaster?: (lane: VideoMasterDownloadLane, scope: "scene" | "video") => Promise<boolean>;
  onDeleteNode?: () => void;
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const isMaster = node.data.kind === "videoMaster";
  const isSourceEditor = node.data.kind === "source" && Boolean(node.data.videoSegments?.length);

  return <div className="video-editor-viewer-backdrop nodrag nopan" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className={`video-editor-viewer ${isMaster ? "is-master" : isSourceEditor ? "is-source" : "is-clip"}`} role="dialog" aria-modal="true" aria-label={`${node.data.title} video editor`}>
      <button type="button" className="video-editor-viewer-back" aria-label="Back to canvas" onClick={onClose}><ArrowLeft size={17} /></button>
      <button type="button" className="video-editor-viewer-close" aria-label="Close editor" onClick={onClose}><X size={17} /></button>
      <div className="video-editor-viewer-body">
        {isMaster
          ? <MasterFullscreenEditor node={node} onUpdateNode={onUpdateNode} onUpload={onUploadMasterClips} models={models} referencesForClip={masterReferences} referenceLibrary={masterReferenceLibrary} personas={personas} onDisconnectReference={onDisconnectMasterReference} onGenerateClip={onGenerateMasterClip} onDownload={onDownloadMaster} onDeleteNode={onDeleteNode} onClose={onClose} />
          : isSourceEditor
            ? <SourceFullscreenEditor node={node} onUpdateNode={onUpdateNode} onExtractSegment={onExtractSegment} onCaptureFrame={onCaptureFrame} />
            : <ClipFullscreenPlayer node={node} url={url} videoStart={videoStart} videoEnd={videoEnd} />}
      </div>
    </section>
  </div>;
}

function ViewerSidebar({ title, eyebrow, children }: {
  title: string;
  eyebrow: string;
  children: ReactNode;
}) {
  return <aside className="media-viewer-details video-editor-viewer-details">
    <div className="media-viewer-context"><strong>{title}</strong><span>{eyebrow}</span></div>
    {children}
  </aside>;
}

function ViewerAmbient({ imageUrl }: { imageUrl?: string }) {
  if (!imageUrl) return null;
  return <div className="video-editor-viewer-ambient" style={{ backgroundImage: `url("${assetThumbnailUrl(imageUrl)}")` }} aria-hidden="true" />;
}

function SourceFullscreenEditor({ node, onUpdateNode, onExtractSegment, onCaptureFrame }: {
  node: FrameNode;
  onUpdateNode: (patch: Partial<FrameNode["data"]>) => void;
  onExtractSegment: (segment: VideoSceneSegment, clientX: number, clientY: number) => void;
  onCaptureFrame: (time: number) => Promise<void>;
}) {
  const segments = node.data.videoSegments || [];
  const outputSelection = node.data.videoOutputSelection === "full" || segments.some((segment) => segment.id === node.data.videoOutputSelection)
    ? String(node.data.videoOutputSelection || "full")
    : "full";

  const selectedOutput = outputSelection === "full" ? "Full video" : segments.find((segment) => segment.id === outputSelection)?.label || "Full video";

  const ambientSegment = outputSelection === "full" ? segments[0] : segments.find((segment) => segment.id === outputSelection);
  const sourceUrl = String(node.data.imageUrl || node.data.sourceUrl || "");

  return <div className="video-editor-viewer-layout">
    <ViewerAmbient imageUrl={ambientSegment?.thumbnailUrl} />
    <div className="video-editor-viewer-source-workspace">
      <VideoSceneTimeline
        nodeId={node.id}
        src={sourceUrl}
        title={node.data.title}
        selected
        segments={segments}
        detectedSegments={node.data.videoDetectedSegments}
        durationHint={node.data.videoDurationSeconds}
        timelineSprite={node.data.videoTimelineSprite}
        outputSelection={outputSelection}
        hoverPlayback={false}
        onOutputSelectionChange={(videoOutputSelection) => onUpdateNode({ videoOutputSelection })}
        onChange={(videoSegments, videoDurationSeconds) => onUpdateNode({ videoSegments, videoDurationSeconds })}
        onOpenPreview={() => undefined}
        onAspectRatio={(videoAspectRatio) => onUpdateNode({ videoAspectRatio })}
        onExtractSegment={onExtractSegment}
        onCaptureFrame={onCaptureFrame}
      />
    </div>
    <ViewerSidebar title={node.data.title} eyebrow="Source editor">
      <section>
        <label>SETTINGS</label>
        <div className="media-viewer-chips"><span>{segments.length} scenes</span><span>{preciseTime(Number(node.data.videoDurationSeconds || segments.at(-1)?.end || 0))}</span><span>{selectedOutput}</span></div>
      </section>
      <section>
        <label>Playback</label>
        <p>Click the video or the play button to start. Click the video again to pause.</p>
      </section>
      <div className="video-editor-viewer-sidebar-spacer" />
      <small className="video-editor-viewer-sidebar-hint">Scene edits stay synced with the canvas node.</small>
    </ViewerSidebar>
  </div>;
}

function MasterFullscreenEditor({ node, onUpdateNode, onUpload, models, referencesForClip, referenceLibrary, personas, onDisconnectReference, onGenerateClip, onDownload, onDeleteNode, onClose }: {
  node: FrameNode;
  onUpdateNode: (patch: Partial<FrameNode["data"]>) => void;
  onUpload: (files: File[]) => void;
  models: GeneratorModelOption[];
  referencesForClip: (clipId: string) => VideoEditorReference[];
  referenceLibrary: VideoEditorReference[];
  personas: PersonaRecord[];
  onDisconnectReference?: (reference: VideoEditorReference) => void;
  onGenerateClip?: (clipId: string) => void;
  onDownload?: (lane: VideoMasterDownloadLane, scope: "scene" | "video") => Promise<boolean>;
  onDeleteNode?: () => void;
  onClose: () => void;
}) {
  const clips = useMemo(() => [...(node.data.videoMasterClips || [])].sort((left, right) => Number(left.sequenceIndex ?? 0) - Number(right.sequenceIndex ?? 0)), [node.data.videoMasterClips]);
  const [selectedClipId, setSelectedClipId] = useState(node.data.videoMasterSelectedClipId || clips[0]?.id || "");
  const [selectedLane, setSelectedLane] = useState<Lane>("output");
  const [laneVisibility, setLaneVisibility] = useState({ output: true, original: true });
  const [relativeTime, setRelativeTime] = useState(0);
  const [sequencePlaying, setSequencePlaying] = useState(false);
  const [playRequest, setPlayRequest] = useState<{ token: number; clipId: string; lane: Lane; relativeTime: number } | null>(null);
  const [seekRequest, setSeekRequest] = useState<{ clipId: string; time: number; version: number } | null>(null);
  const [controlsHost, setControlsHost] = useState<HTMLDivElement | null>(null);
  const [sidebarTab, setSidebarTab] = useState<"scene" | "outputs">("scene");
  const [outputScope, setOutputScope] = useState<"scene" | "all">("scene");
  const [moveOutputKey, setMoveOutputKey] = useState("");
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [openGeneratorMenu, setOpenGeneratorMenu] = useState<string | null>(null);
  const [referenceMenuPortId, setReferenceMenuPortId] = useState("reference-image");
  const [referencePersonaId, setReferencePersonaId] = useState("");
  const [referencePersonaPickerOpen, setReferencePersonaPickerOpen] = useState(false);
  const playbackTargetRef = useRef(`${node.data.videoMasterSelectedClipId || clips[0]?.id || ""}:output`);
  const playbackOwnerId = `video-master:${node.id}`;
  const selectedClip = clips.find((clip) => clip.id === selectedClipId) || clips[0];
  const selectedIndex = Math.max(0, clips.findIndex((clip) => clip.id === selectedClip?.id));
  const playbackDurations = clips.map((clip) => videoMasterClipPlaybackMedia(clip, selectedLane, laneVisibility).duration);
  const totalDuration = Math.max(.1, playbackDurations.reduce((sum, duration) => sum + duration, 0));
  const selectedOffset = playbackDurations.slice(0, selectedIndex).reduce((sum, duration) => sum + duration, 0);
  const selectedMedia = videoMasterClipPlaybackMedia(selectedClip, selectedLane, laneVisibility);
  const selectedReferences = selectedClip ? referencesForClip(selectedClip.id) : [];
  const originalSceneReference = masterClipOriginalReference(selectedClip);
  const displayReferences = originalSceneReference ? selectedReferences.filter((reference) => !(reference.role === "reference-video" && (
    Boolean(reference.assetId && reference.assetId === originalSceneReference.assetId)
    || reference.url === originalSceneReference.url
  ))) : selectedReferences;
  const visibleSceneReferences: VideoEditorReference[] = originalSceneReference
    ? [{ ...originalSceneReference, mediaType: "video", removable: false }, ...displayReferences]
    : displayReferences;
  const availableModels = videoMasterModelsForScene(models, selectedClip, selectedReferences);
  const selectedModel = availableModels.find((model) => model.id === selectedClip?.modelId) || availableModels[0] || models.find((model) => model.mediaType === "video");
  const selectedRatios = generatorRatiosFor(selectedModel, selectedClip?.resolution, selectedReferences.length > 0).filter((ratio) => ratio !== "source");
  const originalRatio = nearestVideoMasterRatio(videoMasterSourceRatio(selectedClip, Number(node.data.videoAspectRatio)), selectedRatios);
  const selectedRatio = selectedClip?.aspectRatioMode === "custom" ? selectedClip.aspectRatio || originalRatio : originalRatio;
  const timelineDuration = videoMasterTimelineDuration(selectedClip);
  const generationDuration = videoMasterGenerationDuration(selectedModel, selectedClip);
  const generatedAudioEnabled = selectedClip?.generateAudio ?? selectedModel?.defaultGenerateAudio ?? false;
  const resolutions = selectedModel?.resolutions?.length ? selectedModel.resolutions : ["720p"];
  const ratioOptions: SelectOption[] = selectedClip ? [
    { value: "original", label: `Original · ${originalRatio}`, description: "Match this source clip", glyphValue: "original" },
    ...selectedRatios.filter((ratio) => /^\d+:\d+$/.test(ratio)).map((ratio) => ({ value: ratio, label: ratio, glyphValue: ratio })),
  ] : [];
  const modelOptions: SelectOption[] = availableModels.map((model) => ({
    value: model.id,
    label: model.label,
    description: generatorModelCreditDescription(model, {
      duration: String(videoMasterGenerationDuration(model, selectedClip) || timelineDuration),
      referenceCount: selectedReferences.length,
      generateAudio: model.id === selectedModel?.id ? generatedAudioEnabled : model.defaultGenerateAudio,
      hasVideoInput: selectedReferences.some((reference) => reference.role === "reference-video" || reference.role === "motion-video"),
      inputVideoDurationSeconds: timelineDuration,
    }),
  }));
  const durationOptions: SelectOption[] = videoMasterGenerationDurationChoices(selectedModel, selectedClip).map((duration) => ({
    value: String(duration),
    label: `${duration}s`,
    description: duration < timelineDuration - .01 ? `Uses first ${duration}s of this scene` : undefined,
  }));
  const missingRequiredInputs = (selectedModel?.inputPorts || []).filter((port) => port.required && !selectedReferences.some((reference) => reference.role === port.id));
  const masterHasActiveGeneration = Boolean(node.data.videoMasterGeneratingClipId && (node.data.status === "queued" || node.data.status === "working"));
  const masterBusy = Boolean(selectedClip && node.data.videoMasterGeneratingClipId === selectedClip.id && masterHasActiveGeneration);
  const selectedReferenceKeys = new Set(selectedReferences.map((reference) => `${reference.assetId || reference.id}:${reference.role || ""}`));
  const inputPorts = selectedModel?.inputPorts || [];
  const maxReferences = selectedModel?.maxReferences || inputPorts.reduce((sum, port) => sum + Math.max(1, Number(port.max || 1)), 0) || 1;
  const activeReferencePort = inputPorts.find((port) => port.id === referenceMenuPortId) || inputPorts[0];
  const originalSceneVideoPortId = inputPorts.find((port) => port.id === "reference-video")?.id
    || inputPorts.find((port) => port.kind === "video")?.id;
  const referencesForPort = (port: NonNullable<typeof activeReferencePort>) => visibleSceneReferences.filter((reference) =>
    reference.role === port.id
    || (reference.removable === false && reference.role === "reference-video" && port.id === originalSceneVideoPortId));
  const activePortReferences = activeReferencePort ? referencesForPort(activeReferencePort) : [];
  const attachedReferences = selectedClip?.attachedReferences || [];
  const attachedReferenceIds = new Set(attachedReferences.map((reference) => reference.assetId));
  const attachedPersonaId = attachedReferences.find((reference) => reference.personaId && personas.some((persona) => persona.id === reference.personaId))?.personaId || "";
  const selectedReferencePersona = personas.find((persona) => persona.id === referencePersonaId)
    || personas.find((persona) => persona.id === attachedPersonaId)
    || personas[0]
    || null;
  const availableReferences = referenceLibrary.filter((reference) => !selectedReferences.some((selectedReference) => (
    Boolean(reference.assetId && selectedReference.assetId === reference.assetId)
    || Boolean(reference.sourceNodeId && selectedReference.sourceNodeId === reference.sourceNodeId)
  )));
  const outputEntries = clips.flatMap((clip, clipIndex) => videoMasterGeneratedOutputs(clip).map((output, outputIndex) => ({ clip, clipIndex, output, outputIndex })));
  const selectedOutputCount = videoMasterGeneratedOutputs(selectedClip).length;
  const visibleOutputEntries = outputScope === "all" ? outputEntries : outputEntries.filter((entry) => entry.clip.id === selectedClip?.id);
  const masterPlaybackSources = clips.flatMap((clip) => [
    videoMasterClipPlaybackMedia(clip, "original", { output: false, original: true }).url,
    videoMasterClipPlaybackMedia(clip, "output", { output: true, original: false }).url,
  ]).filter(Boolean);
  const currentTime = Math.min(totalDuration, Math.max(0, selectedOffset + relativeTime));
  const nextClip = clips[selectedIndex + 1];
  const nextMedia = videoMasterClipPlaybackMedia(nextClip, selectedLane, laneVisibility);
  const seamlessNext = Boolean(nextMedia.url
    && editorPlaybackUrl(nextMedia.url) === editorPlaybackUrl(selectedMedia.url)
    && Math.abs(selectedMedia.end - nextMedia.start) <= .04);

  const queuePlay = (clipId: string, lane: Lane, nextRelativeTime: number) => {
    setPlayRequest((current) => ({
      token: (current?.token || 0) + 1,
      clipId,
      lane,
      relativeTime: Math.max(0, nextRelativeTime),
    }));
  };

  const persistClips = (next: VideoMasterClip[], selectedPatch?: VideoMasterClip) => onUpdateNode({
    videoMasterClips: next.map((clip, sequenceIndex) => ({ ...clip, sequenceIndex })),
    ...(selectedPatch ? { videoMasterSelectedClipId: selectedPatch.id, prompt: selectedPatch.prompt, modelId: selectedPatch.modelId, duration: String(selectedPatch.duration) } : {}),
  });

  const selectClip = (clip: VideoMasterClip, lane: Lane, continuePlayback = false, nextRelativeTime = 0, explicitPlayback = false, continuousPlayback = false) => {
    const duration = videoMasterClipPlaybackMedia(clip, lane, laneVisibility).duration;
    const safeTime = Math.min(duration, Math.max(0, nextRelativeTime));
    playbackTargetRef.current = `${clip.id}:${lane}`;
    setSelectedClipId(clip.id);
    setSelectedLane(lane);
    setRelativeTime(safeTime);
    setSequencePlaying(continuePlayback || explicitPlayback);
    setSeekRequest(null);
    setOpenGeneratorMenu(null);
    setReferencePersonaPickerOpen(false);
    if (continuePlayback || explicitPlayback) {
      videoPlaybackManager.play(playbackOwnerId, `${clip.id}:${lane}`, {
        relativeTime: safeTime,
        intent: continuePlayback && !explicitPlayback ? "sequence" : "manual",
        continuous: continuousPlayback,
      });
      queuePlay(clip.id, lane, safeTime);
    }
    onUpdateNode({ videoMasterSelectedClipId: clip.id, prompt: clip.prompt, modelId: clip.modelId, duration: String(clip.duration) });
  };

  const seekTimeline = (nextTime: number) => {
    if (sequencePlaying) videoPlaybackManager.pause(playbackOwnerId, `${selectedClip?.id || ""}:${selectedLane}`);
    setSequencePlaying(false);
    setPlayRequest(null);
    const targetTime = Math.min(totalDuration, Math.max(0, nextTime));
    let offset = 0;
    let targetIndex = clips.length - 1;
    for (let index = 0; index < clips.length; index += 1) {
      const duration = playbackDurations[index] || .1;
      if (targetTime < offset + duration || index === clips.length - 1) { targetIndex = index; break; }
      offset += duration;
    }
    const target = clips[targetIndex];
    if (!target) return;
    const targetRelativeTime = Math.min(playbackDurations[targetIndex] || .1, Math.max(0, targetTime - offset));
    if (target.id !== selectedClip?.id) selectClip(target, selectedLane, false, targetRelativeTime);
    else {
      setRelativeTime(targetRelativeTime);
      setSeekRequest((current) => ({ clipId: target.id, time: targetRelativeTime, version: (current?.version || 0) + 1 }));
    }
  };

  const updateSelectedClip = (patch: Partial<VideoMasterClip>) => {
    if (!selectedClip) return;
    const next = clips.map((clip) => clip.id === selectedClip.id ? { ...clip, ...patch } : clip);
    onUpdateNode({
      videoMasterClips: next.map((clip, sequenceIndex) => ({ ...clip, sequenceIndex })),
      ...(patch.prompt !== undefined ? { prompt: String(patch.prompt) } : {}),
      ...(patch.duration !== undefined ? { duration: String(patch.duration) } : {}),
    });
  };

  const applyOutput = (targetClipId: string, output: VideoMasterGeneratedOutput, selectTarget = true) => {
    const next = applyVideoMasterGeneratedOutput(clips, targetClipId, output);
    const target = next.find((clip) => clip.id === targetClipId);
    if (!target) return;
    persistClips(next, selectTarget ? target : undefined);
    if (selectTarget) selectClip(target, "output");
    setMoveOutputKey("");
  };

  const attachReference = (
    reference: VideoEditorReference,
    targetPort: (typeof inputPorts)[number] | null = activeReferencePort,
  ) => {
    if (!selectedClip || !reference.assetId) return;
    const referenceKind = reference.mediaType === "video" ? "video" : reference.mediaType === "audio" ? "audio" : "image";
    const port = targetPort?.kind === referenceKind
      ? targetPort
      : selectedModel?.inputPorts?.find((candidate) => candidate.kind === referenceKind);
    if (!port) return;
    const key = `${reference.assetId}:${port.id}`;
    if (selectedReferenceKeys.has(key)) return;
    updateSelectedClip({ attachedReferences: [...(selectedClip.attachedReferences || []), {
      assetId: reference.assetId,
      url: reference.url,
      thumbnailUrl: reference.thumbnailUrl,
      title: reference.title,
      role: port.id as NonNullable<VideoMasterClip["attachedReferences"]>[number]["role"],
      durationSeconds: reference.durationSeconds,
    }] });
  };

  const detachReference = (reference: VideoEditorReference) => {
    if (!selectedClip) return;
    if (!reference.sourceNodeId && !reference.edgeId && reference.role === "reference-video" && reference.assetId && (reference.assetId === selectedClip.sourceAssetId || reference.url === selectedClip.sourceUrl)) {
      updateSelectedClip(moveUploadedMasterClipToLane(selectedClip, "output"));
      return;
    }
    if (reference.sourceNodeId || reference.edgeId) onDisconnectReference?.(reference);
    if (reference.assetId) updateSelectedClip({ attachedReferences: (selectedClip.attachedReferences || []).filter((item) => !(item.assetId === reference.assetId && (!reference.role || item.role === reference.role))) });
  };

  const attachPersonaAsset = (persona: PersonaRecord, asset: PersonaRecord["assets"][number]) => {
    if (!selectedClip || activeReferencePort?.kind !== "image") return;
    if (attachedReferenceIds.has(asset.id)) {
      updateSelectedClip({ attachedReferences: attachedReferences.filter((reference) => reference.assetId !== asset.id) });
      return;
    }
    if (selectedReferences.length >= maxReferences) return;
    const siblings = persona.assets.filter((item) => item.role === asset.role);
    updateSelectedClip({ attachedReferences: [...attachedReferences, {
      assetId: asset.id,
      url: asset.url,
      title: `${persona.name} · ${asset.role} ${siblings.findIndex((item) => item.id === asset.id) + 1}`,
      thumbnailUrl: asset.thumbnailUrl,
      personaId: persona.id,
      variant: asset.role,
      role: activeReferencePort.id as NonNullable<VideoMasterClip["attachedReferences"]>[number]["role"],
    }] });
  };

  const attachPersonaVariant = (persona: PersonaRecord, variant: "reference" | "before" | "after") => {
    if (!selectedClip || activeReferencePort?.kind !== "image") return;
    const additions = persona.assets
      .filter((asset) => asset.role === variant && !attachedReferenceIds.has(asset.id))
      .slice(0, Math.max(0, maxReferences - selectedReferences.length))
      .map((asset, index) => ({ assetId: asset.id, url: asset.url, thumbnailUrl: asset.thumbnailUrl, title: `${persona.name} · ${variant} ${index + 1}`, personaId: persona.id, variant, role: activeReferencePort.id as NonNullable<VideoMasterClip["attachedReferences"]>[number]["role"] }));
    if (additions.length) updateSelectedClip({ attachedReferences: [...attachedReferences, ...additions] });
  };

  const referenceMenu = openGeneratorMenu === "references" && activeReferencePort && <div className="generator-reference-menu video-editor-viewer-reference-menu nodrag nopan nowheel" onPointerDown={(event) => event.stopPropagation()} onPointerMove={(event) => event.stopPropagation()} onWheelCapture={(event) => event.stopPropagation()}>
    <div className="generator-reference-menu-head"><span>{activeReferencePort.label.toUpperCase()}</span><b>{activePortReferences.length} CONNECTED</b></div>
    <div className="generator-reference-capacity"><span>{activeReferencePort.label}</span><small>{activeReferencePort.required ? "Required input" : "Optional input"} · up to {activeReferencePort.max || maxReferences}</small></div>
    <div className="generator-reference-scroll nowheel" onWheelCapture={(event) => { if ((event.target as HTMLElement).closest(".generator-persona-picker-options")) return; event.stopPropagation(); }}>
      {activePortReferences.length > 0 && <div className="generator-reference-current">{activePortReferences.map((reference) => {
        const roleLabel = reference.removable === false ? "Scene source" : generatorReferenceRoleLabels[reference.role || ""] || "Connected reference";
        const durationLabel = Number(reference.durationSeconds || 0) > 0 ? ` · ${Number(reference.durationSeconds).toFixed(1)}s` : "";
        return <div className="generator-reference-row" key={`${reference.role}:${reference.id}`}><GeneratorReferencePreview reference={reference} /><span><strong>{reference.title}</strong><small>{roleLabel}{durationLabel}</small></span>{reference.removable !== false && <button type="button" aria-label={`Detach ${reference.title}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); detachReference(reference); }}><X size={12} /></button>}</div>;
      })}</div>}
      {!activePortReferences.length && <div className="generator-reference-empty"><Images size={17} /><span>Nothing connected to this input.</span></div>}
      {availableReferences.some((reference) => (reference.mediaType || "image") === activeReferencePort.kind) && <><div className="generator-reference-divider"><span>CANVAS</span></div><div className="generator-reference-list video-editor-viewer-reference-canvas-grid">{availableReferences.filter((reference) => (reference.mediaType || "image") === activeReferencePort.kind).map((reference) => <button type="button" key={reference.id} disabled={!reference.assetId || selectedReferences.length >= maxReferences} onClick={(event) => { event.preventDefault(); event.stopPropagation(); attachReference(reference, activeReferencePort); }}><span>{activeReferencePort.kind === "video" ? <Video size={12} /> : activeReferencePort.kind === "audio" ? <Volume2 size={12} /> : <img src={assetThumbnailUrl(reference.thumbnailUrl || reference.url)} alt="" />}</span><strong>{reference.title}</strong><Plus size={10} /></button>)}</div></>}
      {activeReferencePort.kind === "image" && <><div className="generator-reference-divider"><span>IDENTITY LIBRARY</span></div><div className="generator-reference-list nowheel">
        {personas.length > 0 && <div className={`generator-persona-picker ${referencePersonaPickerOpen ? "is-open" : ""}`}><button type="button" className="generator-persona-picker-trigger" aria-expanded={referencePersonaPickerOpen} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setReferencePersonaPickerOpen((open) => !open); }}><span className="generator-persona-picker-avatar">{selectedReferencePersona?.avatarUrl ? <img src={selectedReferencePersona.avatarUrl} alt="" /> : <UserRound size={14} />}</span><span><small>Selected identity</small><strong>{selectedReferencePersona?.name || "Choose identity"}</strong></span><ChevronDown size={13} /></button>{referencePersonaPickerOpen && <div className="generator-persona-picker-options nowheel">{personas.map((persona) => <button type="button" className={selectedReferencePersona?.id === persona.id ? "is-selected" : ""} key={persona.id} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setReferencePersonaId(persona.id); setReferencePersonaPickerOpen(false); }}><span className="generator-persona-picker-avatar">{persona.avatarUrl ? <img src={persona.avatarUrl} alt="" /> : <UserRound size={14} />}</span><span><strong>{persona.name}</strong><small>{persona.assets.length} photos</small></span>{selectedReferencePersona?.id === persona.id && <Check size={12} />}</button>)}</div>}</div>}
        {selectedReferencePersona && <div className="generator-persona-option">{(["reference", "before", "after"] as const).map((variant) => { const assets = selectedReferencePersona.assets.filter((asset) => asset.role === variant); if (!assets.length) return null; return <div className="generator-persona-state" key={variant}><header><span>{variant === "reference" ? "identity" : variant}</span><button type="button" disabled={!assets.some((asset) => !attachedReferenceIds.has(asset.id)) || selectedReferences.length >= maxReferences} onClick={(event) => { event.preventDefault(); event.stopPropagation(); attachPersonaVariant(selectedReferencePersona, variant); }}>Add available</button></header><div>{assets.map((asset, index) => { const active = attachedReferenceIds.has(asset.id); return <button type="button" className={active ? "is-attached" : ""} disabled={!active && selectedReferences.length >= maxReferences} key={asset.id} onClick={(event) => { event.preventDefault(); event.stopPropagation(); attachPersonaAsset(selectedReferencePersona, asset); }}><img src={asset.thumbnailUrl || asset.url} alt="" /><span>{String(index + 1).padStart(2, "0")}</span>{active && <Check size={9} />}</button>; })}</div></div>; })}</div>}
      </div></>}
    </div>
  </div>;

  const downloadSelected = async () => {
    if (!onDownload || downloadBusy) return;
    setDownloadBusy(true);
    try { await onDownload(selectedLane, "scene"); } finally { setDownloadBusy(false); }
  };

  const addScene = () => {
    const clip: VideoMasterClip = {
      id: `master-clip-${crypto.randomUUID()}`,
      sequenceIndex: clips.length,
      title: `Scene ${String(clips.length + 1).padStart(2, "0")}`,
      role: clips.length ? "scene" : "hook",
      origin: "generated",
      duration: Number(selectedClip?.duration || 5),
      prompt: "",
      modelId: selectedClip?.modelId,
      aspectRatio: selectedClip?.aspectRatio || "9:16",
      resolution: selectedClip?.resolution || "720P",
      generateAudio: selectedClip?.generateAudio ?? false,
    };
    const next = [...clips, clip];
    onUpdateNode({ videoMasterClips: next, videoMasterSelectedClipId: clip.id, prompt: "", modelId: clip.modelId, duration: String(clip.duration) });
    setSelectedClipId(clip.id);
    setRelativeTime(0);
    setSequencePlaying(false);
  };

  return <div className="video-editor-viewer-layout">
    <ViewerAmbient imageUrl={videoMasterClipThumbnail(selectedClip, selectedMedia.usesOutput ? "output" : "original")} />
    <div className="video-editor-viewer-master-workspace">
      <div className="video-editor-viewer-master-stage">
        <div className="generator-node-toolbar video-editor-viewer-node-toolbar" role="toolbar" aria-label="Video Master actions">
          <button type="button" className="is-run" disabled={!selectedClip?.prompt.trim()} title="Generate selected scene" onClick={() => selectedClip && onGenerateClip?.(selectedClip.id)}><Play size={14} fill="currentColor" /><span>Run</span></button>
          <i />
          <button type="button" disabled={!selectedMedia.url || downloadBusy} title="Download selected scene" aria-label="Download selected scene" onClick={() => void downloadSelected()}>{downloadBusy ? <span className="generator-spinner" /> : <Download size={15} />}</button>
          <i />
          <button type="button" className="is-delete" title="Delete Video Master" aria-label="Delete Video Master" onClick={() => { onClose(); onDeleteNode?.(); }}><Trash2 size={15} /></button>
        </div>
        {selectedClip && selectedMedia.url ? <VideoMasterPlayer
          src={selectedMedia.url}
          preloadSources={masterPlaybackSources}
          controlsPortal={controlsHost}
          clipStart={selectedMedia.start}
          clipEnd={selectedMedia.end}
          seamlessNext={seamlessNext}
          clickToToggle
          keyboardActive
          active
          playbackOwnerId={playbackOwnerId}
          playbackKey={`${selectedClip.id}:${selectedLane}`}
          playRequestToken={playRequest?.clipId === selectedClip.id && playRequest.lane === selectedLane ? playRequest.token : undefined}
          playRequestRelativeTime={playRequest?.clipId === selectedClip.id && playRequest.lane === selectedLane ? playRequest.relativeTime : undefined}
          requestedRelativeTime={seekRequest?.clipId === selectedClip.id ? seekRequest.time : undefined}
          requestedSeekToken={seekRequest?.clipId === selectedClip.id ? seekRequest.version : undefined}
          externalCurrentTime={currentTime}
          externalDuration={totalDuration}
          onExternalSeek={seekTimeline}
          onMediaDuration={(duration) => {
            const reconciledGeneratedDuration = reconciledVideoMasterGeneratedDuration(selectedClip, selectedMedia, duration);
            if (reconciledGeneratedDuration !== undefined && Math.abs(reconciledGeneratedDuration - Number(selectedClip.generatedDuration || 0)) > .02) {
              updateSelectedClip({
                generatedDuration: reconciledGeneratedDuration,
                generatedOutputs: selectedClip.generatedOutputs?.map((output) => output.url === selectedClip.outputUrl
                  ? { ...output, durationSeconds: reconciledGeneratedDuration }
                  : output),
              });
              return;
            }
            const reconciledDuration = reconciledVideoMasterClipDuration(selectedClip, selectedMedia, duration);
            if (reconciledDuration !== undefined && Math.abs(reconciledDuration - selectedClip.duration) > .02) {
              updateSelectedClip({ duration: reconciledDuration, sourceEnd: selectedClip.sourceStart ? selectedClip.sourceStart + reconciledDuration : reconciledDuration });
            }
          }}
          onPlaybackChange={(playing, playbackSessionKey) => {
            if (playbackSessionKey !== playbackTargetRef.current) return;
            if (playing) setSequencePlaying(true);
          }}
          onTimeChange={setRelativeTime}
          onClipEnded={(playback, playbackSessionKey) => {
            if (playbackSessionKey !== playbackTargetRef.current) return;
            if (nextClip && nextMedia.url) selectClip(nextClip, selectedLane, sequencePlaying || playback === "manual", 0, playback === "manual", seamlessNext);
            else { videoPlaybackManager.complete(playbackOwnerId, `${selectedClip.id}:${selectedLane}`); setSequencePlaying(false); setRelativeTime(selectedMedia.duration); }
          }}
        /> : <div className="video-editor-viewer-empty"><Video size={22} /><strong>{selectedClip ? "No media in this lane" : "Add the first scene"}</strong></div>}
        {selectedClip && <div className="generator-overlay video-editor-viewer-master-prompt">
          <textarea
            className="nodrag nopan"
            value={selectedClip.prompt}
            placeholder="Describe motion, camera and action…"
            aria-label={`${selectedClip.title} prompt`}
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => updateSelectedClip({ prompt: event.target.value })}
          />
        </div>}
        {selectedClip && <VideoMasterGenerationControls
          className="video-editor-viewer-master-controls"
          clipId={selectedClip.id}
          openMenu={openGeneratorMenu}
          setOpenMenu={setOpenGeneratorMenu}
          modelValue={selectedModel?.id || ""}
          modelOptions={modelOptions}
          onModelChange={(value) => {
            const model = availableModels.find((candidate) => candidate.id === value);
            if (!model) return;
            updateSelectedClip({ modelId: model.id, resolution: model.defaultResolution || model.resolutions?.[0] || selectedClip.resolution, generationDuration: videoMasterGenerationDuration(model, selectedClip), generateAudio: model.supportsAudio ? selectedClip.generateAudio ?? model.defaultGenerateAudio ?? false : false });
          }}
          ratioValue={selectedClip.aspectRatioMode === "custom" ? selectedRatio : "original"}
          ratioOptions={ratioOptions}
          onRatioChange={(value) => updateSelectedClip(value === "original" ? { aspectRatioMode: "original", aspectRatio: originalRatio } : { aspectRatioMode: "custom", aspectRatio: value })}
          durationValue={durationOptions.length ? String(generationDuration || selectedModel?.defaultDuration || selectedModel?.durations?.[0] || "5") : undefined}
          durationOptions={durationOptions}
          onDurationChange={(value) => updateSelectedClip({ generationDuration: Number(value) })}
          qualityValue={selectedClip.resolution || selectedModel?.defaultResolution || resolutions[0]}
          qualityOptions={resolutions.map((resolution) => ({ value: resolution, label: resolution }))}
          onQualityChange={(value) => updateSelectedClip({ resolution: value })}
          supportsAudio={Boolean(selectedModel?.supportsAudio)}
          audioEnabled={generatedAudioEnabled}
          onToggleAudio={() => updateSelectedClip({ generateAudio: !generatedAudioEnabled })}
          runDisabled={!selectedClip.prompt.trim() || masterHasActiveGeneration || missingRequiredInputs.length > 0}
          runTitle={missingRequiredInputs.length ? `Connect ${missingRequiredInputs.map((port) => port.label).join(" and ")}` : masterHasActiveGeneration ? "Another scene is generating" : "Run generation"}
          runBusy={masterBusy}
          onRun={() => onGenerateClip?.(selectedClip.id)}
        />}
      </div>
      <div className="video-editor-viewer-master-workbench">
        <div className="video-editor-viewer-master-transport" ref={setControlsHost} />
        {selectedClip && <div className="video-editor-viewer-scene-readout"><strong>{selectedClip.title}</strong><span>{selectedLane}</span><code>{preciseTime(selectedOffset)} — {preciseTime(selectedOffset + selectedMedia.duration)}</code></div>}
        <VideoMasterTimeline
          clips={clips}
          selectedClipId={selectedClip?.id}
          selectedLane={selectedLane}
          currentTime={currentTime}
          laneVisibility={laneVisibility}
          onToggleLane={(lane) => setLaneVisibility((current) => ({ ...current, [lane]: !current[lane] }))}
          onSelect={(clip, lane) => selectClip(clip, lane, false, 0, true)}
          onSeek={seekTimeline}
          onReorder={persistClips}
          onMoveLane={(clip, lane) => persistClips(clips.map((item) => item.id === clip.id ? moveUploadedMasterClipToLane(item, lane) : item))}
          onCopyOutput={(sourceClip, targetClipId) => {
            const output = videoMasterGeneratedOutputs(sourceClip).find((candidate) =>
              candidate.url === sourceClip.outputUrl || candidate.assetId === sourceClip.outputAssetId
            ) || videoMasterGeneratedOutputs(sourceClip).at(-1);
            if (output) applyOutput(targetClipId, output);
          }}
          onAddGenerated={addScene}
          onUpload={onUpload}
        />
      </div>
    </div>
    <ViewerSidebar title="Video Master" eyebrow={selectedClip?.title || "Scene editor"}>
      {selectedClip ? <>
        <div className="video-editor-viewer-sidebar-tabs" role="tablist" aria-label="Video Master panel">
          <button type="button" className={sidebarTab === "scene" ? "is-active" : ""} onClick={() => setSidebarTab("scene")}><Link2 size={11} />References<b>{visibleSceneReferences.length}</b></button>
          <button type="button" className={sidebarTab === "outputs" ? "is-active" : ""} onClick={() => setSidebarTab("outputs")}><Images size={11} />Versions{selectedOutputCount > 0 && <b>{selectedOutputCount}</b>}</button>
        </div>
        <section>
          <label>SETTINGS</label>
          <div className="media-viewer-chips"><span>{selectedLane}</span><span>{preciseTime(selectedMedia.duration)}</span><span>{selectedClip.modelId || "No model"}</span><span>{selectedClip.aspectRatio || "9:16"}</span><span>{selectedClip.resolution || "720P"}</span></div>
        </section>
        {sidebarTab === "scene" ? <section className="video-editor-viewer-scene-reference-launcher">
          <label>INPUTS</label>
          <div className="video-editor-viewer-reference-ports">{inputPorts.map((port) => {
            const portReferences = referencesForPort(port);
            const portLabel = port.id === "start-frame" ? "Start frame" : port.id === "end-frame" ? "End frame" : port.id === "reference-video" || port.id === "motion-video" ? "Video reference" : port.id === "reference-audio" ? "Audio" : port.id === "reference-image" ? "Images" : port.label;
            return <button type="button" key={port.id} className={openGeneratorMenu === "references" && referenceMenuPortId === port.id ? "is-active" : ""} onClick={(event) => { event.preventDefault(); event.stopPropagation(); const closing = openGeneratorMenu === "references" && referenceMenuPortId === port.id; setReferenceMenuPortId(port.id); setOpenGeneratorMenu(closing ? null : "references"); }}><span>{port.kind === "video" ? <Video size={13} /> : port.kind === "audio" ? <Volume2 size={13} /> : <ImageIcon size={13} />}</span><strong>{portLabel}</strong><b>{portReferences.length}</b><ChevronDown size={12} /></button>;
          })}</div>
          {referenceMenu}
        </section> : <section className="video-editor-viewer-output-section">
          <div className="video-editor-viewer-output-head"><label>SAVED VERSIONS</label><div><button type="button" className={outputScope === "scene" ? "is-active" : ""} onClick={() => setOutputScope("scene")}>Scene</button><button type="button" className={outputScope === "all" ? "is-active" : ""} onClick={() => setOutputScope("all")}>All</button></div></div>
          <div className="video-editor-viewer-output-grid">
            {visibleOutputEntries.map(({ clip, clipIndex, output, outputIndex }) => {
              const active = clip.outputUrl === output.url;
              const key = `${clip.id}:${output.url}`;
              return <article key={key} className={active ? "is-active" : ""}>
                <button type="button" className="video-editor-viewer-output-preview" aria-label={`Use ${clip.title} version ${outputIndex + 1}`} onClick={() => applyOutput(clip.id, output)}>
                  <img src={assetThumbnailUrl(output.url)} alt="" />
                  <span>S{String(clipIndex + 1).padStart(2, "0")} · V{String(outputIndex + 1).padStart(2, "0")}</span>
                  {active && <i><Check size={9} /></i>}
                </button>
                {outputScope === "all" && selectedClip.id !== clip.id && <button type="button" className="video-editor-viewer-output-move" aria-label={`Use in ${selectedClip.title}`} title={`Use in ${selectedClip.title}`} onClick={() => setMoveOutputKey(moveOutputKey === key ? "" : key)}><ArrowRightLeft size={10} /></button>}
                {moveOutputKey === key && <button type="button" className="video-editor-viewer-output-confirm" onClick={() => applyOutput(selectedClip.id, output, true)}>Use in {selectedClip.title}</button>}
              </article>;
            })}
            {!visibleOutputEntries.length && <p className="video-editor-viewer-sidebar-empty">No generated versions for this scene yet.</p>}
          </div>
        </section>}
      </> : <section><label>Scene</label><p>Add a scene from the timeline to begin.</p></section>}
      <div className="video-editor-viewer-sidebar-spacer" />
      <small className="video-editor-viewer-sidebar-hint">Playback is manual. Scene transitions continue while the sequence is playing.</small>
    </ViewerSidebar>
  </div>;
}

function ClipFullscreenPlayer({ node, url, videoStart, videoEnd }: { node: FrameNode; url: string; videoStart: number; videoEnd?: number }) {
  return <div className="video-editor-viewer-layout">
    <div className="video-editor-viewer-clip-stage">
      <CanvasVideoPlayer src={url} variant="scene" controlsPlacement="dock" clipStart={videoStart} clipEnd={videoEnd} hoverActive={false} clickToToggle keyboardActive />
    </div>
    <ViewerSidebar title={node.data.title} eyebrow="Video player">
      <section>
        <label>Playback</label>
        <p>Click anywhere on the video to play or pause.</p>
      </section>
      <section>
        <label>SETTINGS</label>
        <div className="media-viewer-chips"><span>{preciseTime(videoStart)} start</span><span>{preciseTime(Number(videoEnd ?? node.data.videoDurationSeconds ?? 0))} end</span></div>
      </section>
    </ViewerSidebar>
  </div>;
}
