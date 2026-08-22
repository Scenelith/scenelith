"use client";

/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowLeft, Download, Pause, Play, Sparkles, Trash2, Volume2, VolumeX, WandSparkles, X } from "lucide-react";
import type { FrameNode } from "@/lib/types";
import { assetDirectUrl, assetDownloadUrl, assetThumbnailUrl, GeneratorSelect, generatorModelCreditDescription, generatorRatiosFor, nearestSupportedRatio, type GeneratorModelOption } from "./FrameNode";
import { ImageGeneration } from "./ui/ai-chat-image-generation-1";
import { generationCreditCost } from "@/lib/generation-pricing";
import { appendEditReferenceMention, editReferenceMentionToken } from "@/lib/reference-mentions";
import { ImageEditReferencePicker, type ImageEditPersona, type ImageEditReference } from "./ImageEditReferencePicker";
import { AddToIdentityPopover } from "./AddToIdentityPopover";
import type { PersonaRecord } from "@/lib/types";

type PreviewReference = { id: string; url: string; title: string; personaId?: string; variant?: "reference" | "before" | "after" };

export type ImageEditOptions = {
  modelId: string;
  resolution: string;
  aspectRatio: string;
  sizeMode: "original" | "custom";
  sourceWidth?: number;
  sourceHeight?: number;
  sourceAspectRatio?: string;
  sourcePersonaName?: string;
  sourcePersonaVariant?: "reference" | "before" | "after";
};

function relativeTime(value: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "recently";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

function formatVideoTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const wholeSeconds = Math.floor(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  return `${minutes}:${String(wholeSeconds % 60).padStart(2, "0")}`;
}

const EDIT_IMAGE_LOAD_ATTEMPTS = 12;

function editImageUrlForAttempt(url: string, attempt: number) {
  const directUrl = assetDirectUrl(url);
  if (!attempt) return directUrl;
  return `${directUrl}${directUrl.includes("?") ? "&" : "?"}scenelithLoadRetry=${attempt}`;
}

function loadEditedImageWhenReady(url: string) {
  return new Promise<string>((resolve, reject) => {
    let attempt = 0;
    const load = () => {
      const image = new window.Image();
      const renderUrl = editImageUrlForAttempt(url, attempt);
      image.onload = () => resolve(renderUrl);
      image.onerror = () => {
        attempt += 1;
        if (attempt >= EDIT_IMAGE_LOAD_ATTEMPTS) {
          reject(new Error("The edited image was created, but could not be loaded yet"));
          return;
        }
        window.setTimeout(load, Math.min(5000, 750 * attempt));
      };
      image.src = renderUrl;
    };
    load();
  });
}

export function MediaViewer({
  node,
  url,
  videoStart = 0,
  videoEnd,
  mediaTitle,
  references,
  persona,
  editCanvasReferences,
  editPersonas,
  identities,
  initialEditReferences,
  models,
  createdAt,
  projectName,
  canvasName,
  initialMode,
  onClose,
  onDelete,
  onCreateEdit,
  onRefineEdit,
  onUploadEditReferences,
  onEditReferencesChange,
  onAddToIdentity,
  onCreateIdentityFromAsset,
}: {
  node: FrameNode;
  url: string;
  videoStart?: number;
  videoEnd?: number;
  mediaTitle?: string;
  references: PreviewReference[];
  persona?: { id: string; name: string; avatarUrl?: string; variant?: "reference" | "before" | "after" };
  editCanvasReferences: ImageEditReference[];
  editPersonas: ImageEditPersona[];
  identities: PersonaRecord[];
  initialEditReferences: ImageEditReference[];
  models: GeneratorModelOption[];
  createdAt: string;
  projectName: string;
  canvasName: string;
  initialMode: "view" | "edit";
  onClose: () => void;
  onDelete?: () => void;
  onCreateEdit: (
    prompt: string,
    options: ImageEditOptions,
    references: ImageEditReference[],
    onPhase: (phase: "preparing" | "queued" | "generating") => void,
  ) => Promise<{ url: string; assetId?: string; mediaType: "image"; modelId?: string }>;
  onRefineEdit: (brief: string, options: ImageEditOptions, references: ImageEditReference[]) => Promise<string>;
  onUploadEditReferences: (files: File[]) => Promise<ImageEditReference[]>;
  onEditReferencesChange: (references: ImageEditReference[]) => void;
  onAddToIdentity: (personaId: string, role: "reference" | "before" | "after", sourceAssetId: string) => Promise<{ alreadyAdded?: boolean }>;
  onCreateIdentityFromAsset: (name: string, role: "reference" | "before" | "after", sourceAssetId: string) => Promise<void>;
}) {
  const [mode, setMode] = useState(initialMode);
  const [editRequest, setEditRequest] = useState(() => initialEditReferences.map((reference) => editReferenceMentionToken(reference.title, reference.assetId)).join(" "));
  const [refining, setRefining] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [editPhase, setEditPhase] = useState<"preparing" | "queued" | "generating" | "loading" | null>(null);
  const isVideo = node.data.mediaType === "video" || node.data.kind === "videoMaster";
  const [displayUrl, setDisplayUrl] = useState(isVideo ? assetDirectUrl(url) : assetThumbnailUrl(url));
  const [mediaFrame, setMediaFrame] = useState<{ width: number; height: number; sourceWidth: number; sourceHeight: number } | null>(null);
  const [error, setError] = useState("");
  const editableModels = models.filter((item) => item.mediaType === "image" && item.maxReferences > 0);
  const initialEditModel = editableModels.find((item) => item.id === node.data.modelId)
    || editableModels.find((item) => item.id === "nano-banana-2")
    || editableModels[0];
  const [editModelId, setEditModelId] = useState(initialEditModel?.id || "nano-banana-2");
  const [editResolution, setEditResolution] = useState(initialEditModel?.resolutions?.includes(String(node.data.resolution || ""))
    ? String(node.data.resolution)
    : initialEditModel?.defaultResolution || initialEditModel?.resolutions?.[0] || "1K");
  const [editSize, setEditSize] = useState("original");
  const [openEditMenu, setOpenEditMenu] = useState<string | null>(null);
  const [editReferences, setEditReferences] = useState<ImageEditReference[]>(initialEditReferences);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [videoMuted, setVideoMuted] = useState(false);
  const [videoCurrentTime, setVideoCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const canvasRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoBackgroundRef = useRef<HTMLVideoElement>(null);
  const editRequestRef = useRef<HTMLTextAreaElement>(null);
  const blockedDisplayUrlRef = useRef<string | null>(null);
  const displaySourceUrlRef = useRef(url);
  const editable = node.data.mediaType !== "video" && Boolean(node.data.assetId);
  const model = models.find((item) => item.id === node.data.modelId);
  const editModel = editableModels.find((item) => item.id === editModelId) || initialEditModel;
  const editRatios = generatorRatiosFor(editModel, editResolution, true);
  const sourceRatio = mediaFrame?.sourceWidth && mediaFrame.sourceHeight
    ? nearestSupportedRatio(mediaFrame.sourceWidth, mediaFrame.sourceHeight, editRatios)
    : String(node.data.aspectRatio || editModel?.defaultRatio || editRatios[0] || "1:1");
  const effectiveAspectRatio = editSize === "original"
    ? editRatios.includes("auto") ? "auto" : editRatios.includes(sourceRatio) ? sourceRatio : editRatios[0] || "1:1"
    : editRatios.includes(editSize) ? editSize : editRatios[0] || "1:1";
  const maxAdditionalReferences = Math.max(0, Number(editModel?.maxReferences || 1) - 1);
  const editCredits = editModel ? generationCreditCost(editModel.id, editResolution, "5", editReferences.length + 1) : 0;
  const videoProgress = videoDuration > 0 ? Math.min(100, Math.max(0, videoCurrentTime / videoDuration * 100)) : 0;
  const safeVideoStart = Number.isFinite(videoStart) ? Math.max(0, Number(videoStart)) : 0;
  const videoWindowEnd = (sourceDuration: number) => Number.isFinite(videoEnd) && Number(videoEnd) > safeVideoStart
    ? Math.min(sourceDuration || Number(videoEnd), Number(videoEnd))
    : sourceDuration;
  const videoWindowDuration = (sourceDuration: number) => Math.max(.01, videoWindowEnd(sourceDuration) - safeVideoStart);
  const sourceRatioLabel = sourceRatio;
  const editOptions: ImageEditOptions = {
    modelId: editModel?.id || editModelId,
    resolution: editResolution,
    aspectRatio: effectiveAspectRatio,
    sizeMode: editSize === "original" ? "original" : "custom",
    sourceWidth: mediaFrame?.sourceWidth,
    sourceHeight: mediaFrame?.sourceHeight,
    sourceAspectRatio: sourceRatio,
    sourcePersonaName: persona?.name,
    sourcePersonaVariant: persona?.variant,
  };

  const changeEditReferences = (next: ImageEditReference[]) => {
    const previousIds = new Set(editReferences.map((reference) => reference.assetId));
    const nextIds = new Set(next.map((reference) => reference.assetId));
    const added = next.filter((reference) => !previousIds.has(reference.assetId));
    const removed = editReferences.filter((reference) => !nextIds.has(reference.assetId));
    setEditReferences(next);
    onEditReferencesChange(next);
    setEditRequest((current) => {
      let updated = current;
      for (const reference of removed) {
        const token = editReferenceMentionToken(reference.title, reference.assetId);
        updated = updated.replaceAll(`${token} `, "").replaceAll(` ${token}`, "").replaceAll(token, "");
      }
      for (const reference of added) {
        const token = editReferenceMentionToken(reference.title, reference.assetId);
        if (updated.includes(token)) continue;
        updated = `${updated}${updated && !/\s$/u.test(updated) ? " " : ""}${token}`;
      }
      return updated;
    });
    if (added.length) window.requestAnimationFrame(() => {
      const textarea = editRequestRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
  };

  const mentionEditReference = (reference: ImageEditReference) => {
    setEditRequest((current) => appendEditReferenceMention(current, reference.title, reference.assetId));
    window.requestAnimationFrame(() => {
      const textarea = editRequestRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
  };

  const syncVideoBackground = useCallback(() => {
    const video = videoRef.current;
    const background = videoBackgroundRef.current;
    if (!video || !background || !Number.isFinite(video.currentTime)) return;
    if (Math.abs(background.currentTime - video.currentTime) > 0.12) background.currentTime = video.currentTime;
  }, []);

  const playVideoBackground = useCallback(() => {
    syncVideoBackground();
    const background = videoBackgroundRef.current;
    if (!background) return;
    void background.play().catch(() => undefined);
  }, [syncVideoBackground]);

  const toggleVideoPlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    const end = videoWindowEnd(video.duration);
    if (video.paused) {
      if (video.currentTime >= end - .03 || video.currentTime < safeVideoStart) video.currentTime = safeVideoStart;
      void video.play().catch(() => undefined);
    }
    else video.pause();
  };

  const syncMediaFrame = useCallback(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    const video = videoRef.current;
    const sourceWidth = image?.naturalWidth || video?.videoWidth || 0;
    const sourceHeight = image?.naturalHeight || video?.videoHeight || 0;
    if (!canvas || !sourceWidth || !sourceHeight) return;
    const scale = Math.min(canvas.clientWidth / sourceWidth, canvas.clientHeight / sourceHeight);
    if (!Number.isFinite(scale) || scale <= 0) return;
    setMediaFrame({ width: sourceWidth * scale, height: sourceHeight * scale, sourceWidth, sourceHeight });
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  useEffect(() => {
    if (submitting || blockedDisplayUrlRef.current === url) return;
    displaySourceUrlRef.current = url;
    let active = true;
    if (isVideo) {
      queueMicrotask(() => { if (active) setDisplayUrl(assetDirectUrl(url)); });
      return () => { active = false; };
    }

    const previewUrl = assetThumbnailUrl(url);
    const originalUrl = assetDirectUrl(url);
    queueMicrotask(() => { if (active) setDisplayUrl(previewUrl); });
    const original = new window.Image();
    original.onload = () => {
      if (active && displaySourceUrlRef.current === url && blockedDisplayUrlRef.current !== url) setDisplayUrl(originalUrl);
    };
    original.src = originalUrl;
    return () => { active = false; };
  }, [isVideo, submitting, url]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(syncMediaFrame);
    observer.observe(canvas);
    syncMediaFrame();
    return () => observer.disconnect();
  }, [displayUrl, mode, syncMediaFrame]);

  useEffect(() => {
    queueMicrotask(() => setEditReferences((current) => current.slice(0, maxAdditionalReferences)));
  }, [maxAdditionalReferences]);

  useEffect(() => {
    queueMicrotask(() => setEditReferences(initialEditReferences.slice(0, maxAdditionalReferences)));
  }, [node.data.assetId]);

  const refine = async () => {
    if (!editRequest.trim() || refining) return;
    setRefining(true);
    setError("");
    try {
      const prompt = await onRefineEdit(editRequest.trim(), editOptions, editReferences);
      setEditRequest(prompt);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not build an edit prompt");
    } finally {
      setRefining(false);
    }
  };

  const submit = async () => {
    if (!editRequest.trim() || submitting) return;
    setSubmitting(true);
    setEditPhase("preparing");
    setError("");
    try {
      const output = await onCreateEdit(editRequest.trim(), editOptions, editReferences, (phase) => setEditPhase(phase));
      blockedDisplayUrlRef.current = output.url;
      setEditPhase("loading");
      const loadedUrl = await loadEditedImageWhenReady(output.url);
      displaySourceUrlRef.current = output.url;
      setDisplayUrl(loadedUrl);
      blockedDisplayUrlRef.current = null;
      setEditSize("original");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not start image edit");
    } finally {
      setSubmitting(false);
      setEditPhase(null);
    }
  };

  const editGenerationCopy = editPhase === "queued"
    ? { starting: "Waiting in generation queue…", generating: "Waiting in generation queue…" }
    : editPhase === "loading"
      ? { starting: "Generation complete…", generating: "Loading edited image…" }
    : editPhase === "generating"
      ? { starting: "Preparing image edit…", generating: "Creating edited image. This may take a moment." }
      : { starting: "Preparing image edit…", generating: "Preparing image edit…" };

  return <div className="media-viewer-backdrop nodrag nopan" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className={`media-viewer ${mode === "edit" ? "is-editing" : "is-viewing"}`} role="dialog" aria-modal="true" aria-label={`${mediaTitle || node.data.title} preview`}>
      <header className="media-viewer-topbar">
        <button type="button" aria-label={mode === "edit" ? "Back to preview" : "Back to canvas"} onPointerDown={() => { if (mode === "edit") setMode("view"); else onClose(); }}><ArrowLeft size={17} /></button>
        <div className="media-viewer-top-actions">
          {mode === "view" && editable && <button type="button" className="media-viewer-edit-mobile" aria-label="Edit image" onPointerDown={() => setMode("edit")}><WandSparkles size={15} /></button>}
          <button type="button" className="media-viewer-close" aria-label="Close preview" onPointerDown={onClose}><X size={17} /></button>
        </div>
      </header>

      <div className="media-viewer-body">
        <section className={`media-viewer-stage${isVideo ? " is-video" : ""}`}>
          {isVideo
            ? <video ref={videoBackgroundRef} className="media-viewer-background" src={displayUrl} muted autoPlay playsInline preload="auto" aria-hidden="true" tabIndex={-1} />
            : <img className="media-viewer-background" src={assetThumbnailUrl(displayUrl)} alt="" aria-hidden="true" />}
          <div ref={canvasRef} className="media-viewer-canvas">
            {isVideo
              ? <div className="media-viewer-media-frame is-video" style={mediaFrame ? { width: mediaFrame.width, height: mediaFrame.height } : undefined}>
                <video
                  ref={videoRef}
                  src={displayUrl}
                  autoPlay
                  playsInline
                  muted={videoMuted}
                  onClick={toggleVideoPlayback}
                  onLoadedMetadata={(event) => {
                    const sourceDuration = Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0;
                    event.currentTarget.currentTime = Math.min(sourceDuration, safeVideoStart);
                    setVideoCurrentTime(0);
                    setVideoDuration(videoWindowDuration(sourceDuration));
                    syncVideoBackground();
                    syncMediaFrame();
                  }}
                  onDurationChange={(event) => setVideoDuration(videoWindowDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0))}
                  onPlay={() => { setVideoPlaying(true); playVideoBackground(); }}
                  onPause={() => { setVideoPlaying(false); videoBackgroundRef.current?.pause(); }}
                  onEnded={() => { setVideoPlaying(false); setVideoCurrentTime(videoDuration); }}
                  onSeeking={syncVideoBackground}
                  onTimeUpdate={(event) => {
                    const end = videoWindowEnd(event.currentTarget.duration);
                    if (event.currentTarget.currentTime >= end - .015) {
                      event.currentTarget.currentTime = end;
                      event.currentTarget.pause();
                      setVideoCurrentTime(videoWindowDuration(event.currentTarget.duration));
                    } else setVideoCurrentTime(Math.max(0, event.currentTarget.currentTime - safeVideoStart));
                    syncVideoBackground();
                  }}
                />
                <div className="media-viewer-video-controls">
                  <button type="button" aria-label={videoPlaying ? "Pause video" : "Play video"} onPointerDown={(event) => { event.stopPropagation(); toggleVideoPlayback(); }}>{videoPlaying ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}</button>
                  <input
                    type="range"
                    min="0"
                    max={Math.max(videoDuration, 0.01)}
                    step="0.01"
                    value={Math.min(videoCurrentTime, Math.max(videoDuration, 0.01))}
                    aria-label="Video position"
                    style={{ "--media-progress": `${videoProgress}%` } as CSSProperties}
                    onChange={(event) => {
                      const nextTime = Number(event.currentTarget.value);
                      if (videoRef.current && Number.isFinite(nextTime)) videoRef.current.currentTime = safeVideoStart + nextTime;
                      setVideoCurrentTime(nextTime);
                      syncVideoBackground();
                    }}
                  />
                  <span>{formatVideoTime(videoCurrentTime)} <i>/</i> {formatVideoTime(videoDuration)}</span>
                  <button type="button" aria-label={videoMuted ? "Unmute video" : "Mute video"} onPointerDown={(event) => { event.stopPropagation(); setVideoMuted((current) => !current); }}>{videoMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}</button>
                </div>
              </div>
              : <div className={`media-viewer-media-frame ${submitting ? "is-generating" : ""}`} style={mediaFrame ? { width: mediaFrame.width, height: mediaFrame.height } : undefined}>
                <img ref={imageRef} src={displayUrl} alt={node.data.title} onLoad={syncMediaFrame} />
                {submitting && <div className="media-edit-generation" aria-live="polite">
                  <ImageGeneration key={editPhase || "preparing"} startingLabel={editGenerationCopy.starting} generatingLabel={editGenerationCopy.generating}>
                    <div className="media-edit-generation-preview" aria-hidden="true" />
                  </ImageGeneration>
                </div>}
              </div>}
          </div>
          {mode === "edit" && <div className="media-edit-composer">
            {editReferences.length > 0 && <div className="media-edit-selected-references" aria-label="Selected edit references">
              {editReferences.map((reference) => <div className="media-edit-selected-reference" key={reference.assetId}>
                <button
                  type="button"
                  className="media-edit-selected-reference-mention"
                  title={`Insert ${reference.title} into request`}
                  aria-label={`Insert ${reference.title} into request`}
                  disabled={submitting}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    mentionEditReference(reference);
                  }}
                >
                  <img src={reference.thumbnailUrl || reference.url} alt="" />
                </button>
                <button
                  type="button"
                  className="media-edit-selected-reference-remove"
                  title={`Remove ${reference.title}`}
                  aria-label={`Remove ${reference.title}`}
                  disabled={submitting}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    changeEditReferences(editReferences.filter((item) => item.assetId !== reference.assetId));
                  }}
                ><X size={9} /></button>
              </div>)}
            </div>}
            <textarea ref={editRequestRef} aria-label="Image edit request" autoFocus disabled={submitting} value={editRequest} onChange={(event) => setEditRequest(event.target.value)} placeholder="What do you want to change?" onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void submit(); }} />
            {error && <p className="media-edit-error">{error}</p>}
            <div className="media-edit-settings">
              <GeneratorSelect menuKey="edit-model" openMenu={openEditMenu} setOpenMenu={setOpenEditMenu} className="generator-model-control media-edit-model" value={editModel?.id || editModelId} label="EDIT MODEL" options={editableModels.map((item) => ({
                value: item.id,
                label: item.label,
                description: generatorModelCreditDescription(item, {
                  resolution: item.id === editModel?.id ? editResolution : undefined,
                  referenceCount: editReferences.length + 1,
                }),
              }))} onChange={(value) => {
                const nextModel = editableModels.find((item) => item.id === value);
                const nextResolution = nextModel?.defaultResolution || nextModel?.resolutions?.[0] || "1K";
                setEditModelId(value);
                setEditResolution(nextResolution);
                setEditSize("original");
              }} />
              <GeneratorSelect menuKey="ratio" openMenu={openEditMenu} setOpenMenu={setOpenEditMenu} className="media-edit-ratio" value={editSize} label="OUTPUT SIZE" options={[
                { value: "original", label: `Original · ${sourceRatioLabel}`, description: "Keep the source framing" },
                ...editRatios.filter((ratio) => /^\d+:\d+$/.test(ratio)).map((ratio) => ({ value: ratio, label: ratio, description: ratio === sourceRatio ? "Matches source shape" : "Reframe edited output" })),
              ]} onChange={(value) => setEditSize(value)} />
              <GeneratorSelect menuKey="edit-quality" openMenu={openEditMenu} setOpenMenu={setOpenEditMenu} className="media-edit-quality" value={editResolution} label="QUALITY" options={(editModel?.resolutions || ["1K"]).map((resolution) => ({ value: resolution, label: resolution }))} onChange={(value) => {
                setEditResolution(value);
                const nextRatios = generatorRatiosFor(editModel, value, true);
                if (editSize !== "original" && !nextRatios.includes(editSize)) setEditSize("original");
              }} />
            </div>
            <div className="media-edit-actions">
              <ImageEditReferencePicker
                source={{ url: assetThumbnailUrl(url), title: node.data.title, personaId: persona?.id, personaName: persona?.name, personaVariant: persona?.variant }}
                canvasReferences={editCanvasReferences}
                personas={editPersonas}
                selected={editReferences}
                maxAdditional={maxAdditionalReferences}
                disabled={submitting}
                onChange={changeEditReferences}
                onUpload={onUploadEditReferences}
              />
              <button type="button" className="media-edit-helper" title="Improve this edit request with Assistant" aria-label="Improve with assistant" disabled={!editRequest.trim() || refining || submitting} onPointerDown={() => void refine()}>{refining ? <span className="generator-spinner" /> : <Sparkles size={14} />}</button>
              <div className="media-edit-run">
                <span id={`media-edit-cost-${node.id}`} role="tooltip" className="generator-credit-tooltip">Run {editCredits} credits</span>
                <button type="button" className="media-edit-submit" aria-label={`Create edited version · ${editCredits} credits`} aria-describedby={`media-edit-cost-${node.id}`} disabled={!editRequest.trim() || refining || submitting} onPointerDown={() => void submit()}>{submitting ? <span className="generator-spinner" /> : <Play size={14} fill="currentColor" />}</button>
              </div>
            </div>
          </div>}
        </section>

        {mode === "view" && <aside className="media-viewer-details">
          <div className="media-viewer-quick-actions">
            {editable && <button type="button" title="Edit image" aria-label="Edit image" onPointerDown={() => setMode("edit")}><WandSparkles size={14} /></button>}
            <a href={assetDownloadUrl(url)} download title="Download current media" aria-label="Download current media"><Download size={14} /></a>
            {onDelete && <button type="button" className="is-danger" title="Delete node" aria-label="Delete node" onPointerDown={onDelete}><Trash2 size={14} /></button>}
          </div>
          <div className="media-viewer-context"><strong>{mediaTitle || relativeTime(createdAt)}</strong><span>{projectName} / {canvasName}</span></div>
          {node.data.prompt && <section><label>PROMPT</label><p className="media-viewer-prompt" title={node.data.prompt}>{node.data.prompt}</p></section>}
          <section><label>SETTINGS</label><div className="media-viewer-chips"><span>{model?.label || (node.data.kind === "prompt" ? "Image generation" : "Original media")}</span><span>{node.data.aspectRatio || "Original ratio"}</span>{node.data.resolution && <span>{node.data.resolution}</span>}{node.data.role && <span>{node.data.role}</span>}</div></section>
          {persona && <section><label>IDENTITY</label><div className="media-viewer-persona">{persona.avatarUrl ? <img src={persona.avatarUrl} alt={persona.name} /> : references.find((reference) => reference.personaId)?.url ? <img src={references.find((reference) => reference.personaId)?.url} alt={persona.name} /> : null}<span><strong>{persona.name}</strong><small>{persona.variant ? `${persona.variant[0].toUpperCase()}${persona.variant.slice(1)} references` : "Identity references"}</small></span></div></section>}
          {references.length > 0 && <section><label>REFERENCES</label><div className="media-viewer-references">{references.map((reference) => <figure key={reference.id}><img src={reference.url} alt={reference.title} /><figcaption>{reference.title}</figcaption></figure>)}</div></section>}
          <div className="media-viewer-spacer" />
          <div className="media-viewer-side-actions">
            {!isVideo && node.data.assetId && <AddToIdentityPopover variant="wide" personas={identities} sourceUrl={url} sourceAssetId={node.data.assetId} onAdd={onAddToIdentity} onCreate={onCreateIdentityFromAsset} />}
            {editable && <button type="button" className="is-primary" onPointerDown={() => setMode("edit")}><WandSparkles size={14} />Edit image</button>}
          </div>
        </aside>}

      </div>
    </div>
  </div>;
}
