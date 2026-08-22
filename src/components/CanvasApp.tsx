"use client";

/* eslint-disable @next/next/no-img-element */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction } from "react";
import {
  BaseEdge,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  applyEdgeChanges,
  applyNodeChanges,
  getBezierPath,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type EdgeProps,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ChevronDown,
  Check,
  BarChart3,
  Boxes,
  Bookmark,
  CalendarDays,
  Clapperboard,
  Copy,
  Download,
  Eye,
  ExternalLink,
  ImagePlus,
  Images,
  LoaderCircle,
  LayoutGrid,
  Heart,
  Hand,
  MousePointer2,
  Plus,
  Quote,
  MessageCircle,
  Redo2,
  RefreshCcw,
  Search,
  Scissors,
  Share2,
  Settings2,
  Sparkles,
  StickyNote,
  Undo2,
  Upload,
  UserRound,
  Video,
  Workflow,
  X,
} from "lucide-react";
import { assetDirectUrl, assetDownloadUrl, assetThumbnailUrl, FrameNodeCard, GeneratorNodeContext, OPEN_NODE_CREATOR_EVENT, OPEN_VIDEO_EDITOR_EVENT, generatorModelCreditDescription, generatorRatiosFor, generatorResolutionsFor, generatorSettingsForModel, type GeneratorModelOption } from "./FrameNode";
import { InspectorSelect } from "./InspectorSelect";
import { TikTokAutomationPanel, type TikTokAutomationSlideState, type TikTokAutomationStage, type TikTokAutomationStatus } from "./TikTokAutomationPanel";
import { MediaViewer, type ImageEditOptions } from "./MediaViewer";
import { VideoEditorViewer, type VideoEditorReference } from "./VideoEditorViewer";
import type { ImageEditPersona, ImageEditReference } from "./ImageEditReferencePicker";
import { ProfileMenu } from "./ProfileMenu";
import { CommunityPanelRouter, NotificationBell, TaskCenter, communityRailItems, type CommunityPanelKind } from "./CommunityPanels";
import { AccountOverlayExtension } from "@/distribution/account-extension";
import { PendingTeamInvitations } from "./PendingTeamInvitations";
import BrandMark from "./BrandMark";
import type { BackgroundTaskRecord, FrameEdge, FrameNode, GeneratorInputRole, HookRecord, LibraryMediaAsset, PersonaRecord, ProjectRecord, UserRecord, VideoMasterClip, VideoSceneSegment, WorkspaceRecord } from "@/lib/types";
import { editReferenceMentionToken, referenceMentionToken } from "@/lib/reference-mentions";
import { MAX_GENERATION_BATCH, settleWithConcurrency } from "@/lib/generation-queue";
import { generationCreditCost } from "@/lib/generation-pricing";
import { tiktokPlanningReserveCredits } from "@/lib/automation-pricing";
import { DEFAULT_ASSISTANT_MODEL_ID, tiktokAutomationPlanningModels } from "@/lib/assistant-models";
import type { TikTokAutomationMode, TikTokAutomationPlanResponse, TikTokTextStrategy } from "@/lib/tiktok-automation-types";
import { duplicateGraphSelection, generatorInputCapacity, generatorSourceAssetIds, normalizeEdgePorts, selectGraphNode, stableGraphEdges, stableGraphNodes, upsertGraphEdge } from "@/lib/canvas-graph";
import { assetIdFromAssetUrl, compatibleMasterReferences, hydrateVideoMasterSourceClips, masterClipOriginalReference, nearestVideoMasterRatio, resolveVideoMasterSourceTarget, shouldIncludeAutomaticMasterVideoReference, videoMasterClipExportMedia, videoMasterClipPlaybackMedia, videoMasterClipThumbnail, videoMasterGenerationDuration, videoMasterModelsForScene, videoMasterProviderAspectRatio, videoMasterSourceRatio, videoMasterTimelineDuration, type VideoMasterDownloadLane } from "@/lib/video-master";
import { stopAllVideoPlayback } from "@/lib/video-playback-owner";
import { findTikTokSlideshowSources, type TikTokSlideshowSource } from "@/lib/tiktok-slideshow-sources";
import { useCanvasCollaboration } from "@/lib/use-canvas-collaboration";
import type { UsageSummary } from "@/modules/usage/contracts";

const DisconnectEdgeContext = createContext<((edgeId: string) => void) | null>(null);

function DisconnectableEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style }: EdgeProps<FrameEdge>) {
  const disconnect = useContext(DisconnectEdgeContext);
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  return <>
    <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
    <foreignObject className="edge-cut-foreign" x={labelX - 15} y={labelY - 15} width="30" height="30"><button type="button" className="edge-cut-button nodrag nopan" aria-label="Disconnect nodes" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); disconnect?.(id); }}><Scissors size={11} /></button></foreignObject>
  </>;
}

const nodeTypes = { frameNode: FrameNodeCard };
const edgeTypes = { disconnectable: DisconnectableEdge };

const canvasLoadingTwinkleLayers = [
  { size: "72px 54px", position: "0 0", duration: "3.7s", delay: "-1.8s", peak: ".46" },
  { size: "90px 72px", position: "36px 18px", duration: "4.9s", delay: "-3.6s", peak: ".38" },
  { size: "126px 90px", position: "18px 54px", duration: "5.8s", delay: "-2.2s", peak: ".52" },
  { size: "108px 126px", position: "72px 36px", duration: "4.3s", delay: "-4.1s", peak: ".34" },
  { size: "162px 108px", position: "54px 90px", duration: "6.4s", delay: "-5.3s", peak: ".43" },
  { size: "144px 162px", position: "108px 72px", duration: "5.1s", delay: "-1.1s", peak: ".31" },
  { size: "198px 126px", position: "126px 18px", duration: "7.2s", delay: "-6.6s", peak: ".48" },
] as const;

function CanvasLoadingDotField() {
  return <div className="canvas-loading-dot-field" aria-hidden="true">
    {canvasLoadingTwinkleLayers.map((layer, index) => <i key={index} style={{
      "--twinkle-size": layer.size,
      "--twinkle-position": layer.position,
      "--twinkle-duration": layer.duration,
      "--twinkle-delay": layer.delay,
      "--twinkle-peak": layer.peak,
    } as CSSProperties} />)}
  </div>;
}

type PersonaUploadState = { files: File[]; progress: number };

function uploadFormData<T>(url: string, method: "POST" | "PATCH", formData: FormData, onProgress: (progress: number) => void) {
  return new Promise<T>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(method, url);
    request.responseType = "json";
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.max(1, Math.min(99, Math.round((event.loaded / event.total) * 100))));
    };
    request.onerror = () => reject(new Error("Upload connection failed"));
    request.onload = () => {
      const body = (request.response || {}) as T & { error?: string };
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(body.error || "Upload failed"));
        return;
      }
      onProgress(100);
      resolve(body);
    };
    request.send(formData);
  });
}

type UploadedMediaAsset = {
  id: string;
  url: string;
  filename: string;
  originalName?: string;
  mediaType: "image" | "video";
  mimeType: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
  aspectRatio?: number;
};

type DirectUploadPlan = {
  assetId: string;
  token: string;
  partSize: number;
  parts: Array<{ partNumber: number; url: string }>;
};

function putUploadPart(url: string, body: Blob, onProgress: (loaded: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.upload.onprogress = (event) => onProgress(event.loaded);
    request.onerror = () => reject(new Error("Upload connection failed"));
    request.onload = () => request.status >= 200 && request.status < 300
      ? resolve()
      : reject(new Error(`Storage rejected an upload part (${request.status})`));
    request.send(body);
  });
}

async function uploadMediaFiles(projectId: string, purpose: "library" | "canvas" | "edit-reference", files: File[], onProgress: (progress: number) => void = () => undefined) {
  const preparedResponse = await fetch("/api/assets/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, purpose, files: files.map((file) => ({ name: file.name, type: file.type, size: file.size })) }),
  });
  const prepared = (await preparedResponse.json().catch(() => ({}))) as { error?: string; mode?: "direct" | "proxy"; uploads?: DirectUploadPlan[] };
  if (!preparedResponse.ok) throw new Error(prepared.error || "Could not prepare upload");
  if (prepared.mode !== "direct" || !prepared.uploads?.length) {
    const form = new FormData();
    form.set("projectId", projectId);
    if (purpose !== "canvas") form.set("purpose", purpose);
    files.forEach((file) => form.append(purpose === "edit-reference" ? "images" : "files", file));
    return uploadFormData<{ assets?: UploadedMediaAsset[]; error?: string }>("/api/assets", "POST", form, onProgress);
  }
  if (prepared.uploads.length !== files.length) throw new Error("Storage prepared an incomplete upload batch");
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  const loadedByPart = new Map<string, number>();
  const report = (key: string, loaded: number) => {
    loadedByPart.set(key, loaded);
    const uploaded = [...loadedByPart.values()].reduce((total, value) => total + value, 0);
    onProgress(Math.max(1, Math.min(99, Math.round((uploaded / totalBytes) * 100))));
  };
  const completed: UploadedMediaAsset[] = [];
  try {
    for (const [fileIndex, plan] of prepared.uploads.entries()) {
      const file = files[fileIndex];
      let nextPart = 0;
      const workers = Array.from({ length: Math.min(3, plan.parts.length) }, async () => {
        while (nextPart < plan.parts.length) {
          const partIndex = nextPart++;
          const part = plan.parts[partIndex];
          const start = (part.partNumber - 1) * plan.partSize;
          const blob = file.slice(start, Math.min(file.size, start + plan.partSize));
          const progressKey = `${fileIndex}:${part.partNumber}`;
          let failure: unknown;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              await putUploadPart(part.url, blob, (loaded) => report(progressKey, loaded));
              report(progressKey, blob.size);
              failure = null;
              break;
            } catch (error) {
              failure = error;
              if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 500 * (2 ** attempt)));
            }
          }
          if (failure) throw failure;
        }
      });
      await Promise.all(workers);
      const completeResponse = await fetch("/api/assets/uploads/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: plan.token }),
      });
      const complete = (await completeResponse.json().catch(() => ({}))) as { error?: string; asset?: UploadedMediaAsset };
      if (!completeResponse.ok || !complete.asset) throw new Error(complete.error || "Could not finish upload");
      completed.push(complete.asset);
    }
    onProgress(100);
    return { assets: completed };
  } catch (error) {
    await Promise.allSettled(prepared.uploads.map((plan) => fetch("/api/assets/uploads/abort", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: plan.token }),
    })));
    throw error;
  }
}

function PersonaFilePreview({ file, index, progress, onRemove }: { file: File; index: number; progress?: number; onRemove?: () => void }) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <figure className={`identity-file-preview ${progress !== undefined && progress < 100 ? "is-uploading" : ""}`}>
    {url && <img src={url} alt={`Selected reference ${index + 1}`} />}
    <figcaption>{String(index + 1).padStart(2, "0")}</figcaption>
    {onRemove && <button type="button" aria-label={`Remove ${file.name}`} title="Remove reference" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onRemove(); }}><X size={11} /></button>}
    {progress !== undefined && progress < 100 && <div className="identity-file-progress"><span style={{ width: `${progress}%` }} /><b>{progress}%</b></div>}
  </figure>;
}

type ModelOption = GeneratorModelOption;

const legacyGenerationModelIds: Record<string, string> = {
  "nano-banana-pro-flash": "nano-banana-2",
  "flux-kontext-pro": "flux-2-flex",
  "flux-2-turbo": "flux-2-flex",
  "flux-2-klein": "flux-2-flex",
  "seedream-v4": "seedream-5-lite",
  "flux-2-pro": "flux-2-flex",
  "mystic-realism": "flux-2-flex",
  "wan-2-5-t2v-720p": "wan-2-7",
  "wan-2-5-i2v-1080p": "wan-2-7",
  "wan-2-7-i2v": "wan-2-7",
  "runway-4-5-i2v": "seedance-2-fast",
  "kling-v3-pro": "kling-3",
  "kling-v3-std": "kling-3",
};

function canonicalGeneratorRole(modelId: string | undefined, role: string | undefined): GeneratorInputRole {
  const validRoles = new Set<GeneratorInputRole>(["reference-image", "start-frame", "end-frame", "motion-video", "reference-video", "reference-audio"]);
  const normalizedRole = role === "image" || role === "input" ? "reference-image" : role;
  const resolved = validRoles.has(normalizedRole as GeneratorInputRole) ? normalizedRole as GeneratorInputRole : "reference-image";
  if (modelId === "kling-3-motion") {
    if (resolved === "reference-image") return "start-frame";
    if (resolved === "motion-video") return "reference-video";
  }
  return resolved;
}

type NodeCreatorState = { nodeId: string; clientX: number; clientY: number; segment?: VideoSceneSegment; intent?: "video-master" | "video-master-replace" } | null;
type GraphSnapshot = { nodes: FrameNode[]; edges: FrameEdge[] };
type TikTokAutomationSourceOption = TikTokSlideshowSource;
type TikTokAutomationJobResponse = {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  stage: string;
  stageLabel: string;
  progress: number;
  result: TikTokAutomationPlanResponse | null;
  error: string | null;
  code: string | null;
  httpStatus: number | null;
  queuePosition: number | null;
};

function automationUiStage(stage: string): TikTokAutomationStage {
  if (stage === "text_sequence") return "rewrite";
  if (stage === "reference_binding") return "references";
  if (stage === "slide_prompt_planning") return "direct";
  if (["series_review", "series_repair", "series_recheck", "finalizing", "completed"].includes(stage)) return "review";
  if (stage === "brief_interpretation") return "decompose";
  return "analyze";
}

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatMetric(value: number) {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value || 0);
}

function isAcceptedPersonaImage(file: File) {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  return ["image/jpeg", "image/jpg", "image/png"].includes(type) || /\.(jpe?g|png)$/.test(name);
}

function isAcceptedCanvasMedia(file: File) {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  return ["image/jpeg", "image/jpg", "image/png", "video/mp4", "video/webm", "video/quicktime", "video/x-m4v"].includes(type)
    || /\.(jpe?g|png|mp4|webm|mov|m4v)$/.test(name);
}

function isAcceptedLibraryMedia(file: File) {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  return ["image/jpeg", "image/jpg", "image/png", "video/mp4", "video/webm", "video/quicktime", "video/x-m4v"].includes(type)
    || /\.(jpe?g|png|mp4|webm|mov|m4v)$/.test(name);
}

const LIBRARY_MAX_FILES = 20;
const LIBRARY_MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const LIBRARY_MAX_VIDEO_BYTES = 250 * 1024 * 1024;
const LIBRARY_MAX_TOTAL_BYTES = 280 * 1024 * 1024;

function isLibraryVideo(file: File) {
  return file.type.toLowerCase().startsWith("video/") || /\.(mp4|webm|mov|m4v)$/i.test(file.name);
}

function libraryMediaFileError(file: File) {
  if (!isAcceptedLibraryMedia(file)) return `${file.name}: unsupported file type`;
  const limit = isLibraryVideo(file) ? LIBRARY_MAX_VIDEO_BYTES : LIBRARY_MAX_IMAGE_BYTES;
  if (file.size > limit) return `${file.name}: ${isLibraryVideo(file) ? "video" : "image"} exceeds ${formatBytes(limit)}`;
  return "";
}

function mediaTitle(filename: string, fallback: string) {
  const title = filename.replace(/\.(jpe?g|png|webp|mp4|webm|mov|m4v)$/i, "").replace(/[_-]+/g, " ").trim();
  return title || fallback;
}

const MAX_PERSONA_REFERENCES = 100;

function projectStats(project: ProjectRecord) {
  if (project.summary) return project.summary;
  const graphNodes = project.graph.nodes || [];
  return {
    scenes: graphNodes.filter((node) => node.data.kind === "scene").length,
    prompts: graphNodes.filter((node) => node.data.kind === "prompt").length,
    outputs: graphNodes.filter((node) => node.data.kind === "generation" || Boolean(node.data.outputUrl)).length,
    previews: graphNodes.filter((node) => node.data.kind === "scene" && node.data.mediaType !== "video" && node.data.imageUrl).slice(0, 3).map((node) => ({ id: node.id, imageUrl: String(node.data.imageUrl) })),
  };
}

function projectSaveSignature(project: ProjectRecord, graphNodes: FrameNode[], graphEdges: FrameEdge[], viewport = project.graph.viewport) {
  return JSON.stringify({ name: project.name, sourceUrl: project.sourceUrl, nodes: graphNodes, edges: graphEdges, viewport });
}

const projectSessionCachePrefix = "scenelith:canvas-graph:v1:";

function readProjectSessionCache(projectId: string, expectedRevision?: number) {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(`${projectSessionCachePrefix}${projectId}`);
    if (!raw) return null;
    const cached = JSON.parse(raw) as ProjectRecord;
    if (cached.id !== projectId || (expectedRevision && cached.revision !== expectedRevision)) return null;
    if (!Array.isArray(cached.graph?.nodes) || !Array.isArray(cached.graph?.edges)) return null;
    return cached;
  } catch {
    return null;
  }
}

function writeProjectSessionCache(project: ProjectRecord) {
  if (typeof window === "undefined") return;
  const key = `${projectSessionCachePrefix}${project.id}`;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(project));
  } catch {
    // Canvas graphs are small, but a long-lived tab can outgrow its storage
    // quota. Drop only our disposable graph cache and retry the current item.
    Object.keys(window.sessionStorage)
      .filter((candidate) => candidate.startsWith(projectSessionCachePrefix))
      .forEach((candidate) => window.sessionStorage.removeItem(candidate));
    try { window.sessionStorage.setItem(key, JSON.stringify(project)); } catch {}
  }
}

function applyModelCatalogue(graphNodes: FrameNode[], graphEdges: FrameEdge[], models: ModelOption[]) {
  return hydrateVideoMasterSourceClips(graphNodes).map((node) => {
    const modelId = node.data.modelId ? legacyGenerationModelIds[node.data.modelId] || node.data.modelId : undefined;
    if (!modelId) return node;
    const model = models.find((item) => item.id === modelId);
    if (!model) return node;
    const hasReferences = Boolean(node.data.attachedReferences?.length) || graphEdges.some((edge) => edge.target === node.id && edge.data?.portType !== "text" && edge.targetHandle !== "text-input");
    const hasVideoInput = Boolean(node.data.attachedReferences?.some((reference) => reference.role === "reference-video" || reference.role === "motion-video"))
      || graphEdges.some((edge) => edge.target === node.id && (edge.data?.inputRole === "reference-video" || edge.data?.inputRole === "motion-video"));
    const resolutions = generatorResolutionsFor(model, hasVideoInput);
    const resolution = resolutions.includes(String(node.data.resolution)) ? String(node.data.resolution) : resolutions.includes(model.defaultResolution || "") ? model.defaultResolution! : resolutions[0] || String(node.data.resolution || "1K");
    const ratios = generatorRatiosFor(model, resolution, hasReferences);
    return {
      ...node,
      data: {
        ...node.data,
        modelId,
        mediaType: model.mediaType,
        aspectRatio: (ratios.includes(String(node.data.aspectRatio)) ? node.data.aspectRatio : ratios.includes(model.defaultRatio || "") ? model.defaultRatio : ratios[0] || node.data.aspectRatio) as FrameNode["data"]["aspectRatio"],
        resolution: resolution as FrameNode["data"]["resolution"],
        duration: (model.durations?.includes(String(node.data.duration)) ? node.data.duration : model.defaultDuration || model.durations?.[0] || node.data.duration) as FrameNode["data"]["duration"],
        generateAudio: node.data.generateAudio ?? model.defaultGenerateAudio ?? false,
      },
    };
  });
}

function CanvasWorkspace({ initialProject, projects: initialProjects, initialWorkspace, workspaces: initialWorkspaces, user, creditUsage, initialModels }: { initialProject: ProjectRecord; projects: ProjectRecord[]; initialWorkspace: WorkspaceRecord; workspaces: WorkspaceRecord[]; user: UserRecord; creditUsage: UsageSummary; initialModels: ModelOption[] }) {
  const { fitView, setViewport, screenToFlowPosition } = useReactFlow<FrameNode, FrameEdge>();
  const initialCanvasGraph = useMemo(() => {
    const graphNodes = stableGraphNodes(initialProject.graph.nodes || []);
    const graphEdges = normalizeEdgePorts(initialProject.graph.edges || [], graphNodes);
    return { nodes: applyModelCatalogue(graphNodes, graphEdges, initialModels), edges: graphEdges };
  }, [initialModels, initialProject]);
  const [projects, setProjects] = useState(initialProjects);
  const [project, setProject] = useState(initialProject);
  const [projectNameDraft, setProjectNameDraft] = useState(initialProject.name);
  const [workspaces, setWorkspaces] = useState(initialWorkspaces);
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [liveCreditUsage, setLiveCreditUsage] = useState(creditUsage);
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  const [inlineWorkspaceName, setInlineWorkspaceName] = useState("");
  const [nodes, setNodesState] = useState<FrameNode[]>(() => initialCanvasGraph.nodes);
  const [edges, setEdgesState] = useState<FrameEdge[]>(() => initialCanvasGraph.edges);
  const [sourceUrl, setSourceUrl] = useState("");
  const [selectedId, setSelectedIdState] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const setSelectedId = useCallback((nodeId: string | null) => {
    selectedIdRef.current = nodeId;
    setSelectedIdState(nodeId);
  }, []);
  const [personas, setPersonas] = useState<PersonaRecord[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [personaFormOpen, setPersonaFormOpen] = useState(false);
  const [personaDraftFiles, setPersonaDraftFiles] = useState<{ reference: File[]; before: File[]; after: File[] }>({ reference: [], before: [], after: [] });
  const [personaSaving, setPersonaSaving] = useState(false);
  const [personaSaveProgress, setPersonaSaveProgress] = useState(0);
  const [personaUploads, setPersonaUploads] = useState<Record<string, PersonaUploadState>>({});
  const [deletingPersonaAssetIds, setDeletingPersonaAssetIds] = useState<string[]>([]);
  const [personaAssetDrag, setPersonaAssetDrag] = useState<{ personaId: string; role: "reference" | "before" | "after"; assetId: string } | null>(null);
  const [personaAssetDragOverId, setPersonaAssetDragOverId] = useState<string | null>(null);
  const [personaReorderSavingKey, setPersonaReorderSavingKey] = useState<string | null>(null);
  const [personaMode, setPersonaMode] = useState<"single" | "transformation">("single");
  const [selectedPersonaAssets, setSelectedPersonaAssets] = useState<Record<string, string[]>>({});
  const [identityLibraryOpen, setIdentityLibraryOpen] = useState(false);
  const [librarySection, setLibrarySection] = useState<"media" | "identities">("media");
  const [libraryAssets, setLibraryAssets] = useState<LibraryMediaAsset[]>([]);
  const [libraryCounts, setLibraryCounts] = useState({ all: 0, image: 0, video: 0 });
  const [libraryMediaFilter, setLibraryMediaFilter] = useState<"all" | "image" | "video">("all");
  const [libraryProjectFilter, setLibraryProjectFilter] = useState("all");
  const [libraryCanvasMenuOpen, setLibraryCanvasMenuOpen] = useState(false);
  const [librarySearch, setLibrarySearch] = useState("");
  const [libraryCursor, setLibraryCursor] = useState<string | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryLoadingMore, setLibraryLoadingMore] = useState(false);
  const [libraryError, setLibraryError] = useState("");
  const [libraryRefreshToken, setLibraryRefreshToken] = useState(0);
  const [libraryUploadBusy, setLibraryUploadBusy] = useState(false);
  const [libraryUploadOpen, setLibraryUploadOpen] = useState(false);
  const [libraryUploadFiles, setLibraryUploadFiles] = useState<File[]>([]);
  const [libraryUploadError, setLibraryUploadError] = useState("");
  const [libraryUploadDragActive, setLibraryUploadDragActive] = useState(false);
  const [libraryUploadProgress, setLibraryUploadProgress] = useState(0);
  const [personaDragActive, setPersonaDragActive] = useState(false);
  const [projectLibraryOpen, setProjectLibraryOpen] = useState(false);
  const [projectSwitchingId, setProjectSwitchingId] = useState<string | null>(null);
  const [projectHydratingId, setProjectHydratingId] = useState<string | null>(initialProject.id);
  const [workspaceLibraryOpen, setWorkspaceLibraryOpen] = useState(false);
  const [newWorkspaceFormOpen, setNewWorkspaceFormOpen] = useState(false);
  const [hookLibraryOpen, setHookLibraryOpen] = useState(false);
  const [communityFocus, setCommunityFocus] = useState<{ kind: CommunityPanelKind; id?: string; nonce: number } | null>(null);
  const [tiktokAutomationOpen, setTikTokAutomationOpen] = useState(false);
  const [automationSourceId, setAutomationSourceId] = useState("");
  const [automationMode, setAutomationMode] = useState<TikTokAutomationMode>("concept");
  const [automationPersonaId, setAutomationPersonaId] = useState("");
  const [automationModelId, setAutomationModelId] = useState("");
  const [automationPlanningModelId, setAutomationPlanningModelId] = useState(DEFAULT_ASSISTANT_MODEL_ID);
  const [automationNewOutfit, setAutomationNewOutfit] = useState(true);
  const [automationNewLocation, setAutomationNewLocation] = useState(true);
  const [automationTextStrategy, setAutomationTextStrategy] = useState<TikTokTextStrategy>("rewrite");
  const [automationCreativeBrief, setAutomationCreativeBrief] = useState("");
  const [automationStatus, setAutomationStatus] = useState<TikTokAutomationStatus>("idle");
  const [automationStage, setAutomationStage] = useState<TikTokAutomationStage>("ready");
  const [automationStageLabel, setAutomationStageLabel] = useState("Ready to analyze");
  const [automationPlanningProgress, setAutomationPlanningProgress] = useState(0);
  const [automationPlan, setAutomationPlan] = useState<TikTokAutomationPlanResponse | null>(null);
  const [automationSlideStates, setAutomationSlideStates] = useState<TikTokAutomationSlideState[]>([]);
  const [hooks, setHooks] = useState<HookRecord[]>([]);
  const [hookBusy, setHookBusy] = useState(false);
  const hookVariantCount = 1;
  const [nodeHookSettingsOpen, setNodeHookSettingsOpen] = useState(false);
  const [selectedVariantByHook, setSelectedVariantByHook] = useState<Record<string, number>>({});
  const [hookSearch, setHookSearch] = useState("");
  const [hookFilter, setHookFilter] = useState<"all" | "original" | "manual" | "generated">("all");
  const [roleSaveState, setRoleSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [newProjectFormOpen, setNewProjectFormOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const [recipeImporting, setRecipeImporting] = useState(false);
  const recipeImportInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved">("idle");
  const [notice, setNotice] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generatingNodeIds, setGeneratingNodeIds] = useState<string[]>([]);
  const [backgroundGenerationNodeIds, setBackgroundGenerationNodeIds] = useState<string[]>([]);
  const [preparingMasterClipIds, setPreparingMasterClipIds] = useState<Record<string, string>>({});
  const [runningAssistantNodeId, setRunningAssistantNodeId] = useState<string | null>(null);
  const [previewNode, setPreviewNode] = useState<FrameNode | null>(null);
  const [previewMedia, setPreviewMedia] = useState<{ url: string; start?: number; end?: number; title?: string } | null>(null);
  const [previewMode, setPreviewMode] = useState<"view" | "edit">("view");
  const [refreshingStats, setRefreshingStats] = useState(false);
  const [copiedPostLink, setCopiedPostLink] = useState(false);
  const models = initialModels;
  const [nodeCreator, setNodeCreator] = useState<NodeCreatorState>(null);
  const [canvasMode, setCanvasMode] = useState<"select" | "pan">("select");
  const [canvasAddMenuOpen, setCanvasAddMenuOpen] = useState(false);
  const [canvasMediaDragActive, setCanvasMediaDragActive] = useState(false);
  const [accountView, setAccountView] = useState<"access" | "credits" | null>(null);
  const [historyControls, setHistoryControls] = useState({ canUndo: false, canRedo: false });
  const initialHydration = useRef(true);
  const lastSavedRole = useRef(initialWorkspace.rolePrompt);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const localNodesStateRef = useRef(nodes);
  const localEdgesStateRef = useRef(edges);
  const segmentMaterializationJobsRef = useRef(new Map<string, Promise<{ id: string; url: string; durationSeconds: number }>>());
  const preparingMasterClipIdsRef = useRef<Record<string, string>>({});
  const pastRef = useRef<GraphSnapshot[]>([]);
  const futureRef = useRef<GraphSnapshot[]>([]);
  const restoringHistoryRef = useRef(false);
  const skipEdgeHistoryUntilRef = useRef(0);
  const lastCanvasPointerRef = useRef<{ x: number; y: number } | null>(null);
  const canvasMediaInputRef = useRef<HTMLInputElement>(null);
  const canvasClipboardRef = useRef<{ graph: GraphSnapshot; nodeIds: string[]; pasteCount: number } | null>(null);
  const usageRefreshSequence = useRef(0);
  const projectSwitchSequence = useRef(0);
  const projectHydratingIdRef = useRef<string | null>(initialProject.id);
  const projectCacheRef = useRef(new Map<string, ProjectRecord>([[initialProject.id, initialProject]]));
  const dirtyProjectIdsRef = useRef(new Set<string>());
  const projectGraphRevisionRef = useRef<Record<string, number>>({ [initialProject.id]: 0 });
  const viewportRef = useRef(initialProject.graph.viewport || { x: 0, y: 0, zoom: 1 });
  const viewportSaveTimerRef = useRef<number | null>(null);
  const dirtyTrackingProjectRef = useRef(initialProject.id);
  const dirtyTrackingReadyRef = useRef(false);
  const savedProjectSignatures = useRef<Record<string, string>>({});
  if (!savedProjectSignatures.current[initialProject.id]) {
    savedProjectSignatures.current[initialProject.id] = projectSaveSignature(
      initialProject,
      initialCanvasGraph.nodes,
      initialCanvasGraph.edges,
      initialProject.graph.viewport,
    );
  }
  const automationCameraRequestRef = useRef(0);
  const restoredTaskStateRef = useRef<Record<string, string>>({});
  const selectedNode = nodes.find((node) => node.id === selectedId) || null;
  const applyCollaborativeGraph = useCallback((graph: ProjectRecord["graph"]) => {
    const stableNodes = stableGraphNodes(graph.nodes || []);
    const normalizedEdges = normalizeEdgePorts(graph.edges || [], stableNodes);
    const hydratedNodes = applyModelCatalogue(stableNodes, normalizedEdges, models);
    const localSelectedId = selectedIdRef.current;
    const selectedNodeStillExists = Boolean(localSelectedId && hydratedNodes.some((node) => node.id === localSelectedId));
    const viewNodes = selectedNodeStillExists && localSelectedId
      ? selectGraphNode(hydratedNodes, localSelectedId)
      : hydratedNodes;
    if (localSelectedId && !selectedNodeStillExists) {
      selectedIdRef.current = null;
      setSelectedIdState(null);
    }
    initialHydration.current = true;
    dirtyTrackingProjectRef.current = "";
    nodesRef.current = viewNodes;
    edgesRef.current = normalizedEdges;
    localNodesStateRef.current = viewNodes;
    localEdgesStateRef.current = normalizedEdges;
    setNodesState(viewNodes);
    setEdgesState(normalizedEdges);
    setProject((current) => current.id === project.id ? { ...current, graph: { ...graph, nodes: stableNodes, edges: normalizedEdges } } : current);
    projectCacheRef.current.set(project.id, {
      ...(projectCacheRef.current.get(project.id) || project),
      graph: { ...graph, nodes: stableNodes, edges: normalizedEdges },
    });
    if (projectHydratingIdRef.current === project.id) {
      projectHydratingIdRef.current = null;
      setProjectHydratingId(null);
      setProjectSwitchingId(null);
    }
  }, [models, project]);
  const { status: collaborationStatus, ready: collaborationReady, collaborators, mutate: mutateCollaborativeGraph, flush: flushCollaborativeGraph } = useCanvasCollaboration({ projectId: project.id, user, onRemoteGraph: applyCollaborativeGraph });
  const mutateCollaborativeGraphRef = useRef(mutateCollaborativeGraph);
  mutateCollaborativeGraphRef.current = mutateCollaborativeGraph;
  const setNodes = useCallback<Dispatch<SetStateAction<FrameNode[]>>>((action) => {
    const previous = localNodesStateRef.current;
    const next = typeof action === "function" ? action(previous) : action;
    localNodesStateRef.current = next;
    nodesRef.current = next;
    mutateCollaborativeGraphRef.current(
      { nodes: stableGraphNodes(previous), edges: stableGraphEdges(localEdgesStateRef.current) },
      { nodes: stableGraphNodes(next), edges: stableGraphEdges(localEdgesStateRef.current) },
    );
    setNodesState(next);
  }, []);
  const setEdges = useCallback<Dispatch<SetStateAction<FrameEdge[]>>>((action) => {
    const previous = localEdgesStateRef.current;
    const next = typeof action === "function" ? action(previous) : action;
    localEdgesStateRef.current = next;
    edgesRef.current = next;
    mutateCollaborativeGraphRef.current(
      { nodes: stableGraphNodes(localNodesStateRef.current), edges: stableGraphEdges(previous) },
      { nodes: stableGraphNodes(localNodesStateRef.current), edges: stableGraphEdges(next) },
    );
    setEdgesState(next);
  }, []);
  const commitGraph = useCallback((nextNodes: FrameNode[], nextEdges: FrameEdge[]) => {
    const previousNodes = localNodesStateRef.current;
    const previousEdges = localEdgesStateRef.current;
    localNodesStateRef.current = nextNodes;
    localEdgesStateRef.current = nextEdges;
    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
    mutateCollaborativeGraphRef.current(
      { nodes: stableGraphNodes(previousNodes), edges: stableGraphEdges(previousEdges) },
      { nodes: stableGraphNodes(nextNodes), edges: stableGraphEdges(nextEdges) },
    );
    setNodesState(nextNodes);
    setEdgesState(nextEdges);
  }, []);
  const loadProjectRecord = useCallback((projectId: string, expectedRevision?: number) => {
    const cached = projectCacheRef.current.get(projectId);
    if (cached && (!expectedRevision || cached.revision === expectedRevision || dirtyProjectIdsRef.current.has(projectId))) return Promise.resolve(cached);
    const sessionCached = readProjectSessionCache(projectId, expectedRevision);
    if (sessionCached) {
      projectCacheRef.current.set(projectId, sessionCached);
      return Promise.resolve(sessionCached);
    }
    return fetch(`/api/projects/${projectId}`, { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as { project?: ProjectRecord };
        if (!response.ok || !body.project) return null;
        projectCacheRef.current.set(projectId, body.project);
        writeProjectSessionCache(body.project);
        return body.project;
      })
      .catch(() => null);
  }, []);
  useEffect(() => { writeProjectSessionCache(initialProject); }, [initialProject]);
  const activeGenerationNodeIds = useMemo(() => Array.from(new Set([...generatingNodeIds, ...backgroundGenerationNodeIds])), [backgroundGenerationNodeIds, generatingNodeIds]);
  const openCommunityPanel = useCallback((kind: CommunityPanelKind, id?: string) => {
    if (kind === "admin" && !user.isAdmin) return;
    setCommunityFocus({ kind, id, nonce: Date.now() });
    setTikTokAutomationOpen(false);
    setHookLibraryOpen(false);
    setIdentityLibraryOpen(false);
    setProjectLibraryOpen(false);
    setWorkspaceLibraryOpen(false);
  }, [user.isAdmin]);
  const refreshUsage = useCallback(async () => {
    const sequence = ++usageRefreshSequence.current;
    const response = await fetch(`/api/usage/summary?workspaceId=${encodeURIComponent(workspace.id)}`, { cache: "no-store" });
    if (!response.ok) return;
    const body = (await response.json()) as { usage?: UsageSummary };
    if (sequence === usageRefreshSequence.current && body.usage) setLiveCreditUsage(body.usage);
  }, [workspace.id]);
  const visibleEdges = useMemo(() => {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const disconnectableEdges = edges
      .filter((edge) => {
        const target = nodeById.get(edge.target);
        if (target?.data.kind !== "videoMaster") return true;
        const handleClipId = String(edge.targetHandle || "").match(/^master:([^:]+):/)?.[1] || "";
        const clipId = typeof edge.data?.masterClipId === "string" ? edge.data.masterClipId : handleClipId;
        // Video Master only exposes ports for the active scene. Legacy edges
        // without a scene-scoped handle have no valid anchor and must not be
        // rendered into the middle of the node.
        if (!clipId) return false;
        const activeClipId = target.data.videoMasterSelectedClipId || target.data.videoMasterClips?.[0]?.id;
        return clipId === activeClipId;
      })
      .map((edge) => {
        const target = nodeById.get(edge.target);
        const isMasterSceneLink = target?.data.kind === "videoMaster";
        return {
          ...edge,
          type: "disconnectable",
          ...(isMasterSceneLink ? {
            hidden: false,
            animated: true,
            className: [edge.className, "is-master-scene-link"].filter(Boolean).join(" "),
          } : {}),
        };
      });
    if (!selectedId) return disconnectableEdges;

    const selectedPathIds = new Set<string>();
    const visitedNodeIds = new Set<string>();
    const pendingNodeIds = [selectedId];

    // Keep the whole incoming lineage visible, and also highlight the selected
    // node's immediate outputs so the selection reads in both directions.
    disconnectableEdges.forEach((edge) => {
      if (edge.source === selectedId) selectedPathIds.add(edge.id);
    });

    while (pendingNodeIds.length) {
      const targetId = pendingNodeIds.shift()!;
      if (visitedNodeIds.has(targetId)) continue;
      visitedNodeIds.add(targetId);
      disconnectableEdges.forEach((edge) => {
        if (edge.target !== targetId) return;
        selectedPathIds.add(edge.id);
        pendingNodeIds.push(edge.source);
      });
    }

    return disconnectableEdges.map((edge) => selectedPathIds.has(edge.id) ? {
      ...edge,
      className: [edge.className, "is-selected-path"].filter(Boolean).join(" "),
      animated: true,
      zIndex: 8,
    } : edge);
  }, [edges, nodes, selectedId]);
  const tiktokAutomationSources = useMemo<TikTokAutomationSourceOption[]>(
    () => findTikTokSlideshowSources(nodes, edges),
    [nodes, edges],
  );
  const tiktokAutomationModels = useMemo(() => models.filter((model) => model.mediaType === "image" && model.maxReferences >= 1), [models]);
  const selectedAutomationSourceId = tiktokAutomationSources.some((source) => source.id === automationSourceId)
    ? automationSourceId
    : tiktokAutomationSources[0]?.id || "";
  const focusAutomationSource = useCallback((sourceId: string) => {
    const source = tiktokAutomationSources.find((item) => item.id === sourceId);
    if (!source) return;

    const sourceAssetIds = new Set(source.assetIds);
    const focusNodes = nodesRef.current.filter((node) => (
      node.id === sourceId
      || (node.data.kind === "scene" && Boolean(node.data.assetId) && sourceAssetIds.has(String(node.data.assetId)))
    ));
    if (!focusNodes.length) return;

    const request = ++automationCameraRequestRef.current;
    window.requestAnimationFrame(() => {
      if (request !== automationCameraRequestRef.current) return;
      const panelAwareLeftPadding = Math.min(554, Math.max(180, window.innerWidth * 0.42));
      const slideCount = source.assetIds.length;
      const maxZoom = slideCount <= 3 ? 1.04 : slideCount <= 5 ? 0.92 : slideCount <= 8 ? 0.78 : 0.68;
      void fitView({
        nodes: focusNodes,
        padding: { top: "116px", right: "52px", bottom: "48px", left: `${Math.round(panelAwareLeftPadding)}px` },
        minZoom: 0.15,
        maxZoom,
        duration: 760,
        ease: (progress) => 1 - Math.pow(1 - progress, 3),
        interpolate: "smooth",
      });
    });
  }, [fitView, tiktokAutomationSources]);
  const selectedAutomationPersonaId = personas.some((persona) => persona.id === automationPersonaId)
    ? automationPersonaId
    : personas[0]?.id || "";
  const selectedAutomationModelId = tiktokAutomationModels.some((model) => model.id === automationModelId && model.maxReferences >= (automationMode === "identity" ? 2 : 1))
    ? automationModelId
    : tiktokAutomationModels.find((model) => model.id === "nano-banana-2" && model.maxReferences >= (automationMode === "identity" ? 2 : 1))?.id
      || tiktokAutomationModels.find((model) => model.maxReferences >= (automationMode === "identity" ? 2 : 1))?.id || "";
  const selectedAutomationPlanningModelId = tiktokAutomationPlanningModels.some((model) => model.id === automationPlanningModelId)
    ? automationPlanningModelId
    : DEFAULT_ASSISTANT_MODEL_ID;
  const automationEstimatedCredits = useMemo(() => {
    const source = tiktokAutomationSources.find((item) => item.id === selectedAutomationSourceId);
    const persona = personas.find((item) => item.id === selectedAutomationPersonaId);
    const model = tiktokAutomationModels.find((item) => item.id === selectedAutomationModelId);
    if (!source || !model || (automationMode === "identity" && !persona)) return 0;
    const largestIdentityStage = Math.max(
      persona?.assets.filter((asset) => asset.role === "reference").length || 0,
      persona?.assets.filter((asset) => asset.role === "before").length || 0,
      persona?.assets.filter((asset) => asset.role === "after").length || 0,
    );
    const personaReferenceCount = automationMode === "identity" ? Math.min(4, Math.max(0, model.maxReferences - 1), largestIdentityStage) : 0;
    try {
      const generationCredits = source.assetIds.length * generationCreditCost(
        model.id,
        model.defaultResolution || model.resolutions?.[0] || "1K",
        model.defaultDuration || model.durations?.[0] || "5",
        1 + personaReferenceCount,
      );
      return tiktokPlanningReserveCredits(source.assetIds.length, selectedAutomationPlanningModelId) + generationCredits;
    } catch {
      return 0;
    }
  }, [automationMode, personas, selectedAutomationModelId, selectedAutomationPersonaId, selectedAutomationPlanningModelId, selectedAutomationSourceId, tiktokAutomationModels, tiktokAutomationSources]);
  const automationPlanningCredits = automationPlan?.planningCredits
    ?? (tiktokAutomationSources.find((source) => source.id === selectedAutomationSourceId)?.assetIds.length
      ? tiktokPlanningReserveCredits(tiktokAutomationSources.find((source) => source.id === selectedAutomationSourceId)!.assetIds.length, selectedAutomationPlanningModelId)
      : 0);
  const automationGenerationCredits = automationPlan?.generationCredits ?? Math.max(0, automationEstimatedCredits - automationPlanningCredits);
  const automationSourceSlideNodeIds = useMemo(() => {
    const focused = new Set<string>();
    if (!tiktokAutomationOpen || !selectedAutomationSourceId) return focused;
    const selectedSource = tiktokAutomationSources.find((source) => source.id === selectedAutomationSourceId);
    if (!selectedSource) return focused;
    const sourceAssetIds = new Set(selectedSource.assetIds);
    nodes.forEach((node) => {
      if (node.data.kind === "scene" && node.data.assetId && sourceAssetIds.has(String(node.data.assetId))) focused.add(node.id);
    });
    return focused;
  }, [nodes, selectedAutomationSourceId, tiktokAutomationOpen, tiktokAutomationSources]);
  const completedAutomationOutputNodeIds = useMemo(() => new Set(
    automationStatus === "complete"
      ? automationSlideStates.filter((slide) => slide.status === "ready" && slide.nodeId).map((slide) => slide.nodeId!)
      : [],
  ), [automationSlideStates, automationStatus]);
  const automationFocusNodeIds = useMemo(() => {
    const focused = new Set(automationSourceSlideNodeIds);
    if (tiktokAutomationOpen && selectedAutomationSourceId) focused.add(selectedAutomationSourceId);
    completedAutomationOutputNodeIds.forEach((nodeId) => focused.add(nodeId));
    return focused;
  }, [automationSourceSlideNodeIds, completedAutomationOutputNodeIds, selectedAutomationSourceId, tiktokAutomationOpen]);
  const canvasNodes = useMemo(() => nodes.map((node) => {
    const focused = automationFocusNodeIds.has(node.id);
    const className = [node.className, focused ? "is-automation-focus" : "", focused && node.id === selectedAutomationSourceId ? "is-automation-source-focus" : ""].filter(Boolean).join(" ");
    return className === (node.className || "") ? node : { ...node, className };
  }), [automationFocusNodeIds, nodes, selectedAutomationSourceId]);
  const canvasEdges = useMemo(() => visibleEdges.map((edge) => {
    const isSourceSlideEdge = edge.source === selectedAutomationSourceId
      && automationSourceSlideNodeIds.has(edge.target);
    const isCompletedAutomationOutputEdge = automationSourceSlideNodeIds.has(edge.source)
      && completedAutomationOutputNodeIds.has(edge.target)
      && edge.data?.automationKind === "tiktok-slideshow"
      && edge.data.automationSourceNodeId === selectedAutomationSourceId;
    const focused = tiktokAutomationOpen && (isSourceSlideEdge || isCompletedAutomationOutputEdge);
    return focused ? {
      ...edge,
      className: [edge.className, "is-automation-focus-edge"].filter(Boolean).join(" "),
      animated: true,
      zIndex: Math.max(Number(edge.zIndex || 0), 7),
    } : edge;
  }), [automationSourceSlideNodeIds, completedAutomationOutputNodeIds, selectedAutomationSourceId, tiktokAutomationOpen, visibleEdges]);

  const snapshotGraph = useCallback((): GraphSnapshot => structuredClone({ nodes: nodesRef.current, edges: edgesRef.current }), []);
  const refreshHistoryControls = useCallback(() => setHistoryControls({
    canUndo: pastRef.current.length > 0,
    canRedo: futureRef.current.length > 0,
  }), []);
  const pushHistory = useCallback(() => {
    if (restoringHistoryRef.current) return;
    pastRef.current = [...pastRef.current.slice(-59), snapshotGraph()];
    futureRef.current = [];
    refreshHistoryControls();
  }, [refreshHistoryControls, snapshotGraph]);
  const undo = useCallback(() => {
    const previous = pastRef.current.at(-1);
    if (!previous) return;
    futureRef.current = [...futureRef.current.slice(-59), snapshotGraph()];
    pastRef.current = pastRef.current.slice(0, -1);
    restoringHistoryRef.current = true;
    const restored = structuredClone(previous);
    nodesRef.current = restored.nodes;
    edgesRef.current = restored.edges;
    setNodes(restored.nodes);
    setEdges(restored.edges);
    setSelectedId(null);
    setNodeCreator(null);
    setCanvasAddMenuOpen(false);
    queueMicrotask(() => { restoringHistoryRef.current = false; });
    refreshHistoryControls();
  }, [refreshHistoryControls, snapshotGraph]);
  const redo = useCallback(() => {
    const nextSnapshot = futureRef.current.at(-1);
    if (!nextSnapshot) return;
    pastRef.current = [...pastRef.current.slice(-59), snapshotGraph()];
    futureRef.current = futureRef.current.slice(0, -1);
    restoringHistoryRef.current = true;
    const restored = structuredClone(nextSnapshot);
    nodesRef.current = restored.nodes;
    edgesRef.current = restored.edges;
    setNodes(restored.nodes);
    setEdges(restored.edges);
    setSelectedId(null);
    setNodeCreator(null);
    setCanvasAddMenuOpen(false);
    queueMicrotask(() => { restoringHistoryRef.current = false; });
    refreshHistoryControls();
  }, [refreshHistoryControls, snapshotGraph]);

  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);
  useEffect(() => {
    if (!dirtyTrackingReadyRef.current) {
      dirtyTrackingReadyRef.current = true;
      return;
    }
    if (dirtyTrackingProjectRef.current !== project.id) {
      dirtyTrackingProjectRef.current = project.id;
      dirtyProjectIdsRef.current.delete(project.id);
      projectGraphRevisionRef.current[project.id] ||= 0;
      return;
    }
    dirtyProjectIdsRef.current.add(project.id);
    projectGraphRevisionRef.current[project.id] = (projectGraphRevisionRef.current[project.id] || 0) + 1;
  }, [edges, nodes, project.id]);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("project") === project.id && !url.searchParams.has("workspace")) return;
    url.searchParams.set("project", project.id);
    url.searchParams.delete("workspace");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [project.id]);
  useEffect(() => { void refreshUsage(); }, [refreshUsage]);
  useEffect(() => {
    const restoreTasks = (event: Event) => {
      const tasks = ((event as CustomEvent<{ tasks?: BackgroundTaskRecord[] }>).detail?.tasks || [])
        .filter((task) => task.kind === "generation" && task.projectId === project.id);
      const activeIds = tasks
        .filter((task) => task.status === "queued" || task.status === "running")
        .map((task) => task.nodeId);
      const nextActiveIds = Array.from(new Set(activeIds));
      setBackgroundGenerationNodeIds((current) => current.length === nextActiveIds.length && current.every((id) => nextActiveIds.includes(id)) ? current : nextActiveIds);

      const latestByNode = new Map<string, BackgroundTaskRecord>();
      const completedOutputsByNode = new Map<string, NonNullable<FrameNode["data"]["generatedOutputs"]>>();
      for (const task of tasks) {
        const prior = latestByNode.get(task.nodeId);
        if (!prior || Date.parse(task.createdAt) > Date.parse(prior.createdAt)) latestByNode.set(task.nodeId, task);
        if (task.status === "completed" && task.outputUrl) {
          const output = {
            url: task.outputUrl,
            assetId: task.assetId || undefined,
            mediaType: task.mediaType || "image" as const,
            modelId: task.modelId,
          };
          completedOutputsByNode.set(task.nodeId, [...(completedOutputsByNode.get(task.nodeId) || []), output]);
        }
      }
      let terminalChanged = false;
      setNodes((current) => {
        let changed = false;
        const next = current.map((node) => {
          const task = latestByNode.get(node.id);
          if (!task) return node;
          const taskSignature = `${task.status}:${task.updatedAt}:${task.assetId || task.outputUrl || ""}`;
          if ((task.status === "completed" || task.status === "failed") && restoredTaskStateRef.current[task.id] === taskSignature) return node;
          if (task.status === "queued" || task.status === "running") {
            const status = task.status === "queued" ? "queued" as const : "working" as const;
            const queueReason = task.status === "queued" ? "provider" as const : undefined;
            if (node.data.status === status && node.data.queueReason === queueReason) return node;
            changed = true;
            return { ...node, data: { ...node.data, status, queueReason, generationError: undefined } };
          }
          restoredTaskStateRef.current[task.id] = taskSignature;
          const savedGeneratedAt = Date.parse(String(node.data.generatedAt || ""));
          const taskGeneratedAt = Date.parse(task.updatedAt);
          if (task.status === "completed" && Number.isFinite(savedGeneratedAt) && Number.isFinite(taskGeneratedAt) && savedGeneratedAt >= taskGeneratedAt) {
            return node;
          }
          terminalChanged = true;
          changed = true;
          if (task.status === "failed") {
            return { ...node, data: { ...node.data, status: "failed" as const, queueReason: undefined, generationError: task.error || "Generation failed" } };
          }
          if (!task.outputUrl) return node;
          const output = {
            url: task.outputUrl,
            assetId: task.assetId || undefined,
            mediaType: task.mediaType || "image" as const,
            modelId: task.modelId,
          };
          const previousOutput = task.operation === "edit" && node.data.outputUrl
            ? [{ url: node.data.outputUrl, assetId: node.data.assetId, mediaType: node.data.mediaType || "image" as const, modelId: node.data.modelId }]
            : [];
          const recoveredOutputs = completedOutputsByNode.get(node.id) || [];
          const outputHistory = [...(node.data.generatedOutputs || []), ...previousOutput, ...recoveredOutputs, output]
            .filter((item, index, items) => items.findIndex((candidate) => candidate.url === item.url) === index)
            .slice(-20);
          return {
            ...node,
            data: {
              ...node.data,
              ...(task.operation === "edit" ? { subtitle: "Image edited in place" } : {}),
              outputUrl: output.url,
              assetId: output.assetId,
              mediaType: output.mediaType,
              modelId: output.modelId,
              generatedAt: task.updatedAt,
              generatedOutputs: outputHistory,
              activeGeneratedOutputIndex: outputHistory.length - 1,
              status: "ready" as const,
              queueReason: undefined,
              generationError: undefined,
            },
          };
        });
        if (changed) nodesRef.current = next;
        return changed ? next : current;
      });
      if (terminalChanged) void refreshUsage();
    };
    window.addEventListener("scenelith:tasks-updated", restoreTasks);
    return () => window.removeEventListener("scenelith:tasks-updated", restoreTasks);
  }, [project.id, refreshUsage]);
  useEffect(() => {
    const handleHistoryShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", handleHistoryShortcut);
    return () => window.removeEventListener("keydown", handleHistoryShortcut);
  }, [redo, undo]);
  useEffect(() => {
    const handleNodeClipboardShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.repeat) return;
      const key = event.key.toLowerCase();

      if (key === "c") {
        const selectedNodeIds = nodesRef.current.filter((node) => node.selected).map((node) => node.id);
        if (!selectedNodeIds.length && selectedId) selectedNodeIds.push(selectedId);
        if (!selectedNodeIds.length) return;
        event.preventDefault();
        canvasClipboardRef.current = {
          graph: structuredClone({ nodes: nodesRef.current, edges: edgesRef.current }),
          nodeIds: selectedNodeIds,
          pasteCount: 0,
        };
        setNotice(selectedNodeIds.length === 1 ? "Node copied" : `${selectedNodeIds.length} nodes copied`);
        return;
      }

      if (key !== "v" || !canvasClipboardRef.current) return;
      const clipboard = canvasClipboardRef.current;
      event.preventDefault();
      pushHistory();
      const pasteCount = clipboard.pasteCount + 1;
      const duplicated = duplicateGraphSelection(
        clipboard.graph.nodes,
        clipboard.graph.edges,
        clipboard.nodeIds,
        uid,
        { x: 48 * pasteCount, y: 48 * pasteCount },
      );
      const nextNodes = [
        ...nodesRef.current.map((node) => node.selected ? { ...node, selected: false } : node),
        ...duplicated.nodes,
      ];
      const nextEdges = [...edgesRef.current, ...duplicated.edges];
      nodesRef.current = nextNodes;
      edgesRef.current = nextEdges;
      setNodes(nextNodes);
      setEdges(nextEdges);
      setSelectedId(duplicated.firstNodeId);
      setSidebarOpen(false);
      canvasClipboardRef.current = { ...clipboard, pasteCount };
      setNotice(duplicated.nodes.length === 1 ? "Node pasted" : `${duplicated.nodes.length} nodes pasted`);
    };
    window.addEventListener("keydown", handleNodeClipboardShortcut);
    return () => window.removeEventListener("keydown", handleNodeClipboardShortcut);
  }, [pushHistory, selectedId]);
  useEffect(() => {
    let ignore = false;
    fetch(`/api/personas?workspaceId=${workspace.id}`).then(async (response) => {
      if (!response.ok || ignore) return;
      const body = (await response.json()) as { personas?: unknown };
      if (!ignore) setPersonas(Array.isArray(body.personas) ? body.personas as PersonaRecord[] : []);
    });
    return () => { ignore = true; };
  }, [workspace.id]);

  useEffect(() => {
    if (!identityLibraryOpen || librarySection !== "media") return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLibraryLoading(true);
      setLibraryError("");
      const params = new URLSearchParams({ workspaceId: workspace.id, mediaType: libraryMediaFilter });
      if (libraryProjectFilter !== "all") params.set("projectId", libraryProjectFilter);
      if (librarySearch.trim()) params.set("search", librarySearch.trim());
      try {
        const response = await fetch(`/api/assets?${params}`, { cache: "no-store", signal: controller.signal });
        const body = (await response.json().catch(() => ({}))) as { assets?: LibraryMediaAsset[]; counts?: { all: number; image: number; video: number }; nextCursor?: string | null; error?: string };
        if (!response.ok || !body.assets || !body.counts) throw new Error(body.error || "Could not load generated media");
        setLibraryAssets(body.assets);
        setLibraryCounts(body.counts);
        setLibraryCursor(body.nextCursor || null);
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          setLibraryAssets([]);
          setLibraryCounts({ all: 0, image: 0, video: 0 });
          setLibraryCursor(null);
          setLibraryError(error instanceof Error ? error.message : "Could not load generated media");
        }
      } finally {
        if (!controller.signal.aborted) setLibraryLoading(false);
      }
    }, librarySearch.trim() ? 240 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [identityLibraryOpen, libraryMediaFilter, libraryProjectFilter, libraryRefreshToken, librarySearch, librarySection, workspace.id]);

  useEffect(() => {
    if (!libraryCanvasMenuOpen) return;
    const closeCanvasMenu = (event: PointerEvent) => {
      if (!(event.target as HTMLElement | null)?.closest(".asset-library-canvas-picker")) setLibraryCanvasMenuOpen(false);
    };
    const closeCanvasMenuOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLibraryCanvasMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeCanvasMenu);
    document.addEventListener("keydown", closeCanvasMenuOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeCanvasMenu);
      document.removeEventListener("keydown", closeCanvasMenuOnEscape);
    };
  }, [libraryCanvasMenuOpen]);

  useEffect(() => {
    if (!libraryUploadOpen || libraryUploadBusy) return;
    const closeUploadOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setLibraryUploadOpen(false);
        setLibraryUploadDragActive(false);
      }
    };
    document.addEventListener("keydown", closeUploadOnEscape);
    return () => document.removeEventListener("keydown", closeUploadOnEscape);
  }, [libraryUploadBusy, libraryUploadOpen]);

  useEffect(() => {
    if (workspace.rolePrompt === lastSavedRole.current) return;
    const controller = new AbortController();
    const workspaceId = workspace.id;
    const rolePrompt = workspace.rolePrompt;
    setRoleSaveState("saving");
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/workspaces/${workspaceId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rolePrompt }),
          signal: controller.signal,
        });
        const body = (await response.json().catch(() => ({}))) as { workspace?: WorkspaceRecord };
        if (!response.ok || !body.workspace) throw new Error("Role save failed");
        lastSavedRole.current = rolePrompt;
        setWorkspaces((current) => current.map((item) => item.id === workspaceId ? { ...body.workspace!, rolePrompt } : item));
        setRoleSaveState("saved");
      } catch (error) {
        if ((error as Error).name !== "AbortError") setRoleSaveState("error");
      }
    }, 650);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [workspace.id, workspace.rolePrompt]);

  useEffect(() => {
    let ignore = false;
    fetch(`/api/hooks?workspaceId=${workspace.id}`).then(async (response) => {
      if (!response.ok || ignore) return;
      const body = (await response.json()) as { hooks?: unknown };
      if (!ignore) setHooks(Array.isArray(body.hooks) ? body.hooks as HookRecord[] : []);
    });
    return () => { ignore = true; };
  }, [workspace.id]);

  useEffect(() => {
    const openCreator = (event: Event) => {
      const detail = (event as CustomEvent<{ nodeId: string; clientX: number; clientY: number; segment?: VideoSceneSegment; intent?: "video-master" | "video-master-replace" }>).detail;
      if (!detail?.nodeId) return;
      if (detail.intent === "video-master" || detail.intent === "video-master-replace") {
        createVideoMaster(detail.nodeId, detail.segment);
        return;
      }
      setNodeCreator({
        nodeId: detail.nodeId,
        clientX: Math.min(detail.clientX + 18, window.innerWidth - 292),
        clientY: Math.min(detail.clientY - 24, window.innerHeight - 244),
        segment: detail.segment,
        intent: detail.intent,
      });
    };
    window.addEventListener(OPEN_NODE_CREATOR_EVENT, openCreator);
    return () => window.removeEventListener(OPEN_NODE_CREATOR_EVENT, openCreator);
  }, []);

  useEffect(() => {
    const openVideoEditor = (event: Event) => {
      const nodeId = (event as CustomEvent<{ nodeId?: string }>).detail?.nodeId;
      const node = nodesRef.current.find((item) => item.id === nodeId);
      if (!node || node.data.mediaType !== "video") return;
      setPreviewMode("view");
      setPreviewMedia(null);
      setPreviewNode(node);
    };
    window.addEventListener(OPEN_VIDEO_EDITOR_EVENT, openVideoEditor);
    return () => window.removeEventListener(OPEN_VIDEO_EDITOR_EVENT, openVideoEditor);
  }, []);

  const save = useCallback(async (quiet = false, force = false) => {
    if (projectHydratingIdRef.current === project.id) return false;
    if (!force && !dirtyProjectIdsRef.current.has(project.id)) return true;
    const graphRevision = projectGraphRevisionRef.current[project.id] || 0;
    const persistedNodes = stableGraphNodes(nodesRef.current);
    const persistedEdges = stableGraphEdges(normalizeEdgePorts(edgesRef.current, persistedNodes));
    const signature = projectSaveSignature(project, persistedNodes, persistedEdges, viewportRef.current);
    if (!force && savedProjectSignatures.current[project.id] === signature) return true;
    savedProjectSignatures.current[project.id] = signature;
    setSaving("saving");
    try {
      if (!collaborationReady) return false;
      const committed = await flushCollaborativeGraph(force);
      if (!committed) throw new Error("Canvas collaboration sync failed");
      if ((projectGraphRevisionRef.current[project.id] || 0) === graphRevision) dirtyProjectIdsRef.current.delete(project.id);
      setSaving(collaborationStatus === "synced" ? "saved" : "idle");
      if (!quiet) setNotice(collaborationStatus === "synced" ? "Canvas saved" : "Change queued — reconnecting");
      if (collaborationStatus === "synced") window.setTimeout(() => setSaving("idle"), 1200);
      return true;
    } catch {
      if (savedProjectSignatures.current[project.id] === signature) delete savedProjectSignatures.current[project.id];
      setSaving("idle");
      if (!quiet) setNotice("Could not save canvas");
      return false;
    }
  }, [collaborationReady, collaborationStatus, flushCollaborativeGraph, project]);

  useEffect(() => {
    if (initialHydration.current) {
      initialHydration.current = false;
      return;
    }
    const timer = window.setTimeout(() => void save(true), 180);
    return () => window.clearTimeout(timer);
  }, [nodes, edges, save]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const onNodesChange = useCallback((changes: NodeChange<FrameNode>[]) => {
    if (changes.some((change) => change.type === "remove")) {
      pushHistory();
      skipEdgeHistoryUntilRef.current = Date.now() + 180;
    }
    setNodes((current) => {
      const next = applyNodeChanges(changes, current);
      nodesRef.current = next;
      return next;
    });
  }, [pushHistory]);
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    if (changes.some((change) => change.type === "remove") && Date.now() > skipEdgeHistoryUntilRef.current) pushHistory();
    setEdges((current) => {
      const next = applyEdgeChanges(changes, current);
      edgesRef.current = next;
      return next;
    });
  }, [pushHistory]);
  const onConnect = useCallback((connection: Connection) => {
    const sourceNode = nodesRef.current.find((node) => node.id === connection.source);
    const segmentId = connection.sourceHandle?.startsWith("segment-output:") ? connection.sourceHandle.slice("segment-output:".length) : undefined;
    const sourceSegment = segmentId ? sourceNode?.data.videoSegments?.find((segment) => segment.id === segmentId) : undefined;
    const portType = connection.sourceHandle === "text-output"
      ? "text"
      : sourceSegment || connection.sourceHandle === "video-output" || sourceNode?.data.mediaType === "video"
        ? "video"
        : connection.sourceHandle === "audio-output"
          ? "audio"
          : "image";
    const masterPortMatch = connection.targetHandle?.match(/^master:([^:]+):([^:]+)-input$/);
    const masterClipId = masterPortMatch?.[1];
    const targetRole = (masterPortMatch?.[2] || connection.targetHandle?.replace(/-input$/, "")) as GeneratorInputRole | undefined;
    const expectedType = targetRole === "motion-video" || targetRole === "reference-video" ? "video" : targetRole === "reference-audio" ? "audio" : targetRole ? "image" : null;
    const valid = connection.targetHandle === "input"
      || (portType === "text" && connection.targetHandle === "text-input")
      || (expectedType !== null && expectedType === portType);
    if (!valid) {
      setNotice(`${portType[0].toUpperCase()}${portType.slice(1)} can only connect to a matching input`);
      return;
    }
    if (!connection.source || !connection.target) return;
    const targetNode = nodesRef.current.find((node) => node.id === connection.target);
    const targetClip = masterClipId ? targetNode?.data.videoMasterClips?.find((clip) => clip.id === masterClipId) : undefined;
    const targetModel = models.find((model) => model.id === (targetClip?.modelId || targetNode?.data.modelId));
    const targetCapacity = generatorInputCapacity(targetModel, targetRole);
    const existingInputEdges = edgesRef.current.filter((edge) => edge.target === connection.target && edge.targetHandle === connection.targetHandle);
    const alreadyConnected = existingInputEdges.some((edge) => edge.source === connection.source && edge.sourceHandle === connection.sourceHandle);
    if (targetRole && targetCapacity <= 0) {
      setNotice(`${targetModel?.label || "This model"} does not accept this reference input`);
      return;
    }
    if (!alreadyConnected && targetCapacity > 1 && existingInputEdges.length >= targetCapacity) {
      setNotice(`This input supports up to ${targetCapacity} reference${targetCapacity === 1 ? "" : "s"}`);
      return;
    }
    pushHistory();
    setEdges((current) => {
      const next = upsertGraphEdge(current, nodesRef.current, {
        id: uid("edge"),
        source: connection.source,
        sourceHandle: connection.sourceHandle,
        target: connection.target,
        targetHandle: connection.targetHandle,
        animated: true,
        data: {
          portType,
          ...(targetRole ? { inputRole: targetRole } : {}),
          ...(masterClipId ? { masterClipId } : {}),
          ...(sourceSegment ? {
            sourceSegmentId: sourceSegment.id,
            sourceSegmentStart: sourceSegment.start,
            sourceSegmentEnd: sourceSegment.end,
            sourceSegmentLabel: sourceSegment.label,
            sourceSegmentThumbnailUrl: sourceSegment.thumbnailUrl,
            clipAssetId: sourceSegment.clipAssetId,
            clipUrl: sourceSegment.clipUrl,
          } : {}),
        },
      }, { replaceTargetInput: targetCapacity <= 1 });
      edgesRef.current = next;
      return next;
    });
    if (sourceSegment && connection.source) void materializeVideoSegment(connection.source, sourceSegment.id).catch(() => undefined);
  }, [materializeVideoSegment, models, pushHistory]);

  const importCanvasMedia = useCallback(async (files: File[], screenPosition?: { x: number; y: number }, source: "clipboard" | "drop" = "drop") => {
    const mediaFiles = files.filter(isAcceptedCanvasMedia).slice(0, 12);
    if (!mediaFiles.length) {
      setNotice("Drop JPG, PNG, MP4, MOV or WebM files");
      return;
    }
    const videoCount = mediaFiles.filter((file) => file.type.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/i.test(file.name)).length;
    const imageCount = mediaFiles.length - videoCount;
    setNotice(mediaFiles.length === 1
      ? `Adding ${videoCount ? "video" : "image"}…`
      : `Adding ${imageCount ? `${imageCount} image${imageCount === 1 ? "" : "s"}` : ""}${imageCount && videoCount ? " and " : ""}${videoCount ? `${videoCount} video${videoCount === 1 ? "" : "s"}` : ""}…`);
    const body = await uploadMediaFiles(project.id, "canvas", mediaFiles).catch((error) => ({ assets: undefined, error: error instanceof Error ? error.message : "Could not add media" }));
    if (!body.assets?.length) {
      setNotice(body.error || "Could not add media");
      return;
    }

    const stage = document.querySelector<HTMLElement>(".canvas-stage");
    const bounds = stage?.getBoundingClientRect();
    const pointer = lastCanvasPointerRef.current;
    const base = screenToFlowPosition({
      x: screenPosition?.x ?? pointer?.x ?? (bounds ? bounds.left + bounds.width / 2 : window.innerWidth / 2),
      y: screenPosition?.y ?? pointer?.y ?? (bounds ? bounds.top + bounds.height / 2 : window.innerHeight / 2),
    });
    const existingSceneNumbers = nodesRef.current.flatMap((node) => {
      const match = node.data.kind === "scene" ? /^Scene\s+(\d+)$/i.exec(node.data.title) : null;
      return match ? [Number(match[1])] : [];
    });
    const firstSceneNumber = Math.max(0, ...existingSceneNumbers) + 1;
    const importedNodes: FrameNode[] = body.assets.map((asset, index) => ({
      id: uid("scene"),
      type: "frameNode",
      position: {
        x: base.x + (index % 4) * 320,
        y: base.y + Math.floor(index / 4) * 500,
      },
      data: {
        kind: "scene",
        title: source === "clipboard"
          ? `Scene ${String(firstSceneNumber + index).padStart(2, "0")}`
          : mediaTitle(asset.originalName || asset.filename, asset.mediaType === "video" ? "Video" : `Scene ${String(firstSceneNumber + index).padStart(2, "0")}`),
        subtitle: source === "clipboard" ? "Pasted from clipboard" : "Dropped on canvas",
        role: asset.mediaType === "video" ? "video" : "scene",
        assetId: asset.id,
        imageUrl: asset.url,
        mediaType: asset.mediaType,
        canvasMediaOrigin: source,
        nodeWidth: asset.mediaType === "video" ? 300 : 260,
        createdAt: new Date().toISOString(),
        status: "ready",
      },
    }));

    pushHistory();
    setNodes((current) => {
      const updated = [...current, ...importedNodes];
      nodesRef.current = updated;
      return updated;
    });
    setSelectedId(importedNodes[0].id);
    setSidebarOpen(false);
    setNotice(importedNodes.length === 1 ? `${importedNodes[0].data.title} added` : `${importedNodes.length} media nodes added`);
  }, [project.id, pushHistory, screenToFlowPosition]);

  const pasteClipboardImages = useCallback(async (images: File[]) => {
    await importCanvasMedia(images, undefined, "clipboard");
  }, [importCanvasMedia]);

  useEffect(() => {
    const handleClipboardPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      const stage = document.querySelector<HTMLElement>(".canvas-stage");
      if (!stage) return;
      const pointer = lastCanvasPointerRef.current;
      if (!pointer) return;
      const bounds = stage.getBoundingClientRect();
      if (pointer.x < bounds.left || pointer.x > bounds.right || pointer.y < bounds.top || pointer.y > bounds.bottom) return;
      const images = Array.from(event.clipboardData?.items || [])
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file));
      if (!images.length) return;
      event.preventDefault();
      void pasteClipboardImages(images);
    };
    window.addEventListener("paste", handleClipboardPaste);
    return () => window.removeEventListener("paste", handleClipboardPaste);
  }, [pasteClipboardImages]);

  function addNode(kind: FrameNode["data"]["kind"], data?: Partial<FrameNode["data"]>, position?: { x: number; y: number }) {
    pushHistory();
    const id = uid(kind);
    const next: FrameNode = {
      id,
      type: "frameNode",
      position: position || { x: 380 + (nodes.length % 3) * 72, y: 180 + (nodes.length % 5) * 58 },
      data: {
        kind,
        createdAt: new Date().toISOString(),
        title: kind === "assistant" ? "Assistant" : kind === "prompt" ? "New generation prompt" : kind === "note" ? "New note" : `New ${kind}`,
        subtitle: kind === "assistant" ? "AI Assistant" : kind === "prompt" ? "Connect a scene and identity" : "Double-click to inspect",
        status: "idle",
        ...data,
      },
    };
    setNodes((current) => {
      const updated = [...current, next];
      nodesRef.current = updated;
      return updated;
    });
    setSelectedId(id);
  }

  function canvasCenterPosition() {
    const stage = document.querySelector<HTMLElement>(".canvas-stage");
    const bounds = stage?.getBoundingClientRect();
    return screenToFlowPosition({
      x: bounds ? bounds.left + bounds.width / 2 : window.innerWidth / 2,
      y: bounds ? bounds.top + bounds.height / 2 : window.innerHeight / 2,
    });
  }

  function addCanvasGenerator(mediaType: "image" | "video") {
    const defaultModel = mediaType === "video"
      ? models.find((item) => item.id === "seedance-2-fast") || models.find((item) => item.mediaType === "video")
      : models.find((item) => item.id === "nano-banana-2") || models.find((item) => item.mediaType === "image");
    addNode("prompt", {
      title: mediaType === "video" ? "Video Generator" : "Image Generator",
      subtitle: "Standalone generator",
      prompt: "",
      mediaType,
      modelId: defaultModel?.id,
      aspectRatio: (mediaType === "image" && defaultModel?.ratios?.includes("1:1") ? "1:1" : defaultModel?.defaultRatio || (mediaType === "video" ? "16:9" : "1:1")) as FrameNode["data"]["aspectRatio"],
      ratioMode: "custom",
      resolution: (defaultModel?.defaultResolution || defaultModel?.resolutions?.[0] || (mediaType === "video" ? "720P" : "1K")) as FrameNode["data"]["resolution"],
      duration: (defaultModel?.defaultDuration || defaultModel?.durations?.[0] || "5") as FrameNode["data"]["duration"],
      generateAudio: defaultModel?.defaultGenerateAudio ?? false,
      generationCount: 1,
    }, canvasCenterPosition());
    setCanvasAddMenuOpen(false);
  }

  function addCanvasAssistant() {
    addNode("assistant", {
      title: "Assistant",
      subtitle: "AI Assistant",
      assistantInput: "",
      assistantOutput: "",
      systemPrompt: "",
      textModelId: DEFAULT_ASSISTANT_MODEL_ID,
      nodeWidth: 430,
    }, canvasCenterPosition());
    setCanvasAddMenuOpen(false);
  }

  function addCanvasNote() {
    addNode("note", {
      title: "Canvas note",
      subtitle: "",
      noteText: "Write a note…",
      noteColor: "yellow",
      nodeWidth: 330,
      nodeHeight: 410,
    }, canvasCenterPosition());
    setCanvasAddMenuOpen(false);
  }

  function createVideoMaster(sourceNodeId: string, requestedSegment?: VideoSceneSegment) {
    const source = nodesRef.current.find((node) => node.id === sourceNodeId);
    const sourceUrl = String(source?.data.outputUrl || source?.data.imageUrl || "");
    const sourceSegments = [...(source?.data.videoSegments || [])].sort((left, right) =>
      Number(left.sequenceIndex ?? left.index) - Number(right.sequenceIndex ?? right.index) || left.start - right.start);
    if (!source || source.data.mediaType !== "video" || !sourceUrl || !sourceSegments.length) {
      setNotice("This video does not have an editable scene map yet");
      return;
    }
    const defaultModel = models.find((item) => item.id === "seedance-2-fast") || models.find((item) => item.mediaType === "video");
    const sourceRatio = Math.max(0.2, Number(source.data.videoAspectRatio || 9 / 16));
    const ratios = generatorRatiosFor(defaultModel, defaultModel?.defaultResolution, true).filter((ratio) => /^\d+:\d+$/.test(ratio));
    const aspectRatio = nearestVideoMasterRatio(sourceRatio, ratios);
    // The clicked output chooses which scene opens first; it must not collapse
    // the editable source sequence to a single clip. Video Master is the
    // sequence editor, so every detected scene remains present and connected.
    const clips: VideoMasterClip[] = sourceSegments.map((segment, sequenceIndex) => {
      return {
        id: uid("master-clip"),
        sequenceIndex,
        title: segment.label,
        role: segment.role,
        origin: segment.replacementUrl ? "generated" : "source",
        duration: Math.max(0.1, segment.end - segment.start),
        generationDuration: videoMasterGenerationDuration(defaultModel, { duration: Math.max(0.1, segment.end - segment.start) } as VideoMasterClip),
        prompt: "",
        modelId: defaultModel?.id,
        aspectRatio,
        aspectRatioMode: "original",
        sourceAspectRatio: sourceRatio,
        resolution: defaultModel?.defaultResolution || defaultModel?.resolutions?.[0] || "720P",
        generateAudio: defaultModel?.defaultGenerateAudio ?? false,
        sourceNodeId: source.id,
        sourceSegmentId: segment.id,
        sourceStart: segment.start,
        sourceEnd: segment.end,
        sourceUrl,
        sourceAssetId: source.data.assetId,
        sourceClipUrl: segment.clipUrl,
        sourceClipAssetId: segment.clipAssetId,
        thumbnailUrl: segment.thumbnailUrl,
        outputUrl: segment.replacementUrl,
        outputAssetId: segment.replacementAssetId,
      };
    });
    const focusedSegmentId = requestedSegment?.id || (source.data.videoOutputSelection !== "full" ? String(source.data.videoOutputSelection || "") : "");
    const focusedClip = clips.find((clip) => clip.sourceSegmentId === focusedSegmentId) || clips[0];
    const id = uid("video-master");
    const sourceWidth = Number(source.measured?.width || source.width || source.data.nodeWidth || 580);
    const next: FrameNode = {
      id,
      type: "frameNode",
      position: { x: source.position.x + sourceWidth + 150, y: source.position.y },
      selected: true,
      data: {
        kind: "videoMaster",
        title: "Video Master",
        subtitle: `Sequence · ${source.data.title}`,
        status: "idle",
        mediaType: "video",
        modelId: focusedClip?.modelId || defaultModel?.id,
        duration: String(focusedClip?.generationDuration || Math.max(1, Math.round(focusedClip?.duration || 5))),
        resolution: (defaultModel?.defaultResolution || defaultModel?.resolutions?.[0] || "720P") as FrameNode["data"]["resolution"],
        aspectRatio: aspectRatio as FrameNode["data"]["aspectRatio"],
        ratioMode: "original",
        generateAudio: defaultModel?.defaultGenerateAudio ?? false,
        generationCount: 1,
        prompt: "",
        nodeWidth: 720,
        videoAspectRatio: sourceRatio,
        videoMasterSourceNodeId: source.id,
        videoMasterClips: clips,
        videoMasterSelectedClipId: focusedClip?.id,
      },
    };
    const nextNodes = [...nodesRef.current.map((node) => ({
      ...node,
      ...(node.selected ? { selected: false } : {}),
      ...(node.id === source.id && focusedClip?.sourceSegmentId
        ? { data: { ...node.data, videoOutputSelection: focusedClip.sourceSegmentId } }
        : {}),
    })), next];
    let nextEdges = edgesRef.current;
    if (defaultModel?.inputPorts?.some((port) => port.id === "reference-video")) {
      for (const clip of clips) {
        const segment = sourceSegments.find((item) => item.id === clip.sourceSegmentId);
        if (!segment) continue;
        nextEdges = upsertGraphEdge(nextEdges, nextNodes, {
          id: uid("edge"),
          source: source.id,
          sourceHandle: `segment-output:${segment.id}`,
          target: id,
          targetHandle: `master:${clip.id}:reference-video-input`,
          animated: true,
          hidden: true,
          data: {
            portType: "video",
            inputRole: "reference-video",
            masterClipId: clip.id,
            sourceSegmentId: segment.id,
            sourceSegmentStart: segment.start,
            sourceSegmentEnd: segment.end,
            sourceSegmentLabel: segment.label,
            sourceSegmentThumbnailUrl: segment.thumbnailUrl,
            clipAssetId: segment.clipAssetId,
            clipUrl: segment.clipUrl,
          },
        }, { replaceTargetInput: false });
      }
    }
    pushHistory();
    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
    setNodes(nextNodes);
    setEdges(nextEdges);
    setSelectedId(id);
    setSidebarOpen(false);
    setNodeCreator(null);
    setNotice(requestedSegment ? `${requestedSegment.label} focused in Video Master` : "Sequence opened in Video Master");
  }

  function createConnectedNode(mode: "image" | "video" | "assistant") {
    if (!nodeCreator) return;
    const source = nodesRef.current.find((node) => node.id === nodeCreator.nodeId);
    if (!source) return;
    const siblings = edgesRef.current.filter((edge) => edge.source === source.id).length;
    const id = uid(mode === "assistant" ? "assistant" : "prompt");
    const isVideo = mode === "video";
    const replacementSegment = nodeCreator.segment;
    const defaultModel = isVideo
      ? models.find((item) => item.id === "seedance-2-fast") || models.find((item) => item.mediaType === "video")
      : models.find((item) => item.id === "nano-banana-2") || models.find((item) => item.mediaType === "image");
    const replacementSeconds = replacementSegment ? Math.max(0.1, replacementSegment.end - replacementSegment.start) : 0;
    const replacementDuration = replacementSegment && defaultModel?.durations?.length
      ? defaultModel.durations.reduce((best, value) => Math.abs(Number(value) - replacementSeconds) < Math.abs(Number(best) - replacementSeconds) ? value : best, defaultModel.durations[0])
      : defaultModel?.defaultDuration || defaultModel?.durations?.[0] || "5";
    const defaultResolution = defaultModel?.defaultResolution || defaultModel?.resolutions?.[0] || "1K";
    const sourceRatio = Math.max(0.2, Number(source.data.videoAspectRatio || 9 / 16));
    const replacementRatios = generatorRatiosFor(defaultModel, defaultResolution, true).filter((ratio) => ratio !== "source");
    const ratioValue = (ratio: string) => {
      const [width, height] = ratio.split(":").map(Number);
      return Number.isFinite(width / height) ? width / height : 16 / 9;
    };
    const replacementAspectRatio = replacementSegment && replacementRatios.length
      ? replacementRatios.reduce((best, ratio) => Math.abs(ratioValue(ratio) - sourceRatio) < Math.abs(ratioValue(best) - sourceRatio) ? ratio : best, replacementRatios[0])
      : undefined;
    const replacementReference = replacementSegment?.thumbnailAssetId && replacementSegment.thumbnailUrl
      ? [{
        assetId: replacementSegment.thumbnailAssetId,
        url: replacementSegment.thumbnailUrl,
        title: `${replacementSegment.label} start frame`,
        role: "start-frame" as GeneratorInputRole,
      }]
      : undefined;
    const next: FrameNode = {
      id,
      type: "frameNode",
      position: { x: source.position.x + (replacementSegment ? 680 : 360), y: source.position.y + siblings * 150 },
      data: {
        kind: mode === "assistant" ? "assistant" : "prompt",
        title: replacementSegment && mode === "video" ? `${replacementSegment.label} replacement` : mode === "video" ? "Video generator" : mode === "image" ? "Image generator" : "Assistant",
        subtitle: replacementSegment ? `${replacementSegment.start.toFixed(3)}s — ${replacementSegment.end.toFixed(3)}s` : `Reference · ${source.data.title}`,
        prompt: mode === "assistant" ? undefined : replacementSegment
          ? `Create a seamless replacement for ${replacementSegment.label} of the source TikTok video. Match the source sequence context and exact ${replacementSeconds.toFixed(3)} second beat. Begin from the attached frame, preserve the intended subject and composition, and create one continuous shot without adding transitions, captions or UI.`
          : "",
        assistantInput: mode === "assistant" ? "" : undefined,
        assistantOutput: mode === "assistant" ? "" : undefined,
        systemPrompt: mode === "assistant" ? "" : undefined,
        textModelId: mode === "assistant" ? DEFAULT_ASSISTANT_MODEL_ID : undefined,
        status: "idle",
        mediaType: isVideo ? "video" : "image",
        modelId: defaultModel?.id || (isVideo ? "seedance-2-fast" : "nano-banana-2"),
        aspectRatio: (replacementAspectRatio || (!isVideo && defaultModel?.ratios?.includes("1:1") ? "1:1" : defaultModel?.defaultRatio || defaultModel?.ratios?.[0] || (isVideo ? "16:9" : "1:1"))) as FrameNode["data"]["aspectRatio"],
        ratioMode: "custom",
        resolution: defaultResolution as FrameNode["data"]["resolution"],
        generationCount: 1,
        duration: replacementDuration as FrameNode["data"]["duration"],
        generateAudio: defaultModel?.defaultGenerateAudio ?? false,
        attachedReferences: mode === "video" ? replacementReference : undefined,
        replacementFor: replacementSegment ? { sourceNodeId: source.id, segmentId: replacementSegment.id, start: replacementSegment.start, end: replacementSegment.end } : undefined,
      },
    };
    pushHistory();
    const updatedNodes = [...nodesRef.current, next];
    const sourceIsText = source.data.kind === "assistant";
    const sourceIsVideo = source.data.mediaType === "video";
    const portType = sourceIsText ? "text" as const : sourceIsVideo ? "video" as const : "image" as const;
    const updatedEdges = replacementSegment ? upsertGraphEdge(edgesRef.current, updatedNodes, {
      id: uid("edge"),
      source: source.id,
      sourceHandle: `segment-output:${replacementSegment.id}`,
      target: id,
      targetHandle: "reference-video-input",
      animated: true,
      data: {
        portType: "video",
        inputRole: "reference-video",
        sourceSegmentId: replacementSegment.id,
        sourceSegmentStart: replacementSegment.start,
        sourceSegmentEnd: replacementSegment.end,
        sourceSegmentLabel: replacementSegment.label,
        sourceSegmentThumbnailUrl: replacementSegment.thumbnailUrl,
        clipAssetId: replacementSegment.clipAssetId,
        clipUrl: replacementSegment.clipUrl,
      },
    }, { replaceTargetInput: false }) : upsertGraphEdge(edgesRef.current, updatedNodes, {
      id: uid("edge"),
      source: source.id,
      sourceHandle: sourceIsText ? "text-output" : sourceIsVideo ? "video-output" : "output",
      target: id,
      targetHandle: sourceIsText ? "text-input" : sourceIsVideo ? "reference-video-input" : "reference-image-input",
      animated: true,
      data: { portType, ...(!sourceIsText ? { inputRole: sourceIsVideo ? "reference-video" as const : "reference-image" as const } : {}) },
    });
    nodesRef.current = updatedNodes;
    edgesRef.current = updatedEdges;
    setNodes(updatedNodes);
    setEdges(updatedEdges);
    setSelectedId(id);
    setSidebarOpen(false);
    setNodeCreator(null);
    if (replacementSegment) void materializeVideoSegment(source.id, replacementSegment.id).catch(() => undefined);
    setNotice(replacementSegment ? `${next.data.title} ready to generate` : `${next.data.title} connected to ${source.data.title}`);
  }

  async function uploadVideoSegmentReplacement(sourceNodeId: string, segmentId: string, file: File) {
    if (!file.type.startsWith("video/") && !/\.(mp4|mov|webm|m4v)$/i.test(file.name)) {
      setNotice("Choose an MP4, MOV or WebM video");
      return;
    }
    setNotice("Uploading replacement clip…");
    const body = await uploadMediaFiles(project.id, "canvas", [file]).catch((error) => ({ assets: undefined, error: error instanceof Error ? error.message : "Could not upload replacement clip" }));
    const asset = body.assets?.[0];
    if (!asset || asset.mediaType !== "video") {
      setNotice(body.error || "Could not upload replacement clip");
      return;
    }
    const sourceNode = nodesRef.current.find((node) => node.id === sourceNodeId);
    if (!sourceNode?.data.videoSegments) return;
    updateNode(sourceNodeId, {
      videoSegments: sourceNode.data.videoSegments.map((segment) => segment.id === segmentId
        ? { ...segment, replacementAssetId: asset.id, replacementUrl: asset.url }
        : segment),
    });
    setNodeCreator(null);
    setNotice("Replacement clip attached to the scene");
  }

  async function uploadMasterClips(nodeId: string, files: File[]) {
    const videos = files.filter((file) => file.type.startsWith("video/") || /\.(mp4|mov|webm|m4v)$/i.test(file.name)).slice(0, 8);
    if (!videos.length) {
      setNotice("Choose MP4, MOV or WebM video clips");
      return;
    }
    setNotice(videos.length === 1 ? "Adding video to the sequence…" : `Adding ${videos.length} videos to the sequence…`);
    const body = await uploadMediaFiles(project.id, "canvas", videos).catch((error) => ({ assets: undefined, error: error instanceof Error ? error.message : "Could not add these video clips" }));
    const assets = (body.assets || []).filter((asset) => asset.mediaType === "video");
    if (!assets.length) {
      setNotice(body.error || "Could not add these video clips");
      return;
    }
    const master = nodesRef.current.find((node) => node.id === nodeId && node.data.kind === "videoMaster");
    if (!master) return;
    const current = master.data.videoMasterClips || [];
    const defaultModel = models.find((item) => item.id === "seedance-2-fast") || models.find((item) => item.mediaType === "video");
    const additions: VideoMasterClip[] = assets.map((asset, index) => {
      const sourceAspectRatio = Math.max(.2, Number(asset.aspectRatio || (asset.width && asset.height ? asset.width / asset.height : master.data.videoAspectRatio) || 9 / 16));
      const ratios = generatorRatiosFor(defaultModel, defaultModel?.defaultResolution, true).filter((ratio) => /^\d+:\d+$/.test(ratio));
      const duration = Math.max(.1, Number(asset.durationSeconds || defaultModel?.defaultDuration || defaultModel?.durations?.[0] || 5));
      return ({
      id: uid("master-clip"),
      sequenceIndex: current.length + index,
      title: mediaTitle(asset.originalName || asset.filename || videos[index]?.name || "Video", `Scene ${String(current.length + index + 1).padStart(2, "0")}`),
      role: "scene",
      origin: "upload",
      duration,
      generationDuration: videoMasterGenerationDuration(defaultModel, { duration } as VideoMasterClip),
      prompt: "",
      modelId: defaultModel?.id,
      aspectRatio: nearestVideoMasterRatio(sourceAspectRatio, ratios),
      aspectRatioMode: "original",
      sourceAspectRatio,
      resolution: defaultModel?.defaultResolution || defaultModel?.resolutions?.[0] || "720P",
      generateAudio: defaultModel?.defaultGenerateAudio ?? false,
      sourceUrl: asset.url,
      sourceAssetId: asset.id,
      thumbnailUrl: assetThumbnailUrl(asset.url),
      });
    });
    const next = [...current, ...additions];
    updateNode(nodeId, {
      videoMasterClips: next,
      videoMasterSelectedClipId: additions[0].id,
      prompt: "",
      modelId: additions[0].modelId,
      duration: String(additions[0].generationDuration || additions[0].duration),
    });
    setNotice(additions.length === 1 ? "Video added to the sequence" : `${additions.length} videos added to the sequence`);
  }

  function updateMasterClipModel(nodeId: string, clipId: string, modelId: string) {
    const master = nodesRef.current.find((node) => node.id === nodeId && node.data.kind === "videoMaster");
    const model = models.find((item) => item.id === modelId && item.mediaType === "video");
    const clip = master?.data.videoMasterClips?.find((item) => item.id === clipId);
    if (!master || !model || !clip) return;
    const nextDuration = videoMasterGenerationDuration(model, clip);
    const supportedRatios = model.ratios?.filter((ratio) => ratio !== "source") || [];
    const nextAspectRatio = clip.aspectRatioMode !== "original" && clip.aspectRatio && supportedRatios.includes(clip.aspectRatio)
      ? clip.aspectRatio
      : nearestVideoMasterRatio(videoMasterSourceRatio(clip, Number(master.data.videoAspectRatio)), supportedRatios);
    const hasVideoInput = nodeReferencePreviews(nodeId, clipId).some((reference) => reference.role === "reference-video" || reference.role === "motion-video");
    const resolutions = generatorResolutionsFor(model, hasVideoInput);
    const nextResolution = clip.resolution && resolutions.includes(clip.resolution)
      ? clip.resolution
      : resolutions.includes(model.defaultResolution || "") ? model.defaultResolution! : resolutions[0] || "720P";
    const supportedRoles = new Set((model.inputPorts || []).map((port) => port.id));
    const nextNodes = nodesRef.current.map((node) => node.id !== nodeId ? node : {
      ...node,
      data: {
        ...node.data,
        modelId,
        duration: String(nextDuration || clip.duration),
        videoMasterClips: node.data.videoMasterClips?.map((item) => item.id === clipId ? {
          ...item,
          modelId,
          generationDuration: nextDuration,
          aspectRatio: nextAspectRatio,
          resolution: nextResolution,
          generateAudio: model.supportsAudio ? item.generateAudio ?? model.defaultGenerateAudio ?? false : false,
          attachedReferences: item.attachedReferences?.filter((reference) => supportedRoles.has(String(reference.role || "reference-image"))),
        } : item),
      },
    });
    let nextEdges = edgesRef.current.filter((edge) => edge.target !== nodeId || edge.data?.masterClipId !== clipId || supportedRoles.has(String(edge.data?.inputRole || "")));
    if (supportedRoles.has("reference-video") && clip.sourceNodeId && clip.sourceSegmentId && !nextEdges.some((edge) => edge.target === nodeId && edge.data?.masterClipId === clipId && edge.data?.inputRole === "reference-video")) {
      const sourceSegment = nodesRef.current.find((node) => node.id === clip.sourceNodeId)?.data.videoSegments?.find((segment) => segment.id === clip.sourceSegmentId);
      if (sourceSegment) nextEdges = upsertGraphEdge(nextEdges, nextNodes, {
        id: uid("edge"),
        source: clip.sourceNodeId,
        sourceHandle: `segment-output:${clip.sourceSegmentId}`,
        target: nodeId,
        targetHandle: `master:${clip.id}:reference-video-input`,
        animated: true,
        hidden: true,
        data: {
          portType: "video",
          inputRole: "reference-video",
          masterClipId: clip.id,
          sourceSegmentId: sourceSegment.id,
          sourceSegmentStart: sourceSegment.start,
          sourceSegmentEnd: sourceSegment.end,
          sourceSegmentLabel: sourceSegment.label,
          sourceSegmentThumbnailUrl: sourceSegment.thumbnailUrl,
          clipAssetId: sourceSegment.clipAssetId,
          clipUrl: sourceSegment.clipUrl,
        },
      }, { replaceTargetInput: false });
    }
    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
    setNodes(nextNodes);
    setEdges(nextEdges);
  }

  function removeMasterClip(nodeId: string, clipId: string) {
    const master = nodesRef.current.find((node) => node.id === nodeId && node.data.kind === "videoMaster");
    const clips = master?.data.videoMasterClips || [];
    const removedIndex = clips.findIndex((clip) => clip.id === clipId);
    if (!master || removedIndex < 0) return;
    const nextClips = clips.filter((clip) => clip.id !== clipId);
    const fallback = nextClips[Math.min(removedIndex, Math.max(0, nextClips.length - 1))];
    const nextNodes = nodesRef.current.map((node) => node.id !== nodeId ? node : {
      ...node,
      data: {
        ...node.data,
        videoMasterClips: nextClips,
        videoMasterSelectedClipId: fallback?.id,
        prompt: fallback?.prompt || "",
        modelId: fallback?.modelId || node.data.modelId,
        duration: fallback ? String(fallback.generationDuration || Math.max(1, fallback.duration || 5)) : node.data.duration,
      },
    });
    const nextEdges = edgesRef.current.filter((edge) => edge.target !== nodeId || edge.data?.masterClipId !== clipId);
    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
    setNodes(nextNodes);
    setEdges(nextEdges);
  }

  async function generateMasterClip(nodeId: string, clipId: string) {
    const master = nodesRef.current.find((node) => node.id === nodeId && node.data.kind === "videoMaster");
    const clip = master?.data.videoMasterClips?.find((item) => item.id === clipId);
    if (!master || !clip || !clip.prompt.trim()) return;
    const sceneReferences = nodeReferencePreviews(nodeId, clipId);
    const availableModels = videoMasterModelsForScene(models, clip, sceneReferences);
    const model = availableModels.find((item) => item.id === clip.modelId)
      || availableModels.find((item) => item.id === "seedance-2-fast")
      || availableModels[0];
    if (!model) {
      setNotice("No video model is available");
      return;
    }
    if (preparingMasterClipIdsRef.current[nodeId] || activeGenerationNodeIds.includes(nodeId)) return;
    preparingMasterClipIdsRef.current = { ...preparingMasterClipIdsRef.current, [nodeId]: clipId };
    setPreparingMasterClipIds(preparingMasterClipIdsRef.current);
    const clearPreparingState = () => {
      if (!preparingMasterClipIdsRef.current[nodeId]) return;
      const next = { ...preparingMasterClipIdsRef.current };
      delete next[nodeId];
      preparingMasterClipIdsRef.current = next;
      setPreparingMasterClipIds(next);
    };
    const duration = String(videoMasterGenerationDuration(model, clip) || videoMasterTimelineDuration(clip));
    let sourceSegment: VideoSceneSegment | undefined;
    let generationSourceAsset: { id: string; url: string; durationSeconds: number } | undefined;
    if (clip.sourceNodeId && clip.sourceSegmentId) {
      try {
        await materializeVideoSegment(clip.sourceNodeId, clip.sourceSegmentId);
        generationSourceAsset = await materializeVideoSegmentForGeneration(clip.sourceNodeId, clip.sourceSegmentId, Number(duration));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not prepare the source scene";
        clearPreparingState();
        updateNode(nodeId, { status: "failed", generationError: message, videoMasterGeneratingClipId: clip.id });
        setNotice(message);
        return;
      }
      sourceSegment = nodesRef.current.find((node) => node.id === clip.sourceNodeId)?.data.videoSegments?.find((segment) => segment.id === clip.sourceSegmentId);
    }
    const sourceRatio = videoMasterSourceRatio(clip, Number(master.data.videoAspectRatio));
    const supportedRatios = generatorRatiosFor(model, clip.resolution, sceneReferences.length > 0).filter((ratio) => ratio !== "source");
    const outputAspectRatio = clip.aspectRatioMode === "custom" && clip.aspectRatio && supportedRatios.includes(clip.aspectRatio)
      ? clip.aspectRatio
      : nearestVideoMasterRatio(sourceRatio, supportedRatios);
    const providerAspectRatio = videoMasterProviderAspectRatio(model.id, outputAspectRatio, sceneReferences);
    const hasVideoInput = sceneReferences.some((reference) => reference.role === "reference-video" || reference.role === "motion-video") || Boolean(generationSourceAsset);
    const resolutions = generatorResolutionsFor(model, hasVideoInput);
    const resolution = clip.resolution && resolutions.includes(clip.resolution)
      ? clip.resolution
      : resolutions.includes(model.defaultResolution || "") ? model.defaultResolution! : resolutions[0] || "720P";
    const prepared: FrameNode = {
      ...master,
      data: {
        ...master.data,
        prompt: clip.prompt,
        modelId: model.id,
        duration,
        generationCount: 1,
        mediaType: "video",
        attachedReferences: clip.attachedReferences,
        aspectRatio: providerAspectRatio as FrameNode["data"]["aspectRatio"],
        resolution: resolution as FrameNode["data"]["resolution"],
        generateAudio: model.supportsAudio ? clip.generateAudio ?? model.defaultGenerateAudio ?? false : false,
        outputUrl: undefined,
        assetId: undefined,
        generatedOutputs: [],
        activeGeneratedOutputIndex: undefined,
        status: "queued",
        queueReason: "plan",
        generationError: undefined,
        videoMasterGeneratingClipId: clip.id,
        videoMasterClips: master.data.videoMasterClips?.map((item) => item.id === clip.id ? { ...item, modelId: model.id, generationDuration: Number(duration), aspectRatio: outputAspectRatio, sourceAspectRatio: sourceRatio } : item),
        replacementFor: clip.sourceNodeId && clip.sourceSegmentId ? {
          sourceNodeId: clip.sourceNodeId,
          segmentId: clip.sourceSegmentId,
          start: clip.sourceStart || 0,
          end: clip.sourceEnd || clip.duration,
        } : undefined,
      },
    };
    const nextNodes = nodesRef.current.map((node) => node.id === nodeId ? prepared : node);
    const supportedInputRoles = new Set((model.inputPorts || []).map((port) => port.id));
    let nextEdges = edgesRef.current.filter((edge) => edge.target !== nodeId || !edge.data?.masterClipId || edge.data.masterClipId !== clip.id || supportedInputRoles.has(String(edge.data?.inputRole || "")));
    const explicitSceneRoles = nextEdges
      .filter((edge) => edge.target === nodeId && edge.data?.masterClipId === clip.id)
      .map((edge) => edge.data?.inputRole);
    const automaticSourceEdgeIndex = nextEdges.findIndex((edge) => edge.target === nodeId
      && edge.source === clip.sourceNodeId
      && edge.data?.masterClipId === clip.id
      && edge.data?.sourceSegmentId === clip.sourceSegmentId
      && edge.data?.inputRole === "reference-video");
    if (automaticSourceEdgeIndex >= 0 && sourceSegment) {
      const edge = nextEdges[automaticSourceEdgeIndex];
      nextEdges = nextEdges.map((item, index) => index !== automaticSourceEdgeIndex ? item : {
        ...edge,
        data: {
          ...edge.data,
          clipAssetId: sourceSegment.clipAssetId,
          clipUrl: sourceSegment.clipUrl,
          generationClipAssetId: generationSourceAsset?.id || sourceSegment.clipAssetId,
          generationClipUrl: generationSourceAsset?.url || sourceSegment.clipUrl,
          generationClipDuration: generationSourceAsset?.durationSeconds || Math.max(.1, sourceSegment.end - sourceSegment.start),
        },
      });
    } else if (supportedInputRoles.has("reference-video")
      && shouldIncludeAutomaticMasterVideoReference(model.id, explicitSceneRoles)
      && clip.sourceNodeId
      && clip.sourceSegmentId
      && sourceSegment
      && !nextEdges.some((edge) => edge.target === nodeId && edge.data?.masterClipId === clip.id && edge.data?.inputRole === "reference-video")) {
      nextEdges = upsertGraphEdge(nextEdges, nextNodes, {
        id: uid("edge"),
        source: clip.sourceNodeId,
        sourceHandle: `segment-output:${clip.sourceSegmentId}`,
        target: nodeId,
        targetHandle: `master:${clip.id}:reference-video-input`,
        animated: true,
        hidden: true,
        data: {
          portType: "video",
          inputRole: "reference-video",
          masterClipId: clip.id,
          sourceSegmentId: sourceSegment.id,
          sourceSegmentStart: sourceSegment.start,
          sourceSegmentEnd: sourceSegment.end,
          sourceSegmentLabel: sourceSegment.label,
          sourceSegmentThumbnailUrl: sourceSegment.thumbnailUrl,
          clipAssetId: sourceSegment.clipAssetId,
          clipUrl: sourceSegment.clipUrl,
          generationClipAssetId: generationSourceAsset?.id || sourceSegment.clipAssetId,
          generationClipUrl: generationSourceAsset?.url || sourceSegment.clipUrl,
          generationClipDuration: generationSourceAsset?.durationSeconds || Math.max(.1, sourceSegment.end - sourceSegment.start),
        },
      }, { replaceTargetInput: false });
    }
    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
    setNodes(nextNodes);
    setEdges(nextEdges);
    clearPreparingState();
    await generate(prepared);
  }

  async function importSource(event: React.FormEvent) {
    event.preventDefault();
    if (!sourceUrl.trim()) return;
    setImporting(true);
    setNotice("");
    const response = await fetch("/api/import/tiktok", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, url: sourceUrl.trim() }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      post?: {
        id: string | null;
        title: string;
        author: string;
        mediaType: "slideshow" | "video";
        totalBytes: number;
        sourceUrl: string;
        publishedAt: string | null;
        stats: { views: number; likes: number; comments: number; shares: number; saves: number };
      };
      assets?: Array<{ id: string; kind: string; role: string; url: string; filename: string; metadata?: Record<string, unknown> }>;
      hook?: HookRecord | null;
      hookError?: string | null;
    };
    setImporting(false);
    if (!response.ok || !body.post || !body.assets) {
      setNotice(body.error || "Import failed");
      return;
    }
    const currentNodes = nodesRef.current;
    const currentEdges = edgesRef.current;
    const existingBottom = currentNodes.reduce((bottom, node) => Math.max(bottom, node.position.y + (node.measured?.height || (node.data.kind === "scene" ? 500 : 170))), 0);
    const blockTop = currentNodes.length > 0 ? existingBottom + 160 : 60;
    const sourceId = uid("source");
    const videoAsset = body.post.mediaType === "video" ? body.assets.find((asset) => asset.kind === "video") : undefined;
    const videoTimelineId = videoAsset ? uid("source") : "";
    const timelineSpriteAsset = body.post.mediaType === "video"
      ? body.assets.find((asset) => asset.kind === "scene" && asset.metadata?.timelineSprite === true)
      : undefined;
    const detectedSceneAssets = body.post.mediaType === "video"
      ? body.assets.filter((asset) => asset.kind === "scene" && asset.metadata?.timelineSprite !== true)
      : [];
    const videoDuration = Number(videoAsset?.metadata?.duration || detectedSceneAssets.at(-1)?.metadata?.end || 0);
    const videoSegments: VideoSceneSegment[] = detectedSceneAssets.map((asset, index) => ({
      id: `video-scene-${asset.id}`,
      index: index + 1,
      sequenceIndex: index,
      label: `Scene ${String(index + 1).padStart(2, "0")}`,
      role: (asset.role === "hook" || asset.role === "cta" ? asset.role : "scene") as VideoSceneSegment["role"],
      start: Number(asset.metadata?.start || 0),
      end: Number(asset.metadata?.end || videoDuration),
      confidence: Number(asset.metadata?.confidence || 0),
      thumbnailAssetId: asset.id,
      thumbnailUrl: asset.url,
      thumbnailTime: Number(asset.metadata?.start || 0),
    }));
    const sourceNode: FrameNode = {
      id: sourceId,
      type: "frameNode",
      position: { x: 80, y: blockTop + 200 },
      data: {
        kind: "source",
        title: body.post.title || `@${body.post.author}`,
        subtitle: body.post.mediaType === "video"
          ? `TikTok video · ${formatBytes(body.post.totalBytes)}`
          : `${body.post.mediaType} · ${body.assets.length} assets · ${formatBytes(body.post.totalBytes)}`,
        sourceUrl: body.post.sourceUrl,
        postId: body.post.id || undefined,
        tiktokMediaType: body.post.mediaType,
        author: body.post.author,
        publishedAt: body.post.publishedAt || undefined,
        postStats: body.post.stats,
        hookId: body.hook?.id,
        hookText: body.hook?.text,
        status: "ready",
      },
    };
    const videoTimelineNode: FrameNode | null = videoAsset ? {
      id: videoTimelineId,
      type: "frameNode",
      position: { x: 430, y: blockTop },
      data: {
        kind: "source",
        title: body.post.title || `@${body.post.author}`,
        subtitle: `${videoSegments.length} detected scene${videoSegments.length === 1 ? "" : "s"} · ${formatBytes(body.post.totalBytes)}`,
        sourceUrl: body.post.sourceUrl,
        assetId: videoAsset.id,
        imageUrl: videoAsset.url,
        mediaType: "video",
        videoSegments: videoSegments.length ? videoSegments : undefined,
        videoDetectedSegments: videoSegments.length ? videoSegments.map((segment) => ({ ...segment })) : undefined,
        videoDurationSeconds: videoDuration || undefined,
        videoTimelineSprite: timelineSpriteAsset ? {
          assetId: timelineSpriteAsset.id,
          url: timelineSpriteAsset.url,
          frameCount: Number(timelineSpriteAsset.metadata?.frameCount || 12),
          columns: Number(timelineSpriteAsset.metadata?.columns || 0) || undefined,
          rows: Number(timelineSpriteAsset.metadata?.rows || 0) || undefined,
        } : undefined,
        nodeWidth: 580,
        postId: body.post.id || undefined,
        tiktokMediaType: "video",
        author: body.post.author,
        publishedAt: body.post.publishedAt || undefined,
        postStats: body.post.stats,
        hookId: body.hook?.id,
        hookText: body.hook?.text,
        status: "ready",
      },
    } : null;
    const visuals = body.post.mediaType === "video" ? [] : body.assets.filter((asset) => asset.kind !== "video");
    const sceneNodes: FrameNode[] = visuals.map((asset, index) => ({
      id: uid("scene"),
      type: "frameNode",
      position: { x: 430 + (index % 5) * 310, y: blockTop + Math.floor(index / 5) * 545 },
      data: {
        kind: "scene",
        title: `Screen ${String(index + 1).padStart(2, "0")}`,
        subtitle: asset.kind === "slide" ? "Original slideshow screen" : "Extracted video screen",
        role: asset.role,
        assetId: asset.id,
        imageUrl: asset.url,
        tiktokSourceNodeId: sourceId,
        status: "ready",
      },
    }));
    const sourceEdges = videoTimelineNode
      ? [{ id: uid("edge"), source: sourceId, sourceHandle: "output", target: videoTimelineNode.id, targetHandle: "input", animated: true, data: { portType: "video" as const } }]
      : sceneNodes.map((node) => ({ id: uid("edge"), source: sourceId, sourceHandle: "output", target: node.id, targetHandle: "input", animated: true }));
    const importedNodes = videoTimelineNode ? [sourceNode, videoTimelineNode] : [sourceNode, ...sceneNodes];
    pushHistory();
    // Import completion is one live graph transaction: the previous media
    // owner relinquishes its lease and the new editable visual becomes the
    // exclusive selection before the first user Play command can arrive.
    // Selection itself remains ephemeral because stableGraphNodes strips it
    // from persistence.
    const focusedImportedNode = videoTimelineNode || sceneNodes[0] || sourceNode;
    stopAllVideoPlayback();
    // The collaboration mutation inside commitGraph may synchronously emit a
    // hydrated graph. Publish the local selection authority first so that
    // hydration cannot strip the new editor's media lease during this same
    // import transaction.
    setSelectedId(focusedImportedNode.id);
    commitGraph(selectGraphNode([...currentNodes, ...importedNodes], focusedImportedNode.id), [...currentEdges, ...sourceEdges]);
    setProject((current) => ({ ...current, sourceUrl: current.sourceUrl || body.post!.sourceUrl }));
    if (body.hook) setHooks((current) => current.some((item) => item.id === body.hook?.id) ? current : [body.hook!, ...current]);
    setSourceUrl("");
    setNotice(`${body.post.mediaType === "video" ? `Imported video · ${videoSegments.length} scenes detected` : `Imported ${visuals.length} screens`}${body.hook ? " · hook extracted" : body.hookError ? " · hook extraction needs retry" : ""}`);
    window.setTimeout(() => {
      void fitView({ nodes: importedNodes.slice(0, 5), padding: body.post!.mediaType === "video" ? 0.22 : 0.16, duration: 650 });
    }, 80);
  }

  async function createProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const canvasNumber = projects.filter((item) => item.workspaceId === workspace.id).length + 1;
    const name = String(new FormData(form).get("projectName") || "").trim() || `Canvas ${String(canvasNumber).padStart(2, "0")}`;
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, workspaceId: workspace.id }),
    });
    const body = (await response.json()) as { project: ProjectRecord };
    setProjects((current) => [body.project, ...current]);
    setNewProjectFormOpen(false);
    setProjectLibraryOpen(false);
    form.reset();
    await switchProject(body.project);
  }

  async function importScenelithDocument(file: File) {
    if (recipeImporting) return;
    setRecipeImporting(true);
    try {
      const document = JSON.parse(await file.text()) as unknown;
      const response = await fetch("/api/projects/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: workspace.id, document }),
      });
      const body = (await response.json().catch(() => ({}))) as { project?: ProjectRecord; error?: string };
      if (!response.ok || !body.project) throw new Error(body.error || "Could not import this Scenelith document");
      setProjects((current) => [body.project!, ...current.filter((item) => item.id !== body.project!.id)]);
      setProjectLibraryOpen(false);
      await switchProject(body.project);
      setNotice(`Imported ${body.project.name} · connect the required local inputs`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not import this Scenelith document");
    } finally {
      setRecipeImporting(false);
      if (recipeImportInputRef.current) recipeImportInputRef.current.value = "";
    }
  }

  async function renameProject() {
    const name = projectNameDraft.trim();
    if (!name) { setProjectNameDraft(project.name); return; }
    if (name === project.name) return;
    const response = await fetch(`/api/projects/${project.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    const body = (await response.json().catch(() => ({}))) as { project?: ProjectRecord; error?: string };
    if (!response.ok || !body.project) { setProjectNameDraft(project.name); setNotice(body.error || "Could not rename canvas"); return; }
    setProject(body.project);
    setProjectNameDraft(body.project.name);
    setProjects((current) => current.map((item) => item.id === body.project?.id ? body.project! : item));
    setNotice("Canvas renamed");
  }

  async function renameWorkspaceInline(item: WorkspaceRecord) {
    const name = inlineWorkspaceName.trim();
    setEditingWorkspaceId(null);
    if (!name || name === item.name) return;
    const response = await fetch(`/api/workspaces/${item.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    const body = (await response.json().catch(() => ({}))) as { workspace?: WorkspaceRecord; error?: string };
    if (!response.ok || !body.workspace) { setNotice(body.error || "Could not rename project"); return; }
    setWorkspaces((current) => current.map((entry) => entry.id === item.id ? body.workspace! : entry));
    if (workspace.id === item.id) setWorkspace(body.workspace);
  }

  async function switchProject(next: ProjectRecord, targetWorkspace?: WorkspaceRecord) {
    if (next.id === project.id) {
      setProjectLibraryOpen(false);
      return;
    }
    const sequence = ++projectSwitchSequence.current;
    const previousProject = project;
    const previousWorkspace = workspace;
    const previousNodes = nodesRef.current;
    const previousEdges = edgesRef.current;
    const previousViewport = viewportRef.current;
    const restorePreviousProject = () => {
      const restoredProject = projectCacheRef.current.get(previousProject.id) || previousProject;
      initialHydration.current = true;
      dirtyTrackingProjectRef.current = "";
      setProject(restoredProject);
      setProjectNameDraft(restoredProject.name);
      setWorkspace(previousWorkspace);
      nodesRef.current = previousNodes;
      edgesRef.current = previousEdges;
      localNodesStateRef.current = previousNodes;
      localEdgesStateRef.current = previousEdges;
      setNodesState(previousNodes);
      setEdgesState(previousEdges);
      viewportRef.current = previousViewport;
      void setViewport(previousViewport, { duration: 0 });
    };
    const applyLoadedProject = (latest: ProjectRecord) => {
      const stableNodes = stableGraphNodes(latest.graph.nodes || []);
      const latestEdges = normalizeEdgePorts(latest.graph.edges || [], stableNodes);
      const latestNodes = applyModelCatalogue(stableNodes, latestEdges, models);
      savedProjectSignatures.current[latest.id] = projectSaveSignature(latest, stableNodes, latestEdges);
      projectCacheRef.current.set(latest.id, latest);
      initialHydration.current = true;
      dirtyTrackingProjectRef.current = "";
      setProject(latest);
      setProjectNameDraft(latest.name);
      setProjects((current) => current.map((item) => item.id === latest.id ? { ...latest, summary: projectStats(latest) } : item));
      nodesRef.current = latestNodes;
      edgesRef.current = latestEdges;
      localNodesStateRef.current = latestNodes;
      localEdgesStateRef.current = latestEdges;
      setNodesState(latestNodes);
      setEdgesState(latestEdges);
      pastRef.current = [];
      futureRef.current = [];
      refreshHistoryControls();
      setSelectedId(null);
      const restoredViewport = latest.graph.viewport;
      viewportRef.current = restoredViewport || { x: 0, y: 0, zoom: 1 };
      window.setTimeout(() => {
        if (restoredViewport) {
          void setViewport(restoredViewport, { duration: 0 });
          return;
        }
        void fitView({ nodes: latestNodes.slice(0, 4), padding: 0.2, duration: 0, maxZoom: 1.08 });
      }, 0);
    };
    if (viewportSaveTimerRef.current !== null) {
      window.clearTimeout(viewportSaveTimerRef.current);
      viewportSaveTimerRef.current = null;
    }
    setProjectSwitchingId(next.id);
    setProjectLibraryOpen(false);
    setWorkspaceLibraryOpen(false);
    projectCacheRef.current.set(project.id, {
      ...project,
      graph: { ...project.graph, nodes: nodesRef.current, edges: edgesRef.current, viewport: viewportRef.current },
    });
    const memoryCachedTarget = projectCacheRef.current.get(next.id);
    const cachedTarget = memoryCachedTarget && (memoryCachedTarget.revision === next.revision || dirtyProjectIdsRef.current.has(next.id))
      ? memoryCachedTarget
      : readProjectSessionCache(next.id, next.revision);
    projectHydratingIdRef.current = next.id;
    setProjectHydratingId(next.id);
    void save(true);
    stopAllVideoPlayback();
    initialHydration.current = true;
    setProject(cachedTarget || next);
    setProjectNameDraft(next.name);
    if (targetWorkspace || next.workspaceId !== workspace.id) {
      const nextWorkspace = targetWorkspace || workspaces.find((item) => item.id === next.workspaceId);
      if (nextWorkspace) {
        if (nextWorkspace.id !== workspace.id) {
          setLibraryProjectFilter("all");
          setLibraryCanvasMenuOpen(false);
          setLibrarySearch("");
        }
        lastSavedRole.current = nextWorkspace.rolePrompt;
        setRoleSaveState("idle");
        setWorkspace(nextWorkspace);
      }
    }
    if (!cachedTarget) {
      nodesRef.current = [];
      edgesRef.current = [];
      localNodesStateRef.current = [];
      localEdgesStateRef.current = [];
      setNodesState([]);
      setEdgesState([]);
      setSelectedId(null);
      viewportRef.current = { x: 0, y: 0, zoom: 1 };
      void setViewport(viewportRef.current, { duration: 0 });
    }
    if (cachedTarget) {
      applyLoadedProject(cachedTarget);
      return;
    }

    // The realtime document is the normal cold-load path. Only fall back to
    // the PostgreSQL JSON projection when WebSocket sync has not completed;
    // this avoids hydrating the same full graph through HTTP and Yjs.
    window.setTimeout(() => {
      if (sequence !== projectSwitchSequence.current || projectHydratingIdRef.current !== next.id) return;
      void loadProjectRecord(next.id, next.revision).then(async (latest) => {
        if (sequence !== projectSwitchSequence.current || projectHydratingIdRef.current !== next.id) return;
        if (!latest) {
          restorePreviousProject();
          const [projectResponse, workspaceResponse] = await Promise.all([
            fetch("/api/projects", { cache: "no-store" }),
            fetch("/api/workspaces", { cache: "no-store" }),
          ]);
          const projectBody = (await projectResponse.json().catch(() => ({}))) as { projects?: ProjectRecord[] };
          const workspaceBody = (await workspaceResponse.json().catch(() => ({}))) as { workspaces?: WorkspaceRecord[] };
          if (projectBody.projects) setProjects(projectBody.projects.map((item) => item.id === project.id ? { ...item, graph: project.graph } : item));
          if (workspaceBody.workspaces) setWorkspaces(workspaceBody.workspaces);
          setNotice("Access to this canvas has changed");
        } else {
          // A projection or cache may be painted immediately, but it stays
          // behind the read-only hydration guard until Yjs confirms the
          // authoritative document. Otherwise a late realtime sync could
          // overwrite edits made against a stale JSON projection.
          applyLoadedProject(latest);
          setProjectSwitchingId(null);
        }
        if (!latest) {
          projectHydratingIdRef.current = null;
          setProjectSwitchingId(null);
          setProjectHydratingId(null);
        }
      });
    }, 1_200);
  }

  async function switchWorkspace(next: WorkspaceRecord) {
    if (next.id === workspace.id) { setWorkspaceLibraryOpen(false); return; }
    setWorkspaceLibraryOpen(false);
    setProjectLibraryOpen(false);
    setIdentityLibraryOpen(false);
    setHookLibraryOpen(false);
    const existing = projects.filter((item) => item.workspaceId === next.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (existing) await switchProject(existing, next);
    else if (next.memberRole === "member") {
      setNotice("No canvases are assigned in this project");
      const response = await fetch("/api/workspaces", { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as { workspaces?: WorkspaceRecord[] };
      if (body.workspaces) setWorkspaces(body.workspaces);
    }
    else {
      const response = await fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Canvas 01", workspaceId: next.id }) });
      const body = (await response.json()) as { project: ProjectRecord };
      setProjects((current) => [body.project, ...current]);
      await switchProject(body.project, next);
    }
  }

  async function createWorkspace(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const response = await fetch("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: String(data.get("workspaceName") || ""), rolePrompt: String(data.get("rolePrompt") || "") }) });
    const body = (await response.json().catch(() => ({}))) as { error?: string; workspace?: WorkspaceRecord };
    if (!response.ok || !body.workspace) { setNotice(body.error || "Could not create app"); return; }
    setWorkspaces((current) => [body.workspace!, ...current]);
    setNewWorkspaceFormOpen(false);
    form.reset();
    await switchWorkspace(body.workspace);
  }

  async function generateHooks(source: HookRecord) {
    if (!workspace.rolePrompt.trim()) { setNotice("Add the app role before generating hooks"); return; }
    setHookBusy(true);
    const response = await fetch("/api/hooks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "generate", workspaceId: workspace.id, sourceHookId: source.id, count: hookVariantCount }) });
    const body = (await response.json().catch(() => ({}))) as { hooks?: HookRecord[]; error?: string };
    setHookBusy(false);
    if (!response.ok || !Array.isArray(body.hooks)) { setNotice(body.error || "Hook generation failed"); return; }
    setHooks(body.hooks);
    setNotice(`${hookVariantCount} compact ${hookVariantCount === 1 ? "variant" : "variants"} replaced`);
  }

  async function createManualHook(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const text = String(formData.get("hookText") || "").trim();
    const views = Math.max(0, Number(formData.get("hookViews") || 0));
    if (!text) return;
    const response = await fetch("/api/hooks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "manual", workspaceId: workspace.id, projectId: project.id, text, views }) });
    const body = (await response.json().catch(() => ({}))) as { hooks?: HookRecord[]; error?: string };
    if (!response.ok || !Array.isArray(body.hooks)) { setNotice(body.error || "Could not save hook"); return; }
    setHooks(body.hooks); form.reset(); setNotice("Hook saved");
  }

  async function copyHook(hook: HookRecord) {
    await navigator.clipboard.writeText(hook.text);
    setNotice("Hook copied");
  }

  async function createPersona(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (personaSaving) return;
    const form = event.currentTarget;
    const formData = new FormData(form);
    personaDraftFiles.reference.forEach((file) => formData.append("referenceImages", file));
    personaDraftFiles.before.forEach((file) => formData.append("beforeImages", file));
    personaDraftFiles.after.forEach((file) => formData.append("afterImages", file));
    if (![...personaDraftFiles.reference, ...personaDraftFiles.before, ...personaDraftFiles.after].length) {
      setNotice("Choose at least one JPG or PNG reference");
      return;
    }
    setPersonaSaving(true);
    setPersonaSaveProgress(0);
    try {
      const body = await uploadFormData<{ personas?: PersonaRecord[] }>("/api/personas", "POST", formData, setPersonaSaveProgress);
      if (!Array.isArray(body.personas)) throw new Error("Could not add identity");
      setPersonas(body.personas);
      setPersonaFormOpen(false);
      setPersonaDraftFiles({ reference: [], before: [], after: [] });
      setPersonaMode("single");
      form.reset();
      setNotice("Identity saved");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not add identity");
    } finally {
      setPersonaSaving(false);
      setPersonaSaveProgress(0);
    }
  }

  function addPersonaDraftFiles(role: "reference" | "before" | "after", files: File[]) {
    const accepted = files.filter(isAcceptedPersonaImage);
    if (files.length && !accepted.length) setNotice("Use JPG or PNG reference images");
    setPersonaDraftFiles((current) => {
      const existing = new Set([...current.reference, ...current.before, ...current.after].map((file) => `${file.name}:${file.size}:${file.lastModified}`));
      const additions = accepted.filter((file) => !existing.has(`${file.name}:${file.size}:${file.lastModified}`));
      const available = Math.max(0, MAX_PERSONA_REFERENCES - current.reference.length - current.before.length - current.after.length);
      return { ...current, [role]: [...current[role], ...additions.slice(0, available)] };
    });
  }

  function removePersonaDraftFile(role: "reference" | "before" | "after", index: number) {
    setPersonaDraftFiles((current) => ({ ...current, [role]: current[role].filter((_, itemIndex) => itemIndex !== index) }));
  }

  async function appendPersonaAssets(personaId: string, role: "reference" | "before" | "after", files: File[]) {
    const persona = personas.find((item) => item.id === personaId);
    const accepted = files.filter(isAcceptedPersonaImage).slice(0, Math.max(0, MAX_PERSONA_REFERENCES - (persona?.assets.length || 0)));
    if (!accepted.length) {
      setNotice(files.length ? "Use JPG or PNG reference images" : "Choose at least one image");
      return;
    }
    const uploadKey = personaSelectionKey(personaId, role);
    setPersonaUploads((current) => ({ ...current, [uploadKey]: { files: accepted, progress: 0 } }));
    const form = new FormData();
    form.set("workspaceId", workspace.id);
    form.set("personaId", personaId);
    form.set("role", role);
    accepted.forEach((file) => form.append("images", file));
    try {
      const body = await uploadFormData<{ personas?: PersonaRecord[] }>("/api/personas", "PATCH", form, (progress) => {
        setPersonaUploads((current) => current[uploadKey] ? { ...current, [uploadKey]: { ...current[uploadKey], progress } } : current);
      });
      if (!Array.isArray(body.personas)) throw new Error("Could not add references");
      setPersonas(body.personas);
      setNotice(`${accepted.length} ${role} reference${accepted.length === 1 ? "" : "s"} added`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not add references");
    } finally {
      setPersonaUploads((current) => {
        const next = { ...current };
        delete next[uploadKey];
        return next;
      });
    }
  }

  async function addGeneratedAssetToIdentity(personaId: string, role: "reference" | "before" | "after", sourceAssetId: string) {
    const response = await fetch("/api/personas", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: workspace.id, personaId, role, sourceAssetId }),
    });
    const body = (await response.json().catch(() => ({}))) as { personas?: PersonaRecord[]; alreadyAdded?: boolean; error?: string };
    if (!response.ok || !Array.isArray(body.personas)) throw new Error(body.error || "Could not add reference");
    setPersonas(body.personas);
    const personaName = body.personas.find((persona) => persona.id === personaId)?.name || "identity";
    setNotice(body.alreadyAdded ? `Already saved in ${personaName} · ${role}` : `Added to ${personaName} · ${role}`);
    return { alreadyAdded: Boolean(body.alreadyAdded) };
  }

  async function createIdentityFromGeneratedAsset(name: string, role: "reference" | "before" | "after", sourceAssetId: string) {
    const response = await fetch("/api/personas", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: workspace.id, name, role, sourceAssetId }),
    });
    const body = (await response.json().catch(() => ({}))) as { personas?: PersonaRecord[]; personaId?: string; error?: string };
    if (!response.ok || !Array.isArray(body.personas)) throw new Error(body.error || "Could not create identity");
    setPersonas(body.personas);
    setNotice(`${name.trim()} created with this image`);
  }

  async function deletePersonaAsset(personaId: string, assetId: string) {
    if (deletingPersonaAssetIds.includes(assetId)) return;
    setDeletingPersonaAssetIds((current) => [...current, assetId]);
    try {
      const response = await fetch("/api/personas", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: workspace.id, personaId, assetId }) });
      const body = (await response.json().catch(() => ({}))) as { error?: string; personas?: PersonaRecord[] };
      if (!response.ok || !Array.isArray(body.personas)) throw new Error(body.error || "Could not remove reference");
      setPersonas(body.personas);
      setSelectedPersonaAssets((current) => Object.fromEntries(Object.entries(current).map(([key, ids]) => [key, ids.filter((id) => id !== assetId)])));
      setNotice("Reference removed");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not remove reference");
    } finally {
      setDeletingPersonaAssetIds((current) => current.filter((id) => id !== assetId));
    }
  }

  async function reorderPersonaAssets(personaId: string, role: "reference" | "before" | "after", sourceId: string, targetId: string) {
    const persona = personas.find((item) => item.id === personaId);
    const reorderKey = personaSelectionKey(personaId, role);
    if (!persona || sourceId === targetId || personaReorderSavingKey === reorderKey) return;
    const roleAssets = persona.assets.filter((asset) => asset.role === role);
    const sourceIndex = roleAssets.findIndex((asset) => asset.id === sourceId);
    const targetIndex = roleAssets.findIndex((asset) => asset.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const reorderedRoleAssets = [...roleAssets];
    const [movedAsset] = reorderedRoleAssets.splice(sourceIndex, 1);
    reorderedRoleAssets.splice(targetIndex, 0, movedAsset);
    const orderedQueue = [...reorderedRoleAssets];
    const nextAssets = persona.assets.map((asset) => asset.role === role ? orderedQueue.shift()! : asset);
    const nextAvatar = nextAssets.find((asset) => asset.role === "after") || nextAssets.find((asset) => asset.role === "reference") || nextAssets[0];
    const optimisticPersona = { ...persona, assets: nextAssets, avatarUrl: nextAvatar?.url };
    setPersonas((current) => current.map((item) => item.id === personaId ? optimisticPersona : item));
    setPersonaReorderSavingKey(reorderKey);
    try {
      const response = await fetch("/api/personas", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: workspace.id, personaId, role, assetIds: reorderedRoleAssets.map((asset) => asset.id) }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; personas?: PersonaRecord[] };
      if (!response.ok || !Array.isArray(body.personas)) throw new Error(body.error || "Could not save reference order");
      setPersonas(body.personas);
    } catch (error) {
      setPersonas((current) => current.map((item) => item.id === personaId ? persona : item));
      setNotice(error instanceof Error ? error.message : "Could not save reference order");
    } finally {
      setPersonaReorderSavingKey(null);
    }
  }

  function personaSelectionKey(personaId: string, variant: "reference" | "before" | "after") {
    return `${personaId}:${variant}`;
  }

  function togglePersonaAsset(personaId: string, variant: "reference" | "before" | "after", assetId: string) {
    const key = personaSelectionKey(personaId, variant);
    setSelectedPersonaAssets((current) => {
      const selected = current[key] || [];
      return { ...current, [key]: selected.includes(assetId) ? selected.filter((id) => id !== assetId) : [...selected, assetId] };
    });
  }

  function selectedAssetsFor(persona: PersonaRecord, variant: "reference" | "before" | "after") {
    const selected = selectedPersonaAssets[personaSelectionKey(persona.id, variant)] || [];
    return persona.assets.filter((asset) => asset.role === variant && selected.includes(asset.id));
  }

  function placePersona(persona: PersonaRecord, variant: "reference" | "before" | "after", position?: { x: number; y: number }) {
    const variantAssets = persona.assets.filter((asset) => asset.role === variant);
    const chosenAssets = selectedAssetsFor(persona, variant);
    if (!variantAssets.length || !chosenAssets.length) return;
    const variantLabel = variant === "reference" ? "Character" : variant === "before" ? "Before" : "After";
    addNode("persona", {
      title: `${persona.name} · ${variantLabel}`,
      subtitle: `${chosenAssets.length} selected reference${chosenAssets.length === 1 ? "" : "s"}`,
      personaId: persona.id,
      personaVariant: variant,
      referenceAssetIds: chosenAssets.map((asset) => asset.id),
      imageUrl: chosenAssets[0]?.url,
      status: "ready",
    }, position);
    setIdentityLibraryOpen(false);
  }

  function beginPersonaDrag(event: React.DragEvent<HTMLElement>, persona: PersonaRecord, variant: "reference" | "before" | "after") {
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("application/x-frameflow-persona", JSON.stringify({ personaId: persona.id, variant }));
    event.dataTransfer.setData("text/plain", `${persona.name} · ${variant}`);
    setPersonaDragActive(true);
  }

  function dropPersonaOnCanvas(event: React.DragEvent<HTMLDivElement>) {
    const payload = event.dataTransfer.getData("application/x-frameflow-persona");
    if (!payload) return;
    event.preventDefault();
    try {
      const parsed = JSON.parse(payload) as { personaId: string; variant: "reference" | "before" | "after" };
      const persona = personas.find((item) => item.id === parsed.personaId);
      if (!persona) return;
      placePersona(persona, parsed.variant, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
      setPersonaDragActive(false);
    } catch { setPersonaDragActive(false); setNotice("Could not place identity"); }
  }

  async function loadMoreLibraryMedia() {
    if (!libraryCursor || libraryLoadingMore) return;
    setLibraryLoadingMore(true);
    const params = new URLSearchParams({ workspaceId: workspace.id, mediaType: libraryMediaFilter, cursor: libraryCursor });
    if (libraryProjectFilter !== "all") params.set("projectId", libraryProjectFilter);
    if (librarySearch.trim()) params.set("search", librarySearch.trim());
    try {
      const response = await fetch(`/api/assets?${params}`, { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as { assets?: LibraryMediaAsset[]; nextCursor?: string | null; error?: string };
      if (!response.ok || !body.assets) throw new Error(body.error || "Could not load more media");
      setLibraryAssets((current) => [...current, ...body.assets!.filter((asset) => !current.some((item) => item.id === asset.id))]);
      setLibraryCursor(body.nextCursor || null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not load more media");
    } finally {
      setLibraryLoadingMore(false);
    }
  }

  function stageLibraryMedia(files: File[]) {
    const next = [...libraryUploadFiles];
    const errors: string[] = [];
    for (const file of files) {
      if (next.some((item) => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified)) continue;
      const fileError = libraryMediaFileError(file);
      if (fileError) {
        errors.push(fileError);
        continue;
      }
      if (next.length >= LIBRARY_MAX_FILES) {
        errors.push(`Choose up to ${LIBRARY_MAX_FILES} files per upload`);
        break;
      }
      if (next.reduce((total, item) => total + item.size, 0) + file.size > LIBRARY_MAX_TOTAL_BYTES) {
        errors.push(`${file.name}: selection would exceed the ${formatBytes(LIBRARY_MAX_TOTAL_BYTES)} batch limit`);
        continue;
      }
      next.push(file);
    }
    setLibraryUploadFiles(next);
    setLibraryUploadError(errors.length ? `${errors[0]}${errors.length > 1 ? ` · ${errors.length - 1} more skipped` : ""}` : "");
    setLibraryUploadDragActive(false);
  }

  function closeLibraryUpload() {
    if (libraryUploadBusy) return;
    setLibraryUploadOpen(false);
    setLibraryUploadDragActive(false);
    setLibraryUploadError("");
    setLibraryUploadFiles([]);
    setLibraryUploadProgress(0);
  }

  async function uploadLibraryMedia() {
    if (!libraryUploadFiles.length) {
      setLibraryUploadError("Choose at least one image or video");
      return;
    }
    setLibraryUploadBusy(true);
    setLibraryUploadError("");
    setLibraryUploadProgress(1);
    try {
      const body = await uploadMediaFiles(project.id, "library", libraryUploadFiles, setLibraryUploadProgress);
      if (!body.assets?.length) throw new Error(body.error || "Could not add media to Library");
      setLibraryProjectFilter("all");
      setLibrarySearch("");
      setLibraryRefreshToken((value) => value + 1);
      setNotice(`${body.assets.length} ${body.assets.length === 1 ? "file" : "files"} added to Library — no canvas nodes created`);
      setLibraryUploadOpen(false);
      setLibraryUploadFiles([]);
      setLibraryUploadProgress(0);
    } catch (error) {
      setLibraryUploadError(error instanceof Error ? error.message : "Could not add media to Library");
      setLibraryUploadProgress(0);
    } finally {
      setLibraryUploadBusy(false);
    }
  }

  function openLibraryAsset(asset: LibraryMediaAsset) {
    stopAllVideoPlayback();
    setPreviewMode("view");
    setPreviewMedia({ url: asset.url, title: `${asset.mediaType === "video" ? "Video" : "Image"} · ${asset.canvasName}` });
    setPreviewNode({
      id: `library:${asset.id}`,
      type: "frameNode",
      position: { x: 0, y: 0 },
      data: {
        kind: "scene",
        title: `${asset.mediaType === "video" ? "Generated video" : "Generated image"}`,
        subtitle: asset.canvasName,
        imageUrl: asset.url,
        mediaType: asset.mediaType,
        modelId: asset.modelId,
        createdAt: asset.createdAt,
        generatedAt: asset.createdAt,
        duration: asset.durationSeconds ? String(asset.durationSeconds) : undefined,
        videoDurationSeconds: asset.durationSeconds,
        videoAspectRatio: asset.aspectRatio,
        status: "ready",
      },
    });
  }

  function placeLibraryAsset(asset: LibraryMediaAsset) {
    const projectLabel = asset.projectId === project.id ? "Generated on this canvas" : `From ${asset.canvasName}`;
    addNode("scene", {
      title: asset.mediaType === "video" ? "Generated video" : "Generated image",
      subtitle: projectLabel,
      role: asset.mediaType === "video" ? "video" : "scene",
      assetId: asset.id,
      imageUrl: asset.url,
      mediaType: asset.mediaType,
      modelId: asset.modelId,
      duration: asset.durationSeconds ? String(asset.durationSeconds) : undefined,
      videoDurationSeconds: asset.durationSeconds,
      videoAspectRatio: asset.aspectRatio,
      generatedAt: asset.createdAt,
      status: "ready",
    }, canvasCenterPosition());
    setIdentityLibraryOpen(false);
    setNotice(`${asset.mediaType === "video" ? "Video" : "Image"} added from Library`);
  }

  function updateNode(nodeId: string, data: Partial<FrameNode["data"]>) {
    const currentNode = nodesRef.current.find((node) => node.id === nodeId);
    if (!currentNode || Object.entries(data).every(([key, value]) => Object.is(currentNode.data[key as keyof FrameNode["data"]], value))) return;
    const next = nodesRef.current.map((node) => node.id === nodeId ? { ...node, data: { ...node.data, ...data } } : node);
    nodesRef.current = next;
    setNodes(next);
    setPreviewNode((current) => {
      if (current?.id !== nodeId || Object.entries(data).every(([key, value]) => Object.is(current.data[key as keyof FrameNode["data"]], value))) return current;
      return { ...current, data: { ...current.data, ...data } };
    });
  }

  function selectCanvasNode(nodeId: string) {
    // Canvas focus and media transport are independent state machines.
    // Selecting a node must never publish Stop: nested editor controls select
    // and play during the same pointer gesture, while React Flow can deliver
    // its selection changes in a later phase. Stopping here lets that late
    // selection revoke the newer Play command and makes the user click again.
    // Explicit pane/preview actions and the playback manager remain the only
    // authorities allowed to stop foreground media.
    const selectedNodes = nodesRef.current.filter((node) => node.selected);
    const alreadyExclusivelySelected = selectedNodes.length === 1 && selectedNodes[0]?.id === nodeId;
    setSelectedId(nodeId);
    if (alreadyExclusivelySelected) return;
    // Nested Video Master controls update their clip immediately after
    // selecting the node. Commit selection to the shared ref synchronously so
    // that follow-up update cannot overwrite it with the previous graph.
    const next = selectGraphNode(nodesRef.current, nodeId);
    nodesRef.current = next;
    setNodes(next);
  }

  function focusMasterClipSource(nodeId: string, clipId: string) {
    const master = nodesRef.current.find((node) => node.id === nodeId && node.data.kind === "videoMaster");
    const clip = master?.data.videoMasterClips?.find((item) => item.id === clipId);
    const edge = edgesRef.current.find((item) => item.target === nodeId && (
      item.data?.masterClipId === clipId
      || String(item.targetHandle || "").startsWith(`master:${clipId}:`)
    ) && (item.data?.portType === "video" || item.sourceHandle?.startsWith("segment-output:")));
    const sourceNodeId = edge?.source || clip?.sourceNodeId || master?.data.videoMasterSourceNodeId;
    const source = nodesRef.current.find((node) => node.id === sourceNodeId);
    const explicitSegmentId = String(edge?.data?.sourceSegmentId
      || (edge?.sourceHandle?.startsWith("segment-output:") ? edge.sourceHandle.slice("segment-output:".length) : "")
      || clip?.sourceSegmentId
      || "");
    const clipIndex = Math.max(0, Number(clip?.sequenceIndex ?? master?.data.videoMasterClips?.findIndex((item) => item.id === clipId) ?? 0));
    const fallbackSegment = [...(source?.data.videoSegments || [])]
      .sort((left, right) => Number(left.sequenceIndex ?? left.index) - Number(right.sequenceIndex ?? right.index) || left.start - right.start)[clipIndex];
    const sourceSegmentId = explicitSegmentId || fallbackSegment?.id || "";
    if (!source || !sourceSegmentId || !source.data.videoSegments?.some((segment) => segment.id === sourceSegmentId)) return;
    updateNode(source.id, { videoOutputSelection: sourceSegmentId });
  }

  async function materializeVideoSegment(sourceNodeId: string, segmentId: string) {
    const key = `${sourceNodeId}:${segmentId}`;
    const running = segmentMaterializationJobsRef.current.get(key);
    if (running) return running;
    const sourceNode = nodesRef.current.find((node) => node.id === sourceNodeId);
    const segment = sourceNode?.data.videoSegments?.find((item) => item.id === segmentId);
    if (!sourceNode || !segment) throw new Error("Video segment is no longer available");
    if (segment.clipAssetId && segment.clipUrl) return { id: segment.clipAssetId, url: segment.clipUrl, durationSeconds: segment.end - segment.start };
    const sourceAssetId = sourceNode.data.assetId || sourceNode.data.videoSourceAssetId;
    if (!sourceAssetId) throw new Error("Source video is not ready yet");

    const job = (async () => {
      const response = await fetch("/api/assets/segment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, assetId: sourceAssetId, start: segment.start, end: segment.end, segmentId }),
      });
      const body = (await response.json().catch(() => ({}))) as { asset?: { id: string; url: string; durationSeconds: number }; error?: string };
      if (!response.ok || !body.asset) throw new Error(body.error || "Could not prepare this video segment");
      const asset = body.asset;
      setNodes((current) => {
        const next = current.map((node) => {
          if (node.id === sourceNodeId) return {
            ...node,
            data: {
              ...node.data,
              videoSegments: node.data.videoSegments?.map((item) => item.id === segmentId ? { ...item, clipAssetId: asset.id, clipUrl: asset.url } : item),
            },
          };
          if (node.data.videoSourceNodeId === sourceNodeId && node.data.videoSegmentId === segmentId) return {
            ...node,
            data: {
              ...node.data,
              assetId: asset.id,
              imageUrl: asset.url,
              outputUrl: asset.url,
              videoClipStart: 0,
              videoClipEnd: asset.durationSeconds,
              duration: String(asset.durationSeconds),
              segmentMaterializing: false,
            },
          };
          if (node.data.kind === "videoMaster" && node.data.videoMasterClips?.some((clip) => clip.sourceNodeId === sourceNodeId && clip.sourceSegmentId === segmentId)) return {
            ...node,
            data: {
              ...node.data,
              videoMasterClips: node.data.videoMasterClips.map((clip) => clip.sourceNodeId === sourceNodeId && clip.sourceSegmentId === segmentId
                ? { ...clip, sourceClipAssetId: asset.id, sourceClipUrl: asset.url }
                : clip),
            },
          };
          return node;
        });
        nodesRef.current = next;
        return next;
      });
      setEdges((current) => {
        const next = current.map((edge) => edge.source === sourceNodeId && edge.data?.sourceSegmentId === segmentId
          ? { ...edge, data: { ...edge.data, clipAssetId: asset.id, clipUrl: asset.url } }
          : edge);
        edgesRef.current = next;
        return next;
      });
      return asset;
    })().catch((error) => {
      setNodes((current) => {
        const next = current.map((node) => node.data.videoSourceNodeId === sourceNodeId && node.data.videoSegmentId === segmentId
          ? { ...node, data: { ...node.data, segmentMaterializing: false, error: error instanceof Error ? error.message : "Could not prepare segment" } }
          : node);
        nodesRef.current = next;
        return next;
      });
      setNotice(error instanceof Error ? error.message : "Could not prepare this video segment");
      throw error;
    }).finally(() => segmentMaterializationJobsRef.current.delete(key));
    segmentMaterializationJobsRef.current.set(key, job);
    return job;
  }

  async function materializeVideoSegmentForGeneration(sourceNodeId: string, segmentId: string, requestedDuration: number) {
    const sourceNode = nodesRef.current.find((node) => node.id === sourceNodeId);
    const segment = sourceNode?.data.videoSegments?.find((item) => item.id === segmentId);
    if (!sourceNode || !segment) throw new Error("Video segment is no longer available");
    const segmentDuration = Math.max(.1, segment.end - segment.start);
    if (!Number.isFinite(requestedDuration) || requestedDuration >= segmentDuration - .01) {
      return materializeVideoSegment(sourceNodeId, segmentId);
    }
    const sourceAssetId = sourceNode.data.assetId || sourceNode.data.videoSourceAssetId;
    if (!sourceAssetId) throw new Error("Source video is not ready yet");
    const end = Math.min(segment.end, segment.start + Math.max(.1, requestedDuration));
    const response = await fetch("/api/assets/segment", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, assetId: sourceAssetId, start: segment.start, end, segmentId }),
    });
    const body = (await response.json().catch(() => ({}))) as { asset?: { id: string; url: string; durationSeconds: number }; error?: string };
    if (!response.ok || !body.asset) throw new Error(body.error || "Could not trim the source scene for generation");
    return body.asset;
  }

  async function downloadMasterMedia(nodeId: string, lane: VideoMasterDownloadLane, scope: "scene" | "video") {
    const master = nodesRef.current.find((node) => node.id === nodeId && node.data.kind === "videoMaster");
    const clips = [...(master?.data.videoMasterClips || [])].sort((left, right) => Number(left.sequenceIndex ?? 0) - Number(right.sequenceIndex ?? 0));
    const selected = clips.find((clip) => clip.id === master?.data.videoMasterSelectedClipId) || clips[0];
    const targets = scope === "video" ? clips : selected ? [selected] : [];
    if (!master || !targets.length) {
      setNotice("Choose a scene to download");
      return false;
    }

    setNotice(scope === "video" ? `Rendering full ${lane.toUpperCase()} video…` : `Preparing ${lane.toUpperCase()} scene…`);
    try {
      const assets = await Promise.all(targets.map(async (clip, index) => {
        const sourceNode = clip.sourceNodeId
          ? nodesRef.current.find((node) => node.id === clip.sourceNodeId)
          : undefined;
        const exportMedia = videoMasterClipExportMedia(clip, lane, sourceNode);
        let source = exportMedia.source;
        let start = exportMedia.start;
        let end = exportMedia.end;
        if (lane === "original" && clip.sourceNodeId && clip.sourceSegmentId && (scope === "scene" || !source)) {
          const materialized = await materializeVideoSegment(clip.sourceNodeId, clip.sourceSegmentId);
          source = { url: materialized.url, assetId: materialized.id };
          start = 0;
          end = materialized.durationSeconds;
        }
        const assetId = source?.assetId || assetIdFromAssetUrl(source?.url || "");
        if (!source?.url || !assetId) throw new Error(lane === "output"
          ? `Generate ${clip.title} before downloading its OUTPUT`
          : `${clip.title} has no ORIGINAL video`);
        const sceneNumber = Math.max(1, Number(clip.sequenceIndex ?? index) + 1);
        const cleanTitle = String(clip.title || `Scene ${sceneNumber}`).replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || `scene-${sceneNumber}`;
        return { id: assetId, url: source.url, start, end, name: `${String(sceneNumber).padStart(2, "0")}-${cleanTitle}-${lane}.mp4` };
      }));

      if (scope === "scene") {
        const anchor = document.createElement("a");
        anchor.href = assetDownloadUrl(assets[0].url);
        anchor.download = assets[0].name;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } else {
        const response = await fetch("/api/assets/export", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: project.id, filename: `video-master-${lane}`, assets: assets.map(({ id, start, end }) => ({ id, start, end })) }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || "Could not render the video export");
        }
        const exportUrl = URL.createObjectURL(await response.blob());
        const anchor = document.createElement("a");
        anchor.href = exportUrl;
        anchor.download = `video-master-${lane}.mp4`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(exportUrl), 1_000);
      }
      setNotice(scope === "video" ? `Full ${lane.toUpperCase()} video exported` : `${lane.toUpperCase()} scene downloaded`);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not export this video");
      return false;
    }
  }

  function extractVideoSegment(sourceNodeId: string, segment: VideoSceneSegment, clientX: number, clientY: number) {
    const sourceNode = nodesRef.current.find((node) => node.id === sourceNodeId);
    const sourceUrl = String(sourceNode?.data.outputUrl || sourceNode?.data.imageUrl || "");
    if (!sourceNode || !sourceUrl) return;
    const segmentDuration = Math.max(0.001, segment.end - segment.start);
    const ratio = Math.max(0.2, Number(sourceNode.data.videoAspectRatio || 9 / 16));
    const nodeWidth = ratio >= 1 ? 320 : 240;
    const id = uid("video-segment");
    const position = screenToFlowPosition({ x: clientX, y: clientY });
    const nextNode: FrameNode = {
      id,
      type: "frameNode",
      position: { x: position.x - nodeWidth / 2, y: position.y - Math.min(220, nodeWidth / ratio / 2) },
      selected: true,
      data: {
        kind: "scene",
        mediaType: "video",
        title: segment.label,
        subtitle: `${segment.start.toFixed(3)}s — ${segment.end.toFixed(3)}s`,
        imageUrl: segment.clipUrl || sourceUrl,
        outputUrl: segment.clipUrl || sourceUrl,
        assetId: segment.clipAssetId,
        role: segment.role,
        duration: String(segmentDuration),
        nodeWidth,
        videoAspectRatio: ratio,
        videoClipStart: segment.clipAssetId ? 0 : segment.start,
        videoClipEnd: segment.clipAssetId ? segmentDuration : segment.end,
        videoSourceNodeId: sourceNodeId,
        videoSegmentId: segment.id,
        videoSourceAssetId: sourceNode.data.assetId,
        segmentMaterializing: !segment.clipAssetId,
      },
    };
    pushHistory();
    const nextNodes = [...nodesRef.current.map((node) => node.selected ? { ...node, selected: false } : node), nextNode];
    nodesRef.current = nextNodes;
    setNodes(nextNodes);
    setSelectedId(id);
    setSidebarOpen(false);
    setNotice(`${segment.label} added as a video clip`);
    if (!segment.clipAssetId) void materializeVideoSegment(sourceNodeId, segment.id).catch(() => undefined);
  }

  async function captureVideoFrame(sourceNodeId: string, time: number) {
    const sourceNode = nodesRef.current.find((node) => node.id === sourceNodeId);
    const sourceUrl = String(sourceNode?.data.outputUrl || sourceNode?.data.imageUrl || "");
    const sourceAssetId = sourceNode?.data.assetId || assetIdFromAssetUrl(sourceUrl);
    if (!sourceNode || !sourceAssetId) {
      setNotice("Source video is no longer available");
      return;
    }
    setNotice("Capturing frame…");
    try {
      const response = await fetch("/api/assets/frame", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, assetId: sourceAssetId, time }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        asset?: { id: string; url: string; time: number; mimeType: "image/png" };
      };
      if (!response.ok || !body.asset) throw new Error(body.error || "Could not capture this video frame");

      const ratio = Math.max(.2, Number(sourceNode.data.videoAspectRatio || 9 / 16));
      const nodeWidth = ratio >= 1 ? 320 : 260;
      const sourceWidth = Number(sourceNode.measured?.width || sourceNode.width || sourceNode.data.nodeWidth || 580);
      const sourceHeight = Number(sourceNode.measured?.height || sourceNode.height || sourceNode.data.nodeHeight || 560);
      const priorCaptures = nodesRef.current.filter((node) => node.data.capturedFromNodeId === sourceNodeId).length;
      const captureHeight = nodeWidth / ratio + 76;
      const id = uid("scene");
      const nextNode: FrameNode = {
        id,
        type: "frameNode",
        position: {
          x: sourceNode.position.x + Math.max(0, (sourceWidth - nodeWidth) / 2) + (priorCaptures % 3) * (nodeWidth + 24),
          y: sourceNode.position.y + sourceHeight + 64 + Math.floor(priorCaptures / 3) * captureHeight,
        },
        selected: true,
        data: {
          kind: "scene",
          title: `Still · ${Math.floor(body.asset.time / 60)}:${(body.asset.time % 60).toFixed(3).padStart(6, "0")}`,
          subtitle: `Captured from ${sourceNode.data.title}`,
          role: "scene",
          assetId: body.asset.id,
          imageUrl: body.asset.url,
          mediaType: "image",
          canvasMediaOrigin: "capture",
          capturedFromNodeId: sourceNodeId,
          capturedAtSeconds: body.asset.time,
          nodeWidth,
          createdAt: new Date().toISOString(),
          status: "ready",
        },
      };
      pushHistory();
      const nextNodes = [...nodesRef.current.map((node) => node.selected ? { ...node, selected: false } : node), nextNode];
      nodesRef.current = nextNodes;
      setNodes(nextNodes);
      setSelectedId(id);
      setSidebarOpen(false);
      setNotice("Screenshot added below the video");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not capture this video frame");
    }
  }

  function updateSelected(data: Partial<FrameNode["data"]>) {
    if (selectedId) updateNode(selectedId, data);
  }

  function deleteCanvasNode(nodeId: string) {
    pushHistory();
    const nextNodes = nodesRef.current.filter((node) => node.id !== nodeId);
    const nextEdges = edgesRef.current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId);
    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
    setNodes(nextNodes);
    setEdges(nextEdges);
    if (selectedId === nodeId) setSelectedId(null);
    if (previewNode?.id === nodeId) setPreviewNode(null);
    setNotice("Node deleted");
  }

  async function refreshSourceStats(node: FrameNode) {
    if (!node.data.sourceUrl || refreshingStats) return;
    setRefreshingStats(true);
    const response = await fetch("/api/import/tiktok/stats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: node.data.sourceUrl, projectId: project.id }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      post?: { id: string | null; author: string; publishedAt: string | null; stats: NonNullable<FrameNode["data"]["postStats"]> };
    };
    setRefreshingStats(false);
    if (!response.ok || !body.post) {
      setNotice(body.error || "Could not refresh TikTok stats");
      return;
    }
    setNodes((current) => current.map((item) => item.id === node.id ? {
      ...item,
      data: { ...item.data, postId: body.post?.id || undefined, author: body.post?.author, publishedAt: body.post?.publishedAt || undefined, postStats: body.post?.stats },
    } : item));
    setHooks((current) => current.map((hook) => hook.projectId === project.id && hook.kind === "original" ? { ...hook, views: body.post!.stats.views } : hook));
    setNotice("TikTok stats updated");
  }

  async function copySourceLink(url: string) {
    await navigator.clipboard.writeText(url);
    setCopiedPostLink(true);
    window.setTimeout(() => setCopiedPostLink(false), 1600);
  }

  function incomingNodes(nodeId: string, graphNodes = nodes, graphEdges = edges) {
    const ids = graphEdges.filter((edge) => edge.target === nodeId).map((edge) => edge.source);
    return graphNodes.filter((node) => ids.includes(node.id));
  }

  function connectedTextInput(nodeId: string) {
    const edge = edgesRef.current.find((candidate) => candidate.target === nodeId && (candidate.targetHandle === "text-input" || candidate.data?.portType === "text"));
    if (!edge) return null;
    const source = nodesRef.current.find((node) => node.id === edge.source);
    const text = String(source?.data.assistantOutput || "").trim();
    return source && text ? { title: source.data.title || "Assistant", text } : null;
  }

  function effectiveGeneratorPrompt(nodeId: string, node?: FrameNode) {
    const generatorNode = node || nodesRef.current.find((candidate) => candidate.id === nodeId);
    const connectedPrompt = connectedTextInput(nodeId)?.text.trim() || "";
    const localPrompt = String(generatorNode?.data.prompt || "").trim();
    if (connectedPrompt && localPrompt && connectedPrompt !== localPrompt) {
      return `${connectedPrompt}\n\nAdditional user instructions:\n${localPrompt}`;
    }
    return connectedPrompt || localPrompt;
  }

  function nodeReferencePreviews(nodeId: string, masterClipId?: string) {
    const generatorNode = nodesRef.current.find((node) => node.id === nodeId);
    const masterClip = masterClipId
      ? generatorNode?.data.videoMasterClips?.find((clip) => clip.id === masterClipId)
      : undefined;
    const clipModelId = masterClip?.modelId;
    const inputEdges = normalizeEdgePorts(edgesRef.current, nodesRef.current).filter((edge) => edge.target === nodeId
      && edge.data?.portType !== "text"
      && edge.targetHandle !== "text-input"
      && edge.targetHandle !== "video-master-input"
      && (!masterClipId || edge.data?.masterClipId === masterClipId));
    const connected = inputEdges.flatMap((edge) => {
      const node = nodesRef.current.find((candidate) => candidate.id === edge.source);
      if (!node) return [];
      const ownsSelectedMasterSource = Boolean(masterClip
        && (masterClip.sourceNodeId || generatorNode?.data.videoMasterSourceNodeId) === node.id
        && (edge.data?.inputRole === "reference-video" || edge.data?.inputRole === "motion-video"));
      const authoritativeSegmentId = ownsSelectedMasterSource ? masterClip?.sourceSegmentId : edge.data?.sourceSegmentId;
      const sourceSegment = authoritativeSegmentId
        ? node.data.videoSegments?.find((segment) => segment.id === authoritativeSegmentId)
        : undefined;
      const sourceMediaUrl = String(node.data.outputUrl || node.data.imageUrl || "");
      const referenceDuration = ownsSelectedMasterSource
        ? videoMasterTimelineDuration(masterClip)
        : authoritativeSegmentId
          ? Math.max(0, Number(sourceSegment?.end ?? edge.data?.sourceSegmentEnd) - Number(sourceSegment?.start ?? edge.data?.sourceSegmentStart))
          : node.data.mediaType === "video" ? Number(node.data.duration || 0) : 0;
      const timelineThumbnailUrl = ownsSelectedMasterSource
        ? videoMasterClipThumbnail(masterClip, "original")
        : sourceSegment?.thumbnailUrl || edge.data?.sourceSegmentThumbnailUrl;
      const url = String(ownsSelectedMasterSource
        ? sourceSegment?.clipUrl || masterClip?.sourceClipUrl || sourceMediaUrl
        : sourceSegment?.clipUrl || edge.data?.clipUrl || sourceMediaUrl);
      const role = canonicalGeneratorRole(clipModelId || generatorNode?.data.modelId, edge.data?.inputRole || edge.targetHandle?.replace(/-input$/, ""));
      return url ? [{
        id: authoritativeSegmentId ? `${node.id}:${authoritativeSegmentId}` : node.id,
        edgeId: edge.id,
        url,
        thumbnailUrl: timelineThumbnailUrl,
        title: ownsSelectedMasterSource ? masterClip?.title || sourceSegment?.label || node.data.title : sourceSegment?.label || edge.data?.sourceSegmentLabel || node.data.title,
        assetId: ownsSelectedMasterSource
          ? sourceSegment?.clipAssetId || masterClip?.sourceClipAssetId || node.data.assetId
          : sourceSegment?.clipAssetId || edge.data?.clipAssetId || node.data.assetId,
        sourceNodeId: node.id,
        removable: true,
        personaId: node.data.personaId,
        variant: node.data.personaVariant,
        role,
        aspectRatio: Number(node.data.videoAspectRatio || 0) || undefined,
        durationSeconds: referenceDuration || undefined,
      }] : [];
    });
    const masterAttached = masterClipId
      ? generatorNode?.data.videoMasterClips?.find((clip) => clip.id === masterClipId)?.attachedReferences || []
      : generatorNode?.data.attachedReferences || [];
    const attached = masterAttached.map((reference) => ({
      id: `attached-${reference.assetId}`,
      edgeId: undefined,
      url: reference.url,
      thumbnailUrl: reference.thumbnailUrl,
      title: reference.title,
      assetId: reference.assetId,
      sourceNodeId: undefined,
      removable: true,
      personaId: reference.personaId,
      variant: reference.variant,
      role: canonicalGeneratorRole(clipModelId || generatorNode?.data.modelId, reference.role || "reference-image"),
      durationSeconds: reference.durationSeconds,
    }));
    const originalReference = masterClipOriginalReference(masterClip);
    const masterSourceNode = masterClip?.sourceNodeId
      ? nodesRef.current.find((node) => node.id === masterClip.sourceNodeId)
      : undefined;
    const masterSourceSegment = masterClip?.sourceSegmentId
      ? masterSourceNode?.data.videoSegments?.find((segment) => segment.id === masterClip.sourceSegmentId)
      : undefined;
    const exactOriginalReference = originalReference ? {
      ...originalReference,
      url: String(masterSourceSegment?.clipUrl || originalReference.url),
      assetId: masterSourceSegment?.clipAssetId || originalReference.assetId,
      thumbnailUrl: videoMasterClipThumbnail(masterClip, "original"),
      aspectRatio: Number(masterClip?.sourceAspectRatio || masterSourceNode?.data.videoAspectRatio || 0) || undefined,
    } : undefined;
    const explicitRoles = [...connected, ...attached].map((reference) => reference.role);
    const original = exactOriginalReference && shouldIncludeAutomaticMasterVideoReference(clipModelId || generatorNode?.data.modelId, explicitRoles) ? [{
      ...exactOriginalReference,
      edgeId: undefined,
      sourceNodeId: undefined,
      removable: true,
      personaId: undefined,
      variant: undefined,
    }] : [];
    const compatibleReferences = compatibleMasterReferences(clipModelId || generatorNode?.data.modelId, [...original, ...connected, ...attached]);
    return compatibleReferences.filter((reference, index, references) => references.findIndex((candidate) => {
      const candidateIdentity = candidate.edgeId || candidate.assetId || candidate.sourceNodeId || candidate.id;
      const referenceIdentity = reference.edgeId || reference.assetId || reference.sourceNodeId || reference.id;
      return candidateIdentity === referenceIdentity && candidate.role === reference.role;
    }) === index);
  }

  function disconnectReference(nodeId: string, sourceNodeId: string, edgeId?: string) {
    pushHistory();
    setEdges((current) => {
      const next = current.filter((edge) => edgeId ? edge.id !== edgeId : !(edge.target === nodeId && edge.source === sourceNodeId));
      edgesRef.current = next;
      return next;
    });
    setNotice("Reference disconnected");
  }

  function disconnectEdge(edgeId: string) {
    pushHistory();
    setEdges((current) => {
      const next = current.filter((edge) => edge.id !== edgeId);
      edgesRef.current = next;
      return next;
    });
    setNotice("Connection removed");
  }

  function downstreamGeneratorIds(nodeId: string) {
    const ordered: string[] = [];
    const queue = [nodeId];
    const visited = new Set<string>();
    while (queue.length) {
      const currentId = queue.shift()!;
      if (visited.has(currentId)) continue;
      visited.add(currentId);
      const currentNode = nodesRef.current.find((node) => node.id === currentId);
      if (currentNode?.data.kind === "prompt" || currentNode?.data.kind === "assistant") ordered.push(currentId);
      edgesRef.current.filter((edge) => edge.source === currentId).forEach((edge) => queue.push(edge.target));
    }
    return ordered;
  }

  function hasDownstreamGenerator(nodeId: string) {
    return downstreamGeneratorIds(nodeId).length > 1;
  }

  function generationReferenceEntries(nodeId: string, explicitMasterClipId?: string, preferPreparedGenerationMedia = false) {
    const generatorNode = nodesRef.current.find((node) => node.id === nodeId);
    if (!generatorNode) return [];
    const masterClipId = generatorNode.data.kind === "videoMaster" ? explicitMasterClipId || generatorNode.data.videoMasterGeneratingClipId : undefined;
    const masterClip = masterClipId ? generatorNode.data.videoMasterClips?.find((clip) => clip.id === masterClipId) : undefined;
    const masterModelId = masterClip?.modelId;
    const connected = edgesRef.current.filter((edge) => edge.target === nodeId
      && edge.data?.portType !== "text"
      && edge.targetHandle !== "text-input"
      && edge.targetHandle !== "video-master-input"
      && (!masterClipId || edge.data?.masterClipId === masterClipId))
      .flatMap((edge) => {
        const node = nodesRef.current.find((candidate) => candidate.id === edge.source);
        if (!node) return [];
        if (edge.data?.sourceSegmentId) {
          const isSceneSource = Boolean(masterClip
            && edge.source === masterClip.sourceNodeId
            && edge.data.sourceSegmentId === masterClip.sourceSegmentId);
          const assetId = preferPreparedGenerationMedia && isSceneSource
            ? edge.data.generationClipAssetId || edge.data.clipAssetId
            : edge.data.clipAssetId;
          return assetId ? [{
            assetId,
            title: edge.data.sourceSegmentLabel || "Video segment",
            role: canonicalGeneratorRole(masterModelId || generatorNode.data.modelId, edge.data?.inputRole || edge.targetHandle?.replace(/-input$/, "")),
            durationSeconds: preferPreparedGenerationMedia && isSceneSource && edge.data.generationClipDuration
              ? edge.data.generationClipDuration
              : Math.max(.1, Number(edge.data.sourceSegmentEnd) - Number(edge.data.sourceSegmentStart)),
            isSceneSource,
          }] : [];
        }
        return generatorSourceAssetIds(node)
          .map((assetId) => ({ assetId, title: node.data.title, role: canonicalGeneratorRole(masterModelId || generatorNode.data.modelId, edge.data?.inputRole || edge.targetHandle?.replace(/-input$/, "")), durationSeconds: node.data.mediaType === "video" ? Number(node.data.videoDurationSeconds || node.data.duration || 0) || undefined : undefined, isSceneSource: false }));
      });
    const masterAttached = masterClipId
      ? generatorNode.data.videoMasterClips?.find((clip) => clip.id === masterClipId)?.attachedReferences || []
      : generatorNode.data.attachedReferences || [];
    const attached = masterAttached.map((reference) => ({ assetId: reference.assetId, title: reference.title, role: canonicalGeneratorRole(masterModelId || generatorNode.data.modelId, reference.role || "reference-image"), durationSeconds: reference.durationSeconds, isSceneSource: false }));
    const originalReference = masterClipOriginalReference(masterClip);
    const explicitRoles = [...connected, ...attached].map((reference) => reference.role);
    const original = originalReference?.assetId && shouldIncludeAutomaticMasterVideoReference(masterModelId || generatorNode.data.modelId, explicitRoles)
      ? [{ assetId: originalReference.assetId, title: originalReference.title, role: originalReference.role, durationSeconds: originalReference.durationSeconds, isSceneSource: true }]
      : [];
    return compatibleMasterReferences(masterModelId || generatorNode.data.modelId, [...original, ...connected, ...attached])
      .filter((entry, index, entries) => entries.findIndex((candidate) => candidate.assetId === entry.assetId && candidate.role === entry.role) === index)
      .map((entry, index) => ({ ...entry, token: referenceMentionToken(entry.title, index) }));
  }

  async function ensureGeneratorSegmentReferences(nodeId: string, explicitMasterClipId?: string) {
    const generatorNode = nodesRef.current.find((node) => node.id === nodeId);
    const masterClipId = generatorNode?.data.kind === "videoMaster" ? explicitMasterClipId || generatorNode.data.videoMasterGeneratingClipId : undefined;
    const segmentEdges = edgesRef.current.filter((edge) => edge.target === nodeId && edge.data?.sourceSegmentId && (!masterClipId || edge.data?.masterClipId === masterClipId));
    if (!segmentEdges.length) return;
    await Promise.all(segmentEdges.map((edge) => materializeVideoSegment(edge.source, String(edge.data?.sourceSegmentId))));
  }

  function imageEditReferenceEntries(references: ImageEditReference[]) {
    return references.map((reference) => ({
      ...reference,
      token: editReferenceMentionToken(reference.title, reference.assetId),
      purpose: reference.origin === "identity" ? "identity" as const : reference.origin === "canvas" ? "canvas" as const : "upload" as const,
    }));
  }

  async function composeGeneratorPrompt(nodeId: string, brief: string) {
    const generatorNode = nodesRef.current.find((node) => node.id === nodeId);
    const selectedModel = models.find((model) => model.id === generatorNode?.data.modelId);
    await ensureGeneratorSegmentReferences(nodeId);
    const references = generationReferenceEntries(nodeId);
    const response = await fetch("/api/prompts/compose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        brief,
        assistantModelId: String(generatorNode?.data.textModelId || DEFAULT_ASSISTANT_MODEL_ID),
        references,
        mediaType: generatorNode?.data.mediaType || selectedModel?.mediaType || "image",
        modelId: selectedModel?.id || generatorNode?.data.modelId,
        modelLabel: selectedModel?.label,
        duration: selectedModel?.durationSource === "reference-video" ? undefined : generatorNode?.data.duration,
        generateAudio: generatorNode?.data.generateAudio ?? selectedModel?.defaultGenerateAudio ?? false,
      }),
    });
    const body = (await response.json().catch(() => ({}))) as { prompt?: string; error?: string; chargedCredits?: number };
    if (response.status === 402) setAccountView("access");
    if (!response.ok || !body.prompt) throw new Error(body.error || "Prompt assistant failed");
    if (body.chargedCredits) void refreshUsage();
    updateNode(nodeId, { prompt: body.prompt, status: "ready" });
    setNotice("Structured prompt inserted");
    return body.prompt;
  }

  async function composeMasterPrompt(nodeId: string, clipId: string, brief: string) {
    let master = nodesRef.current.find((node) => node.id === nodeId && node.data.kind === "videoMaster");
    let clip = master?.data.videoMasterClips?.find((item) => item.id === clipId);
    if (!master || !clip) throw new Error("This Video Master scene is no longer available");
    await ensureGeneratorSegmentReferences(nodeId, clipId);
    master = nodesRef.current.find((node) => node.id === nodeId && node.data.kind === "videoMaster") || master;
    clip = master.data.videoMasterClips?.find((item) => item.id === clipId) || clip;
    const references = generationReferenceEntries(nodeId, clipId);
    const sceneSourceTarget = resolveVideoMasterSourceTarget(nodesRef.current, nodeId, clipId);
    const connectedSceneSourceReference = sceneSourceTarget?.sourceAssetId
      ? references.find((reference) => reference.assetId === sceneSourceTarget.sourceAssetId && reference.role === "reference-video")
      : undefined;
    const sceneSourceToken = connectedSceneSourceReference?.token || referenceMentionToken(clip.title, references.length);
    const sceneReferences = nodeReferencePreviews(nodeId, clipId);
    const availableModels = videoMasterModelsForScene(models, clip, sceneReferences);
    const selectedModel = availableModels.find((model) => model.id === clip.modelId) || availableModels[0];
    if (!selectedModel) throw new Error("No video model is available for this scene");
    const generationDuration = videoMasterGenerationDuration(selectedModel, clip);
    const sourceRatio = videoMasterSourceRatio(clip, Number(master.data.videoAspectRatio));
    const supportedRatios = generatorRatiosFor(selectedModel, clip.resolution, sceneReferences.length > 0).filter((ratio) => ratio !== "source");
    const outputRatio = clip.aspectRatioMode === "custom" && clip.aspectRatio && supportedRatios.includes(clip.aspectRatio)
      ? clip.aspectRatio
      : nearestVideoMasterRatio(sourceRatio, supportedRatios);
    const sourceRatioLabel = nearestVideoMasterRatio(sourceRatio, ["1:1", "4:3", "3:4", "16:9", "9:16", "21:9", "9:21"]);
    const response = await fetch("/api/prompts/compose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        brief,
        assistantModelId: String(master.data.textModelId || DEFAULT_ASSISTANT_MODEL_ID),
        references,
        mediaType: "video",
        modelId: selectedModel.id,
        modelLabel: selectedModel.label,
        duration: String(generationDuration || ""),
        generateAudio: clip.generateAudio ?? selectedModel.defaultGenerateAudio ?? false,
        aspectRatio: outputRatio,
        sourceAspectRatio: sourceRatioLabel,
        outputSizeChanged: clip.aspectRatioMode === "custom" && outputRatio !== sourceRatioLabel,
        videoMasterContext: {
          nodeId,
          clipId: clip.id,
          clipTitle: clip.title,
          timelineDurationSeconds: videoMasterTimelineDuration(clip),
          generationDurationSeconds: generationDuration,
          sourceKind: clip.sourceNodeId && clip.sourceSegmentId ? "source-segment" : clip.origin === "upload" ? "uploaded-clip" : "new-scene",
          sourceAspectRatio: sourceRatioLabel,
          outputAspectRatio: outputRatio,
          outputRatioChanged: clip.aspectRatioMode === "custom" && outputRatio !== sourceRatioLabel,
          sourceAssetId: sceneSourceTarget?.sourceAssetId,
        },
        sceneSource: sceneSourceTarget?.sourceAssetId ? {
          assetId: sceneSourceTarget.sourceAssetId,
          token: sceneSourceToken,
          title: clip.title,
          durationSeconds: videoMasterTimelineDuration(clip),
        } : undefined,
      }),
    });
    const body = (await response.json().catch(() => ({}))) as { prompt?: string; error?: string; chargedCredits?: number };
    if (response.status === 402) setAccountView("access");
    if (!response.ok || !body.prompt) throw new Error(body.error || "Prompt assistant failed");
    const composedPrompt = body.prompt;
    if (body.chargedCredits) void refreshUsage();
    updateNode(nodeId, {
      prompt: composedPrompt,
      textModelId: String(master.data.textModelId || DEFAULT_ASSISTANT_MODEL_ID),
      videoMasterClips: (master.data.videoMasterClips || []).map((item) => item.id === clipId ? {
        ...item,
        prompt: composedPrompt,
        modelId: selectedModel.id,
        generationDuration,
        aspectRatio: outputRatio,
        sourceAspectRatio: sourceRatio,
      } : item),
      status: "ready",
    });
    setNotice("Scene prompt inserted");
    return composedPrompt;
  }

  async function composeImageEditPrompt(node: FrameNode, brief: string, options: ImageEditOptions, additionalReferences: ImageEditReference[]) {
    if (!node.data.assetId) throw new Error("This image is not available as an editable asset yet");
    const editReferences = imageEditReferenceEntries(additionalReferences);
    const response = await fetch("/api/prompts/compose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        brief: [
          "IMAGE EDIT MODE. The attached @EditSource is the exact current image to modify.",
          options.sourcePersonaName
            ? `SOURCE IDENTITY: @EditSource belongs to ${options.sourcePersonaName}${options.sourcePersonaVariant ? ` and represents the ${options.sourcePersonaVariant.toUpperCase()} state` : ""}. Do not confuse it with another identity or state.`
            : "SOURCE IDENTITY: No identity is assigned to @EditSource. Do not infer that a supporting identity reference is the source identity unless the user explicitly requests a replacement.",
          "Preserve everything the user did not explicitly ask to change. Do not redesign the whole image.",
          editReferences.length
            ? `ADDITIONAL NAMED REFERENCES:\n${editReferences.map((reference) => `- ${reference.token} — ${reference.title} (${reference.detail})`).join("\n")}\nUse them only for properties explicitly requested by the user; @EditSource remains the base image.`
            : "No additional edit references are attached.",
          `USER EDIT REQUEST: ${brief}`,
        ].join("\n"),
        mediaType: "image",
        editMode: true,
        modelId: options.modelId,
        modelLabel: models.find((model) => model.id === options.modelId)?.label,
        aspectRatio: options.aspectRatio,
        resolution: options.resolution,
        sourceAspectRatio: options.sourceAspectRatio,
        sourceDimensions: options.sourceWidth && options.sourceHeight ? `${options.sourceWidth}x${options.sourceHeight}` : undefined,
        outputSizeChanged: options.sizeMode === "custom",
        assistantModelId: DEFAULT_ASSISTANT_MODEL_ID,
        references: [
          { assetId: node.data.assetId, token: "@EditSource", title: "Current image", role: "reference-image", purpose: "edit-source" },
          ...editReferences.map((reference) => ({ assetId: reference.assetId, token: reference.token, title: reference.title, role: "reference-image", purpose: reference.purpose })),
        ],
      }),
    });
    const body = (await response.json().catch(() => ({}))) as { prompt?: string; error?: string; chargedCredits?: number };
    if (response.status === 402) setAccountView("access");
    if (!response.ok || !body.prompt) throw new Error(body.error || "Prompt assistant failed");
    if (body.chargedCredits) void refreshUsage();
    return body.prompt;
  }

  async function uploadImageEditReferences(files: File[]) {
    if (!files.length) return [];
    const body = await uploadMediaFiles(project.id, "edit-reference", files);
    if (!body.assets) throw new Error(body.error || "Could not upload edit references");
    return body.assets.map((asset, index): ImageEditReference => ({
      assetId: asset.id,
      url: asset.url,
      thumbnailUrl: assetThumbnailUrl(asset.url),
      title: asset.originalName || files[index]?.name || asset.filename,
      origin: "upload",
      detail: "Uploaded for this edit",
    }));
  }

  function persistImageEditReferences(nodeId: string, sourceAssetId: string, references: ImageEditReference[]) {
    if (!sourceAssetId) return;
    const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
    if (!node) return;
    const byAssetId = { ...(node.data.editReferencesByAssetId || {}) };
    if (references.length) byAssetId[sourceAssetId] = references.map((reference) => ({ ...reference }));
    else delete byAssetId[sourceAssetId];
    updateNode(nodeId, { editReferencesByAssetId: byAssetId });
  }

  async function runAssistant(nodeId: string) {
    const assistant = nodesRef.current.find((node) => node.id === nodeId && node.data.kind === "assistant");
    const instruction = String(assistant?.data.assistantInput || "").trim();
    if (!assistant || !instruction || runningAssistantNodeId) return false;
    const connectedText = connectedTextInput(nodeId)?.text || "";
    const imageAssetIds = generationReferenceEntries(nodeId).map((entry) => entry.assetId);
    setRunningAssistantNodeId(nodeId);
    updateNode(nodeId, { status: "working" });
    try {
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, instruction, connectedText, systemPrompt: assistant.data.systemPrompt || "", imageAssetIds, assistantModelId: String(assistant.data.textModelId || DEFAULT_ASSISTANT_MODEL_ID) }),
      });
      const body = (await response.json().catch(() => ({}))) as { output?: string; error?: string; chargedCredits?: number };
      if (response.status === 402) setAccountView("access");
      if (!response.ok || !body.output) throw new Error(body.error || "Assistant failed");
      if (body.chargedCredits) void refreshUsage();
      updateNode(nodeId, { assistantOutput: body.output, status: "ready" });
      setNotice("Assistant prompt ready");
      return true;
    } catch (error) {
      updateNode(nodeId, { status: "failed" });
      setNotice(error instanceof Error ? error.message : "Assistant failed");
      return false;
    } finally {
      setRunningAssistantNodeId(null);
    }
  }

  function draftPrompt() {
    if (!selectedNode) return;
    const incoming = incomingNodes(selectedNode.id);
    const scene = incoming.find((node) => node.data.kind === "scene");
    const persona = incoming.find((node) => node.data.kind === "persona");
    const role = scene?.data.role || "scene";
    const prompt = [
      `Create an original TikTok-native ${role} image in a believable candid phone-photo style.`,
      persona ? `Identity comes only from the connected ${persona.data.title} reference images; preserve face, hair, age and overall identity consistently.` : "Use a consistent original adult subject.",
      scene ? "Use the source frame only for broad composition rhythm and scene archetype. Do not copy its person, face, exact outfit, room, logo, text, watermark or exact pose." : "Use an imperfect handheld composition with natural autofocus and phone compression.",
      "Show a live moment with natural body language, ordinary lighting, realistic skin texture, a slightly imperfect crop, and no influencer polish.",
      "No TikTok UI, captions, app interface, watermark, readable logos, plastic skin, studio lighting, DSLR look, extra fingers or duplicated limbs.",
    ].join(" ");
    updateSelected({ prompt, subtitle: "Drafted from connected references", status: "ready" });
  }

  function createRemakeBranch(scene: FrameNode) {
    const promptId = uid("prompt");
    const prompt: FrameNode = {
      id: promptId,
      type: "frameNode",
      position: { x: scene.position.x + 340, y: scene.position.y + 55 },
      data: {
        kind: "prompt",
        title: `Remake · ${scene.data.title}`,
        subtitle: "Source screen connected · add an identity if needed",
        prompt: [
          `Create an original TikTok-native ${scene.data.role || "scene"} image based on the connected source screen's broad visual archetype and composition rhythm.`,
          "The source screen is a low-weight composition reference only. Do not copy its person, face, hair, body, exact clothes, text, logos, watermark, app UI, exact room, wall colors, props or exact pose.",
          "Create a genuinely new moment with a different setting, outfit, action and camera angle while preserving the screen's content function.",
          "Use believable handheld phone-camera behavior, natural autofocus, ordinary lighting, realistic skin texture, slight compression and an imperfect crop.",
          "No TikTok interface, captions, competitor branding, readable logos, plastic skin, studio polish, DSLR look, duplicated limbs or extra fingers.",
        ].join(" "),
        status: "ready",
      },
    };
    setNodes((current) => [...current, prompt]);
    setEdges((current) => [...current, { id: uid("edge"), source: scene.id, sourceHandle: "output", target: promptId, targetHandle: "reference-image-input", animated: true, data: { portType: "image", inputRole: "reference-image" } }]);
    setSelectedId(promptId);
    setNotice(`Remake branch created from ${scene.data.title}`);
  }

  async function runTikTokAutomation() {
    const source = tiktokAutomationSources.find((item) => item.id === selectedAutomationSourceId);
    const sourceNode = nodesRef.current.find((node) => node.id === source?.id);
    const persona = personas.find((item) => item.id === selectedAutomationPersonaId);
    const model = models.find((item) => item.id === selectedAutomationModelId);
    if (!source || !sourceNode || (automationMode === "identity" && !persona) || !model || generating) {
      setNotice(!source ? "Import a TikTok slideshow first" : automationMode === "identity" && !persona ? "Choose an identity" : !model ? "Choose an image model" : "Wait for the current generation to finish");
      return;
    }
    if (liveCreditUsage.usageMode === "metered" && automationEstimatedCredits > liveCreditUsage.remaining) {
      setAccountView("access");
      setNotice(`This automation needs about ${automationEstimatedCredits.toLocaleString("en-US")} credits. You have ${liveCreditUsage.remaining.toLocaleString("en-US")}.`);
      return;
    }

    setAutomationStatus("planning");
    setAutomationStage("analyze");
    setAutomationStageLabel("Reading every slide and its source role");
    setAutomationPlanningProgress(1);
    setAutomationPlan(null);
    setAutomationSlideStates([]);
    setNotice("TikTok automation is analyzing every slide");
    try {
      const response = await fetch("/api/automations/tiktok/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          sourceNodeId: source.id,
          sourceAssetIds: source.assetIds,
          personaId: automationMode === "identity" ? persona?.id : null,
          modelId: model.id,
          planningModelId: selectedAutomationPlanningModelId,
          caption: String(sourceNode.data.title || ""),
          preferences: {
            mode: automationMode,
            newOutfit: automationNewOutfit,
            newLocation: automationNewLocation,
            textStrategy: automationTextStrategy,
            creativeBrief: automationCreativeBrief,
          },
        }),
      });
      const queued = (await response.json().catch(() => ({}))) as { jobId?: string; error?: string };
      if (!response.ok || !queued.jobId) {
        if (response.status === 402) setAccountView("access");
        throw new Error(queued.error || "Could not queue the slideshow plan");
      }
      window.dispatchEvent(new Event("scenelith:tasks-changed"));

      let body: TikTokAutomationPlanResponse | null = null;
      for (let attempt = 0; attempt < 1_200; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        const poll = await fetch(`/api/automations/tiktok/plan?jobId=${encodeURIComponent(queued.jobId)}`, { cache: "no-store" });
        const job = (await poll.json().catch(() => ({}))) as TikTokAutomationJobResponse & { error?: string };
        if (!poll.ok) throw new Error(job.error || "Could not read automation progress");
        setAutomationStage(automationUiStage(job.stage));
        setAutomationPlanningProgress(job.progress);
        setAutomationStageLabel(job.status === "queued" && job.queuePosition
          ? `Waiting for a planning slot · ${job.queuePosition} in queue`
          : job.stageLabel || "Planning the slideshow");
        if (job.status === "failed" || job.status === "cancelled") {
          await refreshUsage();
          if (job.httpStatus === 402) setAccountView("access");
          throw new Error(job.error || "Could not build the slideshow plan");
        }
        if (job.status === "completed") {
          body = job.result;
          break;
        }
      }
      await refreshUsage();
      if (!body?.slides?.length) throw new Error("Automation planning timed out. You can safely try again.");
      if (automationMode === "identity") {
        if (!persona || !body.persona || body.persona.id !== persona.id) throw new Error(`Identity selection changed during planning. Expected ${persona?.name || "the selected identity"}, received ${body.persona?.name || "none"}.`);
        const selectedPersonaAssetIds = new Set(persona.assets.map((asset) => asset.id));
        const mismatchedReferenceIds = body.slides.flatMap((slide) => slide.personaAssetIds).filter((assetId) => !selectedPersonaAssetIds.has(assetId));
        if (mismatchedReferenceIds.length) throw new Error("The automation returned references from a different identity. Nothing was generated.");
      } else if (body.persona || body.slides.some((slide) => slide.personaAssetIds.length)) {
        throw new Error("Concept mode returned identity references. Nothing was generated.");
      }

      setAutomationPlan(body);
      setAutomationStatus("building");
      setAutomationStage("build");
      setAutomationStageLabel("Creating one reviewed canvas node per slide");

      const currentNodes = nodesRef.current;
      const currentEdges = edgesRef.current;
      const minX = currentNodes.length ? Math.min(...currentNodes.map((node) => node.position.x)) : 0;
      const bottom = currentNodes.length ? Math.max(...currentNodes.map((node) => node.position.y + Number(node.measured?.height || node.height || node.data.nodeHeight || 520))) : 0;
      const blockTop = bottom + 180;
      const noteId = uid("automation-note");
      const noteNode: FrameNode = {
        id: noteId,
        type: "frameNode",
        position: { x: minX, y: blockTop },
        data: {
          kind: "note",
          title: body.direction.campaignName,
          subtitle: `${body.analysis.format} · ${body.slides.length} slides`,
          noteColor: "gray",
          noteText: [
            body.direction.creativeThesis,
            `Hook: ${body.direction.rewrittenHook}`,
            `Comment angle: ${body.direction.commentAngle}`,
            `Ending: ${body.direction.endingInstruction}`,
          ].filter(Boolean).join("\n\n"),
          nodeWidth: 340,
          nodeHeight: 310,
          automationKind: "tiktok-slideshow",
          automationSourceNodeId: source.id,
        },
      };

      const responsePersonaAssets = body.persona?.assets || [];
      const created: Array<{ plan: TikTokAutomationPlanResponse["slides"][number]; node: FrameNode; sourceScene: FrameNode; references: typeof responsePersonaAssets }> = [];
      const createdEdges: FrameEdge[] = [];
      for (const [positionIndex, slide] of body.slides.entries()) {
        const sourceScene = currentNodes.find((node) => node.data.assetId === slide.sourceAssetId);
        if (!sourceScene) throw new Error(`Source slide ${slide.index} is missing from the canvas`);
        const personaAssetById = new Map(responsePersonaAssets.map((asset) => [asset.id, asset]));
        const references = slide.personaAssetIds.map((assetId) => personaAssetById.get(assetId)).filter((asset): asset is (typeof responsePersonaAssets)[number] => Boolean(asset));
        if (references.length !== slide.personaAssetIds.length) throw new Error(`Identity references for slide ${slide.index} changed while the automation was running`);
        const nodeId = uid("automation-slide");
        const column = positionIndex % 2;
        const row = Math.floor(positionIndex / 2);
        const node: FrameNode = {
          id: nodeId,
          type: "frameNode",
          position: { x: minX + 410 + column * 520, y: blockTop + row * 890 },
          data: {
            kind: "prompt",
            title: `Slide ${String(slide.index).padStart(2, "0")} · ${slide.role}`,
            subtitle: `${slide.personaVariant === "none" ? "Concept adaptation" : `${body.persona?.name || "Identity"} · ${slide.personaVariant}`} · QA ${slide.reviewPassed ? "passed" : "revised"}`,
            prompt: slide.prompt,
            status: "queued",
            queueReason: "plan",
            modelId: body.model.id,
            mediaType: "image",
            aspectRatio: body.model.defaultRatio as FrameNode["data"]["aspectRatio"],
            resolution: body.model.defaultResolution as FrameNode["data"]["resolution"],
            generationCount: 1,
            nodeWidth: 430,
            personaId: body.persona?.id,
            personaVariant: slide.personaVariant === "none" ? undefined : slide.personaVariant,
            attachedReferences: references.map((asset) => ({ assetId: asset.id, url: asset.url, title: `${body.persona?.name || "Identity"} · ${asset.filename}`, personaId: body.persona?.id, variant: asset.role })),
            automationKind: "tiktok-slideshow",
            automationSourceNodeId: source.id,
            automationSlideIndex: slide.index,
            automationRole: slide.role,
            automationOverlayText: slide.overlayText,
            automationReviewIssues: slide.reviewIssues,
            generationError: undefined,
          },
        };
        created.push({ plan: slide, node, sourceScene, references });
        createdEdges.push({
          id: uid("edge"),
          source: sourceScene.id,
          sourceHandle: "output",
          target: nodeId,
          targetHandle: "reference-image-input",
          animated: true,
          className: "is-automation-lineage-edge",
          data: {
            portType: "image",
            inputRole: "reference-image",
            automationKind: "tiktok-slideshow",
            automationSourceNodeId: source.id,
            automationSlideIndex: slide.index,
          },
        });
      }

      pushHistory();
      const nextNodes = [...currentNodes, noteNode, ...created.map((item) => item.node)];
      const nextEdges = [...currentEdges, ...createdEdges];
      nodesRef.current = nextNodes;
      edgesRef.current = nextEdges;
      setNodes(nextNodes);
      setEdges(nextEdges);
      setAutomationSlideStates(created.map(({ plan, node }) => ({ index: plan.index, role: plan.role, personaVariant: plan.personaVariant, status: "queued", nodeId: node.id })));
      if (!(await save(true))) throw new Error("Could not save the automation nodes before generation");
      setAutomationStatus("generating");
      setAutomationStage("generate");
      setAutomationStageLabel(`Generating ${created.length} adapted slides…`);
      setGenerating(true);
      setNotice(`${created.length} reviewed nodes created · generation started`);

      const setSlideStatus = (index: number, status: TikTokAutomationSlideState["status"]) => setAutomationSlideStates((current) => current.map((slide) => slide.index === index ? { ...slide, status } : slide));
      const runOne = async ({ plan: slide, node, sourceScene, references }: (typeof created)[number]) => {
        const nodeId = node.id;
        const setActive = (active: boolean) => setGeneratingNodeIds((current) => active
          ? current.includes(nodeId) ? current : [...current, nodeId]
          : current.filter((id) => id !== nodeId));
        const referenceAssetIds = [String(sourceScene.data.assetId), ...references.map((asset) => asset.id)];
        const referenceLabels = slide.referenceLabels;
        const referenceRoles = referenceAssetIds.map(() => "reference-image" as GeneratorInputRole);
        try {
          let generationId = "";
          while (!generationId) {
            const start = await fetch("/api/generate", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                projectId: project.id,
                nodeId,
                prompt: slide.prompt,
                modelId: body.model.id,
                referenceAssetIds,
                referenceLabels,
                referenceRoles,
                aspectRatio: body.model.defaultRatio,
                resolution: body.model.defaultResolution,
                duration: "5",
                generateAudio: false,
              }),
            });
            const started = (await start.json().catch(() => ({}))) as { error?: string; code?: string; generationId?: string; retryAfterMs?: number; status?: string };
            if (start.status === 429 && started.code === "GENERATION_CONCURRENCY_LIMIT") {
              setActive(false);
              setSlideStatus(slide.index, "queued");
              updateNode(nodeId, { status: "queued", queueReason: "plan" });
              await new Promise((resolve) => window.setTimeout(resolve, Math.max(1000, started.retryAfterMs || 3000)));
              continue;
            }
            await refreshUsage();
            if (!start.ok || !started.generationId) throw new Error(started.error || "Generation failed");
            generationId = started.generationId;
            window.dispatchEvent(new Event("scenelith:tasks-changed"));
            if (started.status === "queued") {
              setActive(false);
              setSlideStatus(slide.index, "queued");
              updateNode(nodeId, { status: "queued", queueReason: "provider" });
            } else {
              setActive(true);
              setSlideStatus(slide.index, "generating");
              updateNode(nodeId, { status: "working", queueReason: undefined });
            }
          }
          for (let attempt = 0; attempt < 920; attempt += 1) {
            await new Promise((resolve) => window.setTimeout(resolve, 3000));
            const poll = await fetch(`/api/generate/${generationId}`, { cache: "no-store" });
            const polled = (await poll.json().catch(() => ({}))) as { generation?: { status: string; outputUrl?: string; assetId?: string; mediaType?: "image" | "video"; modelId?: string; createdAt?: string; error?: string | null }; error?: string };
            const polledStatus = String(polled.generation?.status || "").toLowerCase();
            if (polledStatus === "queued" || polledStatus === "dispatching") {
              setActive(false);
              setSlideStatus(slide.index, "queued");
              updateNode(nodeId, { status: "queued", queueReason: "provider" });
              continue;
            }
            if (["failed", "fail", "error", "cancelled", "canceled"].includes(polledStatus) || polled.error) throw new Error(polled.error || polled.generation?.error || "Generation failed");
            if (polled.generation && !polled.generation.outputUrl) {
              setActive(true);
              setSlideStatus(slide.index, "generating");
              updateNode(nodeId, { status: "working", queueReason: undefined });
            }
            if (polled.generation?.outputUrl) {
              const output = { url: polled.generation.outputUrl, assetId: polled.generation.assetId, mediaType: "image" as const, modelId: polled.generation.modelId || body.model.id };
              updateNode(nodeId, {
                outputUrl: output.url,
                assetId: output.assetId,
                mediaType: "image",
                modelId: output.modelId,
                generatedAt: polled.generation.createdAt || new Date().toISOString(),
                generatedOutputs: [output],
                activeGeneratedOutputIndex: 0,
                status: "ready",
                queueReason: undefined,
                generationError: undefined,
              });
              setSlideStatus(slide.index, "ready");
              return;
            }
          }
          throw new Error("Generation did not complete in time");
        } catch (error) {
          updateNode(nodeId, { status: "failed", queueReason: undefined, generationError: error instanceof Error ? error.message : "Generation failed" });
          setSlideStatus(slide.index, "failed");
          throw error;
        } finally {
          setActive(false);
        }
      };

      const results = await settleWithConcurrency(created, Math.max(1, liveCreditUsage.generationConcurrency || 1), runOne);
      const completed = results.filter((result) => result.status === "fulfilled").length;
      const firstFailure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      setGenerating(false);
      setGeneratingNodeIds([]);
      await refreshUsage();
      if (completed === created.length) {
        setAutomationStatus("complete");
        setAutomationStageLabel(`${completed} slides recreated and ready`);
        setNotice(`TikTok recreation ready · ${completed} slides`);
      } else {
        setAutomationStatus("failed");
        setAutomationStageLabel(`${completed} of ${created.length} slides ready · failed slides can be rerun`);
        setNotice(firstFailure?.reason instanceof Error ? firstFailure.reason.message : `${completed} of ${created.length} slides ready`);
      }
    } catch (error) {
      setGenerating(false);
      setGeneratingNodeIds([]);
      await refreshUsage();
      setAutomationStatus("failed");
      setAutomationStageLabel(error instanceof Error ? error.message : "Automation failed");
      setNotice(error instanceof Error ? error.message : "Automation failed");
    }
  }

  async function generate(requestedNode?: FrameNode) {
    const requestedId = requestedNode?.id || selectedNode?.id;
    const generatorNode = nodesRef.current.find((node) => node.id === requestedId);
    const effectivePrompt = requestedId ? effectiveGeneratorPrompt(requestedId, generatorNode) : "";
    if (!generatorNode || !effectivePrompt || activeGenerationNodeIds.includes(generatorNode.id)) return;
    const modelId = generatorNode.data.modelId || "nano-banana-2";
    const model = models.find((item) => item.id === modelId);
    const generationCount = Math.min(MAX_GENERATION_BATCH, Math.max(1, Number(generatorNode.data.generationCount || 1)));
    const generationConcurrency = Math.max(1, liveCreditUsage.generationConcurrency || 1);
    try {
      await ensureGeneratorSegmentReferences(generatorNode.id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not prepare video references");
      return;
    }
    const dedupedReferenceEntries = generationReferenceEntries(generatorNode.id, undefined, true);
    const masterSourceTarget = generatorNode.data.kind === "videoMaster" && generatorNode.data.videoMasterGeneratingClipId
      ? resolveVideoMasterSourceTarget(nodesRef.current, generatorNode.id, generatorNode.data.videoMasterGeneratingClipId)
      : undefined;
    const preparedMasterSource = dedupedReferenceEntries.find((entry) => entry.isSceneSource && entry.role === "reference-video");
    const referenceAssetIds = dedupedReferenceEntries.map((entry) => entry.assetId);
    // Use the same flattened ordering as the @ mention menu. This keeps the
    // visible token, API array index and provider-side label in exact sync.
    const referenceLabels = dedupedReferenceEntries.map((entry) => entry.token);
    const referenceRoles = dedupedReferenceEntries.map((entry) => entry.role);
    const primaryAttachedIdentity = generatorNode.data.attachedReferences?.find((reference) => reference.personaId);
    const primaryConnectedIdentity = incomingNodes(generatorNode.id, nodesRef.current, edgesRef.current).find((node) => node.data.personaId);
    const generationPersonaId = generatorNode.data.personaId || primaryAttachedIdentity?.personaId || primaryConnectedIdentity?.data.personaId;
    const generationPersonaVariant = generatorNode.data.personaVariant || primaryAttachedIdentity?.variant || primaryConnectedIdentity?.data.personaVariant;
    const measuredWidth = Number(generatorNode.measured?.width || generatorNode.width || generatorNode.data.nodeWidth || 430);
    const [batchRatioWidth, batchRatioHeight] = String(generatorNode.data.aspectRatio || model?.defaultRatio || "4:5").split(":").map(Number);
    const batchRatio = Number.isFinite(batchRatioWidth / batchRatioHeight) ? batchRatioWidth / batchRatioHeight : 16 / 9;
    const measuredHeight = measuredWidth / Math.max(0.2, batchRatio) + 36;
    const batchNodeIds = [generatorNode.id, ...Array.from({ length: generationCount - 1 }, () => uid("prompt"))];
    const clonedNodes: FrameNode[] = batchNodeIds.slice(1).map((nodeId, index) => ({
      id: nodeId,
      type: "frameNode",
      position: {
        x: generatorNode.position.x + (measuredWidth + 64) * ((index + 1) % 4),
        y: generatorNode.position.y + (measuredHeight + 80) * Math.floor((index + 1) / 4),
      },
      data: {
        ...structuredClone(generatorNode.data),
        generationCount: 1,
        outputUrl: undefined,
        assetId: undefined,
        generatedOutputs: [],
        activeGeneratedOutputIndex: undefined,
        status: "queued",
        queueReason: "plan",
        generationError: undefined,
      },
    }));
    const incomingEdges = edgesRef.current.filter((edge) => edge.target === generatorNode.id);
    const clonedEdges: FrameEdge[] = batchNodeIds.slice(1).flatMap((nodeId) => incomingEdges.map((edge) => ({
      ...structuredClone(edge),
      id: uid("edge"),
      target: nodeId,
    })));
    pushHistory();
    const preparedNodes = nodesRef.current.map((node) => node.id === generatorNode.id ? {
      ...node,
      data: {
        ...node.data,
        generationCount: 1,
        status: "queued" as const,
        queueReason: "plan" as const,
        generationError: undefined,
        mediaType: model?.mediaType || "image",
      },
    } : node).concat(clonedNodes);
    const preparedEdges = [...edgesRef.current, ...clonedEdges];
    nodesRef.current = preparedNodes;
    edgesRef.current = preparedEdges;
    setNodes(preparedNodes);
    setEdges(preparedEdges);
    if (!(await save(true))) {
      setNotice("Could not save the generator nodes before starting");
      return false;
    }
    setGenerating(true);
    setNotice(generationCount === 1
      ? "Generation started"
      : `${generationCount} generator nodes created · ${Math.min(generationCount, generationConcurrency)} running at a time`);
    const runOne = async (nodeId: string) => {
      const setActive = (active: boolean) => setGeneratingNodeIds((current) => active
        ? current.includes(nodeId) ? current : [...current, nodeId]
        : current.filter((id) => id !== nodeId));
      try {
        let generationId = "";
        while (!generationId) {
          const response = await fetch("/api/generate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              projectId: project.id,
              nodeId,
              prompt: effectivePrompt,
              modelId,
              referenceAssetIds,
              referenceLabels,
              referenceRoles,
              aspectRatio: generatorNode.data.aspectRatio || "4:5",
              resolution: generatorNode.data.resolution || "1K",
              // Motion Control has no provider duration parameter. Its length
              // comes exclusively from the already-trimmed driving video.
              ...(model?.durationSource === "reference-video" ? {} : { duration: generatorNode.data.duration || "5" }),
              generateAudio: generatorNode.data.generateAudio ?? model?.defaultGenerateAudio ?? false,
              targetClipId: generatorNode.data.kind === "videoMaster" ? generatorNode.data.videoMasterGeneratingClipId : undefined,
              targetSourceAssetId: preparedMasterSource?.assetId || masterSourceTarget?.sourceAssetId,
            }),
          });
          const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string; generationId?: string; retryAfterMs?: number; status?: string };
          if (response.status === 429 && body.code === "GENERATION_CONCURRENCY_LIMIT") {
            setActive(false);
            updateNode(nodeId, { status: "queued", queueReason: "plan" });
            await new Promise((resolve) => window.setTimeout(resolve, Math.max(1000, body.retryAfterMs || 3000)));
            continue;
          }
          await refreshUsage();
          if (!response.ok || !body.generationId) throw new Error(body.error || "Generation failed");
          generationId = body.generationId;
          window.dispatchEvent(new Event("scenelith:tasks-changed"));
          if (body.status === "queued") {
            setActive(false);
            updateNode(nodeId, { status: "queued", queueReason: "provider" });
          } else {
            setActive(true);
            updateNode(nodeId, { status: "working", queueReason: undefined });
          }
        }
        // The API owns the provider timeout (5 minutes for images, 45 for
        // videos). Keep polling until it returns a terminal state so a slow
        // provider cannot leave the node and its credit reservation orphaned.
        for (let attempt = 0; attempt < 920; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 3000));
          const poll = await fetch(`/api/generate/${generationId}`, { cache: "no-store" });
          const pollBody = (await poll.json().catch(() => ({}))) as { generation?: { status: string; outputUrl?: string; assetId?: string; mediaType?: "image" | "video"; modelId?: string; createdAt?: string; durationSeconds?: number; queuePosition?: number | null; error?: string | null }; error?: string };
          const polledStatus = String(pollBody.generation?.status || "").toLowerCase();
          if (polledStatus === "queued" || polledStatus === "dispatching") {
            setActive(false);
            updateNode(nodeId, { status: "queued", queueReason: "provider" });
            continue;
          }
          if (["failed", "fail", "error", "cancelled", "canceled"].includes(polledStatus) || pollBody.error) {
            throw new Error(pollBody.error || pollBody.generation?.error || "Generation failed");
          }
          if (pollBody.generation && !pollBody.generation.outputUrl) {
            setActive(true);
            updateNode(nodeId, { status: "working", queueReason: undefined });
          }
          if (pollBody.generation?.outputUrl) {
            const output = {
              url: pollBody.generation.outputUrl,
              assetId: pollBody.generation.assetId,
              mediaType: pollBody.generation.mediaType || model?.mediaType || "image" as const,
              modelId: pollBody.generation.modelId || modelId,
            };
            const latestNode = nodesRef.current.find((node) => node.id === nodeId) || generatorNode;
            const masterClipId = latestNode.data.kind === "videoMaster" ? latestNode.data.videoMasterGeneratingClipId : undefined;
            const targetMasterClip = masterClipId
              ? latestNode.data.videoMasterClips?.find((clip) => clip.id === masterClipId)
              : undefined;
            const generatedDuration = output.mediaType === "video"
              ? Number(pollBody.generation.durationSeconds || 0) > 0
                ? Number(pollBody.generation.durationSeconds)
                : targetMasterClip
                  ? videoMasterTimelineDuration(targetMasterClip)
                  : Math.max(.1, Number(latestNode.data.duration || 0)) || undefined
              : undefined;
            const nextMasterClips = masterClipId ? latestNode.data.videoMasterClips?.map((clip) => {
              if (clip.id !== masterClipId) return clip;
              const clipOutput = { url: output.url, assetId: output.assetId, modelId: output.modelId, durationSeconds: generatedDuration };
              const history = [...(clip.generatedOutputs || []), clipOutput]
                .filter((item, index, items) => items.findIndex((candidate) => candidate.url === item.url) === index)
                .slice(-20);
              return {
                ...clip,
                origin: "generated" as const,
                outputUrl: output.url,
                outputAssetId: output.assetId,
                generatedDuration,
                generatedOutputs: history,
                modelId: output.modelId,
              };
            }) : latestNode.data.videoMasterClips;
            const previousOutput = latestNode.data.outputUrl ? [{
              url: latestNode.data.outputUrl,
              assetId: latestNode.data.assetId,
              mediaType: latestNode.data.mediaType || model?.mediaType || "image" as const,
              modelId: latestNode.data.modelId || modelId,
            }] : [];
            const outputHistory = [...(latestNode.data.generatedOutputs || []), ...previousOutput, output]
              .filter((item, index, items) => items.findIndex((candidate) => candidate.url === item.url) === index)
              .slice(-20);
            const activeOutputIndex = outputHistory.findIndex((item) => item.url === output.url);
            updateNode(nodeId, {
              outputUrl: output.url,
              assetId: output.assetId,
              mediaType: output.mediaType,
              modelId: output.modelId,
              generatedAt: pollBody.generation.createdAt || new Date().toISOString(),
              generatedOutputs: outputHistory,
              activeGeneratedOutputIndex: activeOutputIndex >= 0 ? activeOutputIndex : outputHistory.length - 1,
              personaId: generationPersonaId,
              personaVariant: generationPersonaVariant,
              status: "ready",
              queueReason: undefined,
              generationError: undefined,
              videoMasterClips: nextMasterClips,
              videoMasterGeneratingClipId: undefined,
            });
            const replacementFor = generatorNode.data.replacementFor;
            if (replacementFor && output.mediaType === "video" && output.assetId) {
              const sourceNode = nodesRef.current.find((node) => node.id === replacementFor.sourceNodeId);
              if (sourceNode?.data.videoSegments) updateNode(replacementFor.sourceNodeId, {
                videoSegments: sourceNode.data.videoSegments.map((segment) => segment.id === replacementFor.segmentId
                  ? { ...segment, replacementAssetId: output.assetId, replacementUrl: output.url }
                  : segment),
              });
            }
            // A provider success is not durable until the generated clip has
            // been written into the graph. Do not leave this to the regular
            // delayed autosave: an immediate reload must keep OUTPUT intact.
            if (latestNode.data.kind === "videoMaster" && !(await save(true, true))) {
              throw new Error("Video generated, but the canvas could not be saved");
            }
            return;
          }
        }
        throw new Error("Generation did not complete in time");
      } catch (error) {
        updateNode(nodeId, {
          status: "failed",
          queueReason: undefined,
          generationError: error instanceof Error ? error.message : "Generation failed",
          ...(generatorNode.data.kind === "videoMaster" ? { videoMasterGeneratingClipId: generatorNode.data.videoMasterGeneratingClipId } : {}),
        });
        throw error;
      } finally {
        setActive(false);
      }
    };
    const results = await settleWithConcurrency(batchNodeIds, generationConcurrency, runOne);
    const completed = results.filter((result) => result.status === "fulfilled").length;
    setGenerating(false);
    setGeneratingNodeIds([]);
    await refreshUsage();
    const firstFailure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    setNotice(completed === generationCount ? `${completed} version${completed === 1 ? "" : "s"} ready in separate nodes` : completed > 0 ? `${completed} of ${generationCount} versions ready` : firstFailure?.reason instanceof Error ? firstFailure.reason.message : "Generation failed");
    return completed > 0;
  }

  async function editImageInPlace(
    sourceNode: FrameNode,
    prompt: string,
    options: ImageEditOptions,
    additionalReferences: ImageEditReference[],
    onPhase?: (phase: "preparing" | "queued" | "generating") => void,
  ) {
    if (generating || activeGenerationNodeIds.includes(sourceNode.id)) throw new Error("This node already has a generation in progress");
    const currentNode = nodesRef.current.find((node) => node.id === sourceNode.id) || sourceNode;
    const sourceUrl = String(currentNode.data.outputUrl || currentNode.data.imageUrl || "");
    const sourceAssetId = currentNode.data.assetId;
    if (!sourceAssetId || !sourceUrl) throw new Error("This image is not available as an editable asset yet");
    const requestedModel = models.find((model) => model.id === options.modelId);
    const currentModel = models.find((model) => model.id === currentNode.data.modelId);
    const editModel = requestedModel?.mediaType === "image" && requestedModel.maxReferences > 0
      ? requestedModel
      : currentModel?.mediaType === "image" && currentModel.maxReferences > 0
        ? currentModel
      : models.find((model) => model.id === "nano-banana-2") || models.find((model) => model.mediaType === "image" && model.maxReferences > 0);
    if (!editModel) throw new Error("No image editing model is available");
    const editReferences = imageEditReferenceEntries(additionalReferences);
    const maxAdditionalReferences = Math.max(0, editModel.maxReferences - 1);
    if (editReferences.length > maxAdditionalReferences) {
      throw new Error(`${editModel.label} accepts ${maxAdditionalReferences} additional edit reference${maxAdditionalReferences === 1 ? "" : "s"}`);
    }
    const resolution = editModel.resolutions?.includes(options.resolution)
      ? options.resolution
      : editModel.defaultResolution || editModel.resolutions?.[0] || "1K";
    const allowedRatios = generatorRatiosFor(editModel, resolution, true);
    const requestedRatio = options.aspectRatio;
    const aspectRatio = allowedRatios.includes(requestedRatio)
      ? requestedRatio
      : allowedRatios.includes(editModel.defaultRatio || "") ? editModel.defaultRatio! : allowedRatios[0] || "4:5";
    const effectiveEditPrompt = prompt.includes("IMAGE EDIT MODE")
      ? prompt
      : [
          "IMAGE EDIT MODE. Modify the provided @EditSource image in place.",
          "Preserve every element the user did not explicitly ask to change. Do not redesign or recompose the whole image.",
          options.sizeMode === "custom" ? `Reframe the output to ${aspectRatio}; the source was ${options.sourceAspectRatio || "a different aspect ratio"}.` : "Keep the source framing and aspect ratio.",
          options.sourcePersonaName
            ? `SOURCE IDENTITY: @EditSource belongs to ${options.sourcePersonaName}${options.sourcePersonaVariant ? ` in the ${options.sourcePersonaVariant.toUpperCase()} state` : ""}. Keep that ownership distinct from supporting identities.`
            : "SOURCE IDENTITY: @EditSource has no assigned identity. Do not silently assign a supporting identity to it.",
          editReferences.length
            ? `ADDITIONAL EDIT REFERENCES: ${editReferences.map((reference) => `${reference.token} — ${reference.title} (${reference.detail})`).join("; ")}. Use only the properties named in the edit request; do not replace the base composition with these references.`
            : "No additional edit references are attached.",
          `USER EDIT REQUEST: ${prompt}`,
        ].join("\n");
    const setActive = (active: boolean) => setGeneratingNodeIds((current) => active
      ? current.includes(currentNode.id) ? current : [...current, currentNode.id]
      : current.filter((id) => id !== currentNode.id));

    pushHistory();
    updateNode(currentNode.id, {
      status: "queued",
      queueReason: "plan",
      generationError: undefined,
    });
    setGenerating(true);
    onPhase?.("preparing");
    setNotice("Preparing image edit…");
    if (!(await save(true))) {
      setGenerating(false);
      throw new Error("Could not save this node before starting the edit");
    }

    try {
      let generationId = "";
      while (!generationId) {
        const response = await fetch("/api/generate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: project.id,
            nodeId: currentNode.id,
            prompt: effectiveEditPrompt,
            modelId: editModel.id,
            referenceAssetIds: [sourceAssetId, ...editReferences.map((reference) => reference.assetId)],
            referenceLabels: ["@EditSource", ...editReferences.map((reference) => reference.token)],
            referenceRoles: Array.from({ length: editReferences.length + 1 }, () => "reference-image"),
            aspectRatio,
            resolution,
            duration: editModel.defaultDuration || editModel.durations?.[0] || "5",
            generateAudio: false,
            operation: "edit",
          }),
        });
        const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string; generationId?: string; retryAfterMs?: number; status?: string };
        if (response.status === 429 && body.code === "GENERATION_CONCURRENCY_LIMIT") {
          setActive(false);
          updateNode(currentNode.id, { status: "queued", queueReason: "plan" });
          onPhase?.("queued");
          await new Promise((resolve) => window.setTimeout(resolve, Math.max(1000, body.retryAfterMs || 3000)));
          continue;
        }
        await refreshUsage();
        if (!response.ok || !body.generationId) throw new Error(body.error || "Image edit failed");
        generationId = body.generationId;
        window.dispatchEvent(new Event("scenelith:tasks-changed"));
        updateNode(currentNode.id, { status: "queued", queueReason: "provider" });
        onPhase?.("queued");
      }

      for (let attempt = 0; attempt < 110; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 3000));
        const poll = await fetch(`/api/generate/${generationId}`, { cache: "no-store" });
        const pollBody = (await poll.json().catch(() => ({}))) as { generation?: { status: string; outputUrl?: string; assetId?: string; mediaType?: "image" | "video"; modelId?: string; createdAt?: string; error?: string | null }; error?: string };
        const status = String(pollBody.generation?.status || "").toLowerCase();
        if (status === "queued" || status === "dispatching") {
          setActive(false);
          updateNode(currentNode.id, { status: "queued", queueReason: "provider" });
          onPhase?.("queued");
          continue;
        }
        if (["failed", "fail", "error", "cancelled", "canceled"].includes(status) || pollBody.error) {
          throw new Error(pollBody.error || pollBody.generation?.error || "Image edit failed");
        }
        if (pollBody.generation && !pollBody.generation.outputUrl) {
          setActive(true);
          updateNode(currentNode.id, { status: "working", queueReason: undefined });
          onPhase?.("generating");
        }
        if (pollBody.generation?.outputUrl) {
          const output = {
            url: pollBody.generation.outputUrl,
            assetId: pollBody.generation.assetId,
            mediaType: "image" as const,
            modelId: pollBody.generation.modelId || editModel.id,
          };
          const latestNode = nodesRef.current.find((node) => node.id === currentNode.id) || currentNode;
          const previousOutput = { url: sourceUrl, assetId: sourceAssetId, mediaType: "image" as const, modelId: currentNode.data.modelId };
          const outputHistory = [...(latestNode.data.generatedOutputs || []), previousOutput, output]
            .filter((item, index, items) => items.findIndex((candidate) => candidate.url === item.url) === index)
            .slice(-20);
          const currentAspectRatio = String(currentNode.data.aspectRatio || currentModel?.defaultRatio || "4:5");
          const preservedAspectRatio = /^\d+:\d+$/.test(currentAspectRatio) ? currentAspectRatio : "16:9";
          const nextData: Partial<FrameNode["data"]> = {
            prompt: effectiveEditPrompt,
            subtitle: "Image edited in place",
            outputUrl: output.url,
            assetId: output.assetId,
            mediaType: "image",
            modelId: output.modelId,
            aspectRatio: (options.sizeMode === "custom" ? aspectRatio : preservedAspectRatio) as FrameNode["data"]["aspectRatio"],
            ratioMode: options.sizeMode === "custom" ? "custom" : currentNode.data.ratioMode,
            resolution: resolution as FrameNode["data"]["resolution"],
            generatedAt: pollBody.generation.createdAt || new Date().toISOString(),
            generatedOutputs: outputHistory,
            activeGeneratedOutputIndex: outputHistory.length - 1,
            editReferencesByAssetId: {
              ...(latestNode.data.editReferencesByAssetId || {}),
              [sourceAssetId]: additionalReferences.map((reference) => ({ ...reference })),
              ...(output.assetId ? { [output.assetId]: additionalReferences.map((reference) => ({ ...reference })) } : {}),
            },
            status: "ready",
            queueReason: undefined,
            generationError: undefined,
          };
          updateNode(currentNode.id, nextData);
          setPreviewNode((preview) => preview?.id === currentNode.id
            ? { ...preview, data: { ...preview.data, ...nextData } }
            : preview);
          setNotice("Edited image ready in the same node");
          return output;
        }
      }
      throw new Error("Image edit did not complete in time");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Image edit failed";
      updateNode(currentNode.id, { status: "failed", queueReason: undefined, generationError: message });
      setNotice(message);
      throw error;
    } finally {
      setActive(false);
      setGenerating(false);
      await refreshUsage();
    }
  }

  async function generateChain(nodeId: string) {
    const chain = downstreamGeneratorIds(nodeId);
    if (!chain.length) return;
    setNotice(`Running ${chain.length} connected generator${chain.length === 1 ? "" : "s"}…`);
    for (const currentId of chain) {
      const currentNode = nodesRef.current.find((node) => node.id === currentId);
      if (currentNode?.data.kind === "assistant") {
        const completed = await runAssistant(currentId);
        if (!completed) return;
        continue;
      }
      const effectivePrompt = effectiveGeneratorPrompt(currentId, currentNode);
      if (!effectivePrompt) { setNotice(`Chain stopped · ${currentNode?.data.title || "next generator"} needs a prompt`); return; }
      const completed = await generate(currentNode);
      if (!completed) return;
    }
    setNotice(`Chain complete · ${chain.length} generator${chain.length === 1 ? "" : "s"}`);
  }

  const nodeColor = useCallback((node: FrameNode) => automationFocusNodeIds.has(node.id) ? "#9de2c9" : ({
    source: "#d4a84f",
    scene: "#5f5f64",
    persona: "#72ddb7",
    hook: "#9a858d",
    prompt: node.data.mediaType === "video" ? "#63c6df" : "#d7aa4f",
    assistant: "#c89bea",
    generation: "#72ddb7",
    videoMaster: "#72ddb7",
    note: "#777773",
  }[node.data.kind]), [automationFocusNodeIds]);
  const savedHooks = hooks.filter((item) => item.kind !== "generated");
  const libraryProjects = projects.filter((item) => item.workspaceId === workspace.id);
  const visibleHooks = savedHooks.filter((item) => {
    const variants = hooks.filter((candidate) => candidate.kind === "generated" && candidate.parentHookId === item.id);
    if (hookFilter === "generated" && variants.length === 0) return false;
    if (hookFilter !== "all" && hookFilter !== "generated" && item.kind !== hookFilter) return false;
    return `${item.text} ${item.angle} ${variants.map((variant) => `${variant.text} ${variant.angle}`).join(" ")}`.toLowerCase().includes(hookSearch.trim().toLowerCase());
  });
  const inspectorSourceHook = selectedNode?.data.kind === "source" ? hooks.find((item) => item.id === selectedNode.data.hookId) || hooks.find((item) => item.kind === "original" && item.projectId === project.id && ((item.sourceUrl && item.sourceUrl === selectedNode.data.sourceUrl) || (item.text.trim() === String(selectedNode.data.hookText || "").trim()))) : null;
  const inspectorGeneratedHooks = inspectorSourceHook ? hooks.filter((item) => item.kind === "generated" && item.parentHookId === inspectorSourceHook.id) : [];
  const inspectorGeneratedIndex = inspectorSourceHook ? Math.min(inspectorGeneratedHooks.length - 1, selectedVariantByHook[inspectorSourceHook.id] || 0) : -1;
  const inspectorGeneratedHook = inspectorGeneratedHooks[inspectorGeneratedIndex];
  const previewUrl = previewMedia?.url || (previewNode ? String(previewNode.data.outputUrl || previewNode.data.imageUrl || "") : "");
  const previewReferences = previewNode ? nodeReferencePreviews(previewNode.id) : [];
  const previewPersonaReference = previewReferences.find((reference) => reference.personaId);
  const previewPersona = previewNode?.data.personaId
    ? personas.find((persona) => persona.id === previewNode.data.personaId)
    : previewPersonaReference
      ? personas.find((persona) => persona.id === previewPersonaReference.personaId)
      : undefined;
  const previewPersonaVariant = previewNode?.data.personaVariant
    || previewPersonaReference?.variant
    || (/\bbefore\b/i.test(String(previewNode?.data.title || "")) ? "before" as const
      : /\bafter\b/i.test(String(previewNode?.data.title || "")) ? "after" as const
        : undefined);
  const previewEditReferences: ImageEditReference[] = previewNode?.data.assetId
    ? (previewNode.data.editReferencesByAssetId?.[previewNode.data.assetId] || []).map((reference) => ({ ...reference }))
    : [];
  const editCanvasReferences: ImageEditReference[] = previewNode ? nodes
    .filter((node) => node.id !== previewNode.id
      && node.data.kind !== "persona"
      && node.data.mediaType !== "video"
      && Boolean(node.data.assetId)
      && Boolean(node.data.outputUrl || node.data.imageUrl))
    .map((node, index) => {
      const url = String(node.data.outputUrl || node.data.imageUrl || "");
      const rawTitle = String(node.data.title || "").trim();
      return {
        assetId: String(node.data.assetId),
        url,
        thumbnailUrl: assetThumbnailUrl(url),
        title: !rawTitle || rawTitle === "Image Generator" ? `Canvas image ${String(index + 1).padStart(2, "0")}` : rawTitle,
        origin: "canvas" as const,
        detail: node.data.generatedAt ? "Generated on this canvas" : "Image from this canvas",
      };
    })
    .filter((reference, index, all) => all.findIndex((item) => item.assetId === reference.assetId) === index)
    : [];
  const videoEditorReferenceLibrary: VideoEditorReference[] = previewNode?.data.kind === "videoMaster" ? [
    ...nodes
      .filter((node) => node.id !== previewNode.id
        && node.data.kind !== "persona"
        && Boolean(node.data.assetId)
        && Boolean(node.data.outputUrl || node.data.imageUrl))
      .map((node, index) => {
        const url = String(node.data.outputUrl || node.data.imageUrl || "");
        const title = String(node.data.title || "").trim() || `Canvas reference ${String(index + 1).padStart(2, "0")}`;
        return {
          id: `canvas-${node.id}`,
          sourceNodeId: node.id,
          assetId: String(node.data.assetId),
          url,
          thumbnailUrl: node.data.mediaType === "video"
            ? node.data.videoSegments?.[0]?.thumbnailUrl || assetThumbnailUrl(url)
            : assetThumbnailUrl(url),
          title,
          removable: true,
          mediaType: node.data.mediaType === "video" ? "video" as const : "image" as const,
          durationSeconds: node.data.mediaType === "video" ? Number(node.data.videoDurationSeconds || node.data.duration || 0) || undefined : undefined,
        };
      }),
    ...personas.flatMap((persona) => persona.assets.map((asset, index) => ({
      id: `identity-${persona.id}-${asset.id}`,
      assetId: asset.id,
      url: asset.url,
      thumbnailUrl: asset.thumbnailUrl || assetThumbnailUrl(asset.url),
      title: `${persona.name} · ${asset.role} ${String(index + 1).padStart(2, "0")}`,
      removable: true,
      mediaType: "image" as const,
    }))),
  ]
    .filter((reference, index, all) => all.findIndex((item) => item.assetId === reference.assetId) === index)
    : [];
  const editPersonas: ImageEditPersona[] = personas.map((persona) => ({
    id: persona.id,
    name: persona.name,
    avatarUrl: persona.avatarUrl,
    references: persona.assets.map((asset) => {
      const siblings = persona.assets.filter((item) => item.role === asset.role);
      const roleIndex = siblings.findIndex((item) => item.id === asset.id) + 1;
      const roleLabel = asset.role === "before" ? "Before" : asset.role === "after" ? "After" : "Identity";
      return {
        assetId: asset.id,
        url: asset.url,
        thumbnailUrl: asset.thumbnailUrl || assetThumbnailUrl(asset.url),
        title: `${persona.name} · ${roleLabel} ${String(roleIndex).padStart(2, "0")}`,
        origin: "identity" as const,
        detail: asset.role === "reference" ? "Identity reference" : `${roleLabel} state reference`,
        personaId: persona.id,
        variant: asset.role,
      };
    }),
  }));
  const inspectorGeneratorReferences = selectedNode?.data.kind === "prompt" ? nodeReferencePreviews(selectedNode.id) : [];
  const inspectorHasVideoInput = inspectorGeneratorReferences.some((reference) => reference.role === "reference-video" || reference.role === "motion-video");
  const inspectorVideoReference = inspectorGeneratorReferences.find((reference) => reference.role === "reference-video" || reference.role === "motion-video");
  const inspectorInputVideoDuration = inspectorVideoReference && "durationSeconds" in inspectorVideoReference ? inspectorVideoReference.durationSeconds : undefined;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><BrandMark /><span>SCENELITH</span><small>studio</small></div>
        <button className={`workspace-switcher ${workspaceLibraryOpen ? "is-open" : ""}`} onClick={() => { setWorkspaceLibraryOpen((value) => !value); setProjectLibraryOpen(false); }}><Boxes size={14} /><span>{workspace.name}</span><ChevronDown size={13} /></button>
        <div className={`project-switcher ${projectLibraryOpen ? "is-open" : ""}`}>
          <button className="project-switcher-main" onClick={() => { setProjectLibraryOpen((value) => !value); setWorkspaceLibraryOpen(false); setIdentityLibraryOpen(false); }}><LayoutGrid size={14} /><span>{project.name}</span><ChevronDown size={14} /></button>
          {workspace.memberRole === "owner" && <button className="icon-button" onClick={() => setNewProjectFormOpen(true)} title="New canvas"><Plus size={16} /></button>}
        </div>
        <form className="source-bar" onSubmit={importSource}>
          <Clapperboard size={16} />
          <input value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="Paste a direct TikTok video or slideshow link…" />
          <button type="submit" disabled={importing || !sourceUrl.trim()}>
            {importing ? <LoaderCircle className="spin" size={15} /> : <Upload size={15} />}
            {importing ? "Extracting" : "Import"}
          </button>
        </form>
        <div className="top-actions">
          <div className={`canvas-collaboration-presence is-${collaborationStatus}`} title={collaborationStatus === "synced" ? "Canvas is live and saved continuously" : collaborationStatus === "offline" ? "Reconnecting — local changes are kept" : "Connecting to the live canvas"}>
            <span className="canvas-collaboration-dot" />
            {collaborators.slice(0, 3).map((collaborator) => <i key={collaborator.clientId} style={{ "--collaborator-color": collaborator.color } as React.CSSProperties} title={collaborator.name}>{collaborator.name.slice(0, 1).toUpperCase()}</i>)}
            {collaborators.length > 3 && <small>+{collaborators.length - 3}</small>}
          </div>
          <TaskCenter onNavigate={(task) => {
            const targetProject = projects.find((item) => item.id === task.projectId);
            if (targetProject && targetProject.id !== project.id) {
              void switchProject(targetProject);
              return;
            }
            const taskNode = nodesRef.current.find((node) => node.id === task.nodeId);
            if (task.kind === "automation") {
              setTikTokAutomationOpen(true);
              setAutomationSourceId(task.nodeId);
              if (taskNode) focusAutomationSource(task.nodeId);
              return;
            }
            if (!taskNode) return;
            setSelectedId(taskNode.id);
            setSidebarOpen(!["prompt", "assistant", "note", "scene", "videoMaster"].includes(taskNode.data.kind) && !(taskNode.data.kind === "source" && Boolean(taskNode.data.videoSegments?.length)));
            void fitView({ nodes: [taskNode], padding: 0.32, minZoom: 0.2, maxZoom: 1.08, duration: 360 });
          }} />
          <NotificationBell onNavigate={openCommunityPanel} />
          <ProfileMenu user={user} workspaceId={workspace.id} workspaceName={workspace.name} workspaceRole={workspace.memberRole} usage={liveCreditUsage} onRequestAccountView={setAccountView} onOpenAdmin={() => openCommunityPanel("admin")} onOpenTeam={() => openCommunityPanel("team")} />
        </div>
      </header>

      <AccountOverlayExtension
        view={accountView}
        usage={liveCreditUsage}
        workspaceId={workspace.id}
        userEmail={user.email}
        workspaceOwner={workspace.memberRole === "owner"}
        onClose={() => setAccountView(null)}
        onUsageUpdated={setLiveCreditUsage}
      />
      <PendingTeamInvitations />

      {workspaceLibraryOpen && (
        <div className="workspace-library">
          <div className="workspace-library-head"><div><p className="eyebrow">YOUR PROJECTS</p><h2>Projects</h2></div>{workspace.memberRole === "owner" && <button className="library-add" onClick={() => setNewWorkspaceFormOpen(true)}><Plus size={14} />New project</button>}</div>
          <div className="workspace-list">{workspaces.map((item) => {
            const canvasCount = projects.filter((projectItem) => projectItem.workspaceId === item.id).length;
            const current = item.id === workspace.id;
            return <div key={item.id} className={`workspace-card ${current ? "is-current" : ""}`} role="button" tabIndex={0} onClick={() => { if (editingWorkspaceId !== item.id) void switchWorkspace(item); }} onKeyDown={(event) => { if (editingWorkspaceId !== item.id && (event.key === "Enter" || event.key === " ")) void switchWorkspace(item); }}>
              <span className="workspace-card-mark">{item.name.slice(0, 1).toUpperCase()}</span>
              <span>
                {editingWorkspaceId === item.id ? <input className="library-inline-name" value={inlineWorkspaceName} autoFocus maxLength={80} onClick={(event) => event.stopPropagation()} onChange={(event) => setInlineWorkspaceName(event.target.value)} onBlur={() => void renameWorkspaceInline(item)} onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setEditingWorkspaceId(null); setInlineWorkspaceName(item.name); } }} aria-label="Project name" /> : <strong title={item.memberRole === "owner" ? "Double-click to rename" : undefined} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => { if (item.memberRole !== "owner") return; event.stopPropagation(); setInlineWorkspaceName(item.name); setEditingWorkspaceId(item.id); }}> {item.name}</strong>}
                <small>{item.memberRole === "member" ? "Shared workspace · Member access" : `${canvasCount} canvas${canvasCount === 1 ? "" : "es"} · own identities & hooks`}</small>
              </span>
              {current ? <Check size={14} /> : <ChevronDown size={14} />}
            </div>;
          })}</div>
          <div className="workspace-library-foot"><Settings2 size={12} />Role and hook settings live inside the Hook Vault</div>
        </div>
      )}

      {projectLibraryOpen && (
        <div className="project-library">
          <div className="project-library-head"><div><p className="eyebrow">CANVAS LIBRARY</p><h2>Canvases</h2></div>{workspace.memberRole === "owner" && <div className="project-library-head-actions"><a className="library-add" href={`/api/projects/${project.id}/export`} download title="Export current canvas as .scenelith.json"><Download size={14} />Export</a><button className="library-add" onClick={() => recipeImportInputRef.current?.click()} disabled={recipeImporting}>{recipeImporting ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />}Import</button><button className="library-add" onClick={() => setNewProjectFormOpen(true)}><Plus size={14} />New canvas</button><input ref={recipeImportInputRef} className="scenelith-document-input" type="file" accept=".scenelith.json,application/json,application/vnd.scenelith.canvas+json" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void importScenelithDocument(file); }} /></div>}</div>
          <label className="project-search"><Search size={14} /><input value={projectSearch} onChange={(event) => setProjectSearch(event.target.value)} placeholder="Find a canvas…" /></label>
          <div className="project-list">
            {projects.filter((item) => item.workspaceId === workspace.id && item.name.toLowerCase().includes(projectSearch.toLowerCase())).map((item) => {
              const stats = projectStats(item);
              const current = item.id === project.id;
              return <div key={item.id} className={`project-card ${current ? "is-current" : ""}`} role="button" tabIndex={0} onClick={() => void switchProject(item)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") void switchProject(item); }}>
                <span className="project-card-copy"><strong>{item.name}</strong><small>{stats.scenes} screens · {stats.prompts} prompts · {stats.outputs} outputs</small><em>{new Date(item.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</em></span>
                <span className="project-card-state">{projectSwitchingId === item.id ? <><LoaderCircle className="spin" size={13} />Opening</> : current ? <><Check size={13} />Current</> : "Open"}</span>
              </div>;
            })}
            {!projects.filter((item) => item.workspaceId === workspace.id && item.name.toLowerCase().includes(projectSearch.toLowerCase())).length && <div className="project-search-empty">No canvases match “{projectSearch}”</div>}
          </div>
          <div className="project-library-foot">{projects.filter((item) => item.workspaceId === workspace.id).length} canvases in {workspace.name} · saved automatically</div>
        </div>
      )}

      <aside className={`tool-rail ${tiktokAutomationOpen || hookLibraryOpen || identityLibraryOpen || communityFocus ? "has-open-panel" : ""}`}>
        <button className={tiktokAutomationOpen ? "is-active" : ""} data-tooltip="TikTok automation" aria-label="Open TikTok automation" onClick={() => { const nextOpen = !tiktokAutomationOpen; setTikTokAutomationOpen(nextOpen); setHookLibraryOpen(false); setIdentityLibraryOpen(false); setCommunityFocus(null); if (nextOpen && selectedAutomationSourceId) focusAutomationSource(selectedAutomationSourceId); }}><Workflow size={18} /></button>
        <button className={hookLibraryOpen ? "is-active" : ""} data-tooltip="Hooks" aria-label="Open hooks" onClick={() => { setHookLibraryOpen((value) => !value); setIdentityLibraryOpen(false); setTikTokAutomationOpen(false); setCommunityFocus(null); }}><Quote size={18} /></button>
        <button className={identityLibraryOpen ? "is-active" : ""} data-tooltip="Library" aria-label="Open Library" onClick={() => { setIdentityLibraryOpen((value) => !value); setHookLibraryOpen(false); setTikTokAutomationOpen(false); setCommunityFocus(null); }}><Images size={18} /></button>
        <span className="tool-rail-divider" />
        {communityRailItems.map((item) => <button key={item.kind} className={communityFocus?.kind === item.kind ? "is-active" : ""} data-tooltip={item.label} aria-label={`Open ${item.label}`} onClick={() => communityFocus?.kind === item.kind ? setCommunityFocus(null) : openCommunityPanel(item.kind)}><item.icon size={18} /></button>)}
      </aside>

      <CommunityPanelRouter focus={communityFocus} user={user} workspace={workspace} onOpenPricing={() => { setCommunityFocus(null); setAccountView("access"); }} onClose={() => setCommunityFocus(null)} />

      {tiktokAutomationOpen && <TikTokAutomationPanel
        sources={tiktokAutomationSources}
        sourceId={selectedAutomationSourceId}
        setSourceId={(value) => { setAutomationSourceId(value); setAutomationPlan(null); setAutomationStatus("idle"); focusAutomationSource(value); }}
        mode={automationMode}
        setMode={(value) => { setAutomationMode(value); setAutomationPlan(null); setAutomationStatus("idle"); setAutomationSlideStates([]); }}
        personas={personas}
        personaId={selectedAutomationPersonaId}
        setPersonaId={(value) => { setAutomationPersonaId(value); setAutomationPlan(null); setAutomationStatus("idle"); setAutomationSlideStates([]); }}
        models={models}
        modelId={selectedAutomationModelId}
        setModelId={(value) => { setAutomationModelId(value); setAutomationPlan(null); setAutomationStatus("idle"); }}
        planningModelId={selectedAutomationPlanningModelId}
        setPlanningModelId={(value) => { setAutomationPlanningModelId(value); setAutomationPlan(null); setAutomationStatus("idle"); }}
        newOutfit={automationNewOutfit}
        setNewOutfit={setAutomationNewOutfit}
        newLocation={automationNewLocation}
        setNewLocation={setAutomationNewLocation}
        textStrategy={automationTextStrategy}
        setTextStrategy={setAutomationTextStrategy}
        creativeBrief={automationCreativeBrief}
        setCreativeBrief={setAutomationCreativeBrief}
        status={automationStatus}
        activeStage={automationStage}
        stageLabel={automationStageLabel}
        planningProgress={automationPlanningProgress}
        slideStates={automationSlideStates}
        estimatedCredits={automationPlan?.estimatedCredits || automationEstimatedCredits}
        planningCredits={automationPlanningCredits}
        generationCredits={automationGenerationCredits}
        onRun={() => void runTikTokAutomation()}
        onClose={() => setTikTokAutomationOpen(false)}
      />}

      <section
        className={`canvas-stage canvas-mode-${canvasMode} ${canvasMediaDragActive ? "is-media-drop-active" : ""}`}
        onPointerMove={(event) => { lastCanvasPointerRef.current = { x: event.clientX, y: event.clientY }; }}
        onPointerLeave={() => { lastCanvasPointerRef.current = null; }}
        onDragOverCapture={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setCanvasMediaDragActive(true);
        }}
        onDropCapture={(event) => {
          const files = Array.from(event.dataTransfer.files || []);
          if (!files.length) return;
          event.preventDefault();
          event.stopPropagation();
          setCanvasMediaDragActive(false);
          void importCanvasMedia(files, { x: event.clientX, y: event.clientY }, "drop");
        }}
      >
        {canvasMediaDragActive && <div className="canvas-media-drop-overlay" aria-hidden="true"><span><ImagePlus size={17} /><Video size={17} /></span><strong>Drop media on canvas</strong><small>Images and videos become saved scene nodes</small></div>}
        {projectHydratingId === project.id && <div className="canvas-project-loading" aria-hidden="true"><CanvasLoadingDotField /></div>}
        <nav className="canvas-floating-tools" aria-label="Canvas tools" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" className={canvasAddMenuOpen ? "is-active" : ""} onClick={() => setCanvasAddMenuOpen((open) => !open)} title="Add a node"><Plus size={17} /></button>
          <span className="canvas-tool-separator" />
          <button type="button" className={canvasMode === "select" ? "is-active is-primary" : ""} onClick={() => setCanvasMode("select")} title="Select and move"><MousePointer2 size={17} /></button>
          <button type="button" className={canvasMode === "pan" ? "is-active is-primary" : ""} onClick={() => setCanvasMode("pan")} title="Pan canvas"><Hand size={17} /></button>
          <span className="canvas-tool-separator" />
          <button type="button" className="canvas-note-tool" onClick={addCanvasNote} title="Add a sticky note"><StickyNote size={17} /></button>
          <span className="canvas-tool-separator" />
          <button type="button" onClick={undo} disabled={!historyControls.canUndo} title="Undo (⌘Z)"><Undo2 size={17} /></button>
          <button type="button" onClick={redo} disabled={!historyControls.canRedo} title="Redo (⇧⌘Z)"><Redo2 size={17} /></button>
        </nav>
        {canvasAddMenuOpen && <div className="canvas-add-menu" onPointerDown={(event) => event.stopPropagation()}>
          <header><span>ADD TO CANVAS</span><button type="button" onClick={() => setCanvasAddMenuOpen(false)} aria-label="Close"><X size={13} /></button></header>
          <button type="button" onClick={() => addCanvasGenerator("image")}><span className="canvas-add-icon image"><ImagePlus size={16} /></span><span><strong>Image Generator</strong><small>Generate or remake a frame</small></span></button>
          <button type="button" onClick={() => addCanvasGenerator("video")}><span className="canvas-add-icon video"><Video size={16} /></span><span><strong>Video Generator</strong><small>Animate an image reference</small></span></button>
          <button type="button" onClick={() => canvasMediaInputRef.current?.click()}><span className="canvas-add-icon media"><Upload size={16} /></span><span><strong>Upload media</strong><small>Add image or video as a scene</small></span></button>
          <button type="button" onClick={addCanvasAssistant}><span className="canvas-add-icon assistant"><Sparkles size={16} /></span><span><strong>Assistant</strong><small>Write or refine a generation prompt</small></span></button>
          <button type="button" onClick={addCanvasNote}><span className="canvas-add-icon note"><StickyNote size={16} /></span><span><strong>Sticky Note</strong><small>Write freely on the canvas</small></span></button>
          <input ref={canvasMediaInputRef} className="canvas-media-input" type="file" accept=".jpg,.jpeg,.png,.mp4,.mov,.webm,.m4v,image/jpeg,image/png,video/mp4,video/quicktime,video/webm" multiple onChange={(event) => { const files = Array.from(event.currentTarget.files || []); event.currentTarget.value = ""; setCanvasAddMenuOpen(false); void importCanvasMedia(files, undefined, "drop"); }} />
        </div>}
        <GeneratorNodeContext.Provider value={{ models, personas, selectNode: selectCanvasNode, focusMasterClipSource, updateNode, saveNow: (nodeId, data) => {
          if (nodeId && data) {
            const next = nodesRef.current.map((node) => node.id === nodeId ? { ...node, data: { ...node.data, ...data } } : node);
            nodesRef.current = next;
            setNodes(next);
          }
          window.setTimeout(() => void save(true, true), 0);
        }, composePrompt: composeGeneratorPrompt, composeMasterPrompt, captureVideoFrame, extractVideoSegment, generateMasterClip: (nodeId, clipId) => void generateMasterClip(nodeId, clipId), updateMasterClipModel, removeMasterClip, uploadMasterClips: (nodeId, files) => void uploadMasterClips(nodeId, files), downloadMasterMedia, generatingNodeIds: activeGenerationNodeIds, preparingMasterClipIds, generationConcurrency: Math.max(1, liveCreditUsage.generationConcurrency || 1), queueLabel: liveCreditUsage.profileName, runningAssistantNodeId, activePreviewNodeId: previewNode?.id || null, getReferences: nodeReferencePreviews, getTextInput: connectedTextInput, disconnectReference, hasDownstreamGenerator, runAssistant: (nodeId) => void runAssistant(nodeId), openPreview: (nodeId, media) => { const node = nodesRef.current.find((item) => item.id === nodeId); if (node && (media?.url || node.data.outputUrl || node.data.imageUrl || node.data.kind === "videoMaster")) { stopAllVideoPlayback(); setPreviewMode("view"); setPreviewMedia(media || null); setPreviewNode(node); } }, openEdit: (nodeId) => { const node = nodesRef.current.find((item) => item.id === nodeId); if (node?.data.assetId && (node.data.outputUrl || node.data.imageUrl)) { setPreviewMode("edit"); setPreviewMedia(null); setPreviewNode(node); } }, addToIdentity: addGeneratedAssetToIdentity, createIdentityFromAsset: createIdentityFromGeneratedAsset, deleteNode: deleteCanvasNode, generateChain: (nodeId) => void generateChain(nodeId), generateNode: (nodeId) => { const node = nodesRef.current.find((item) => item.id === nodeId); if (node) void generate(node); } }}>
        <DisconnectEdgeContext.Provider value={disconnectEdge}>
        <ReactFlow
          nodes={canvasNodes}
          edges={canvasEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onDragEnter={(event) => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            setCanvasMediaDragActive(true);
          }}
          onDragOver={(event) => {
            const carriesPersona = event.dataTransfer.types.includes("application/x-frameflow-persona");
            const carriesFiles = event.dataTransfer.types.includes("Files");
            if (!carriesPersona && !carriesFiles) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            if (carriesFiles) setCanvasMediaDragActive(true);
          }}
          onDragLeave={(event) => {
            const nextTarget = event.relatedTarget;
            if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
            setCanvasMediaDragActive(false);
          }}
          onDrop={(event) => {
            const files = Array.from(event.dataTransfer.files || []);
            if (files.length) {
              event.preventDefault();
              event.stopPropagation();
              setCanvasMediaDragActive(false);
              void importCanvasMedia(files, { x: event.clientX, y: event.clientY }, "drop");
              return;
            }
            setCanvasMediaDragActive(false);
            dropPersonaOnCanvas(event);
          }}
          onNodeDragStart={() => pushHistory()}
          onNodeClick={(_, node) => {
            setNodeHookSettingsOpen(false);
            selectCanvasNode(node.id);
            setSidebarOpen(!["prompt", "assistant", "note", "scene", "videoMaster"].includes(node.data.kind) && !(node.data.kind === "source" && Boolean(node.data.videoSegments?.length)));
            if (node.data.kind === "source" && node.data.sourceUrl && !node.data.postStats) void refreshSourceStats(node);
          }}
          onNodeDoubleClick={(_, node) => {
            if (node.data.kind === "videoMaster") {
              const clips = [...(node.data.videoMasterClips || [])].sort((left, right) => Number(left.sequenceIndex ?? 0) - Number(right.sequenceIndex ?? 0));
              const clip = clips.find((item) => item.id === node.data.videoMasterSelectedClipId) || clips[0];
              const media = videoMasterClipPlaybackMedia(clip, "output", { output: true, original: true });
              setPreviewMode("view");
              setPreviewMedia(clip && media.url ? { url: media.url, start: media.start, end: media.end, title: clip.title } : null);
              setPreviewNode(node);
              return;
            }
            if (node.data.outputUrl || node.data.imageUrl) { setPreviewMode("view"); setPreviewMedia(null); setPreviewNode(node); }
          }}
          onPaneClick={() => { stopAllVideoPlayback(); setSelectedId(null); setNodeCreator(null); setCanvasAddMenuOpen(false); setProjectLibraryOpen(false); setWorkspaceLibraryOpen(false); }}
          onInit={(instance) => {
            if (initialProject.graph.viewport || !initialCanvasGraph.nodes.length) return;
            window.requestAnimationFrame(() => void instance.fitView({ nodes: initialCanvasGraph.nodes.slice(0, 4), padding: 0.2, duration: 0, maxZoom: 1.08 }));
          }}
          onMoveEnd={(_, viewport) => {
            viewportRef.current = viewport;
            dirtyProjectIdsRef.current.add(project.id);
            projectGraphRevisionRef.current[project.id] = (projectGraphRevisionRef.current[project.id] || 0) + 1;
            if (viewportSaveTimerRef.current !== null) window.clearTimeout(viewportSaveTimerRef.current);
            viewportSaveTimerRef.current = window.setTimeout(() => {
              viewportSaveTimerRef.current = null;
              void save(true);
            }, 800);
          }}
          onlyRenderVisibleElements
          defaultViewport={initialProject.graph.viewport || { x: 0, y: 0, zoom: 1 }}
          minZoom={0.15}
          maxZoom={1.8}
          nodesDraggable
          deleteKeyCode={["Backspace", "Delete"]}
          selectionOnDrag={canvasMode === "select"}
          selectionMode={SelectionMode.Partial}
          panOnDrag={canvasMode === "pan"}
          panOnScroll
          proOptions={{ hideAttribution: true }}
        >
          <Controls showInteractive={false} />
          <MiniMap
            className={automationFocusNodeIds.size ? "is-automation-focused" : ""}
            nodeColor={nodeColor}
            nodeStrokeColor={(node) => automationFocusNodeIds.has(node.id) ? "#9de2c9" : "transparent"}
            nodeStrokeWidth={automationFocusNodeIds.size ? 5 : 0}
            maskColor="rgba(8, 8, 9, .76)"
            pannable={false}
            zoomable={false}
          />
        </ReactFlow>
        </DisconnectEdgeContext.Provider>
        </GeneratorNodeContext.Provider>
        {nodes.length === 0 && projectHydratingId !== project.id && (
          <div className="empty-canvas"><Clapperboard size={26} /><h2>Start with a source</h2><p>Paste a TikTok link above or paste an image directly onto the canvas. Each visual becomes its own scene.</p></div>
        )}
      </section>

      {previewNode && !previewNode.id.startsWith("library:") && (previewNode.data.kind === "videoMaster" || (previewUrl && previewNode.data.mediaType === "video")) ? <VideoEditorViewer
        node={previewNode}
        url={previewUrl || ""}
        videoStart={previewMedia?.start}
        videoEnd={previewMedia?.end}
        onClose={() => { stopAllVideoPlayback(); setPreviewNode(null); setPreviewMedia(null); }}
        onUpdateNode={(patch) => {
          updateNode(previewNode.id, patch);
          setPreviewNode((current) => current?.id === previewNode.id ? { ...current, data: { ...current.data, ...patch } } : current);
        }}
        onExtractSegment={(segment, clientX, clientY) => extractVideoSegment(previewNode.id, segment, clientX, clientY)}
        onCaptureFrame={(time) => captureVideoFrame(previewNode.id, time)}
        onUploadMasterClips={(files) => void uploadMasterClips(previewNode.id, files)}
        models={models}
        masterReferences={(clipId) => nodeReferencePreviews(previewNode.id, clipId).map((reference) => ({
          ...reference,
          mediaType: reference.role === "reference-audio" ? "audio" : reference.role === "reference-video" || reference.role === "motion-video" ? "video" : "image",
        }))}
        masterReferenceLibrary={videoEditorReferenceLibrary}
        personas={personas}
        onDisconnectMasterReference={(reference) => {
          if (reference.sourceNodeId || reference.edgeId) disconnectReference(previewNode.id, String(reference.sourceNodeId || ""), reference.edgeId);
        }}
        onGenerateMasterClip={(clipId) => void generateMasterClip(previewNode.id, clipId)}
        onDownloadMaster={(lane, scope) => downloadMasterMedia(previewNode.id, lane, scope)}
        onDeleteNode={() => deleteCanvasNode(previewNode.id)}
      /> : previewNode && previewUrl ? <MediaViewer
        node={previewNode}
        url={previewUrl}
        videoStart={previewMedia?.start}
        videoEnd={previewMedia?.end}
        mediaTitle={previewMedia?.title}
        references={previewReferences}
        persona={previewPersona ? { id: previewPersona.id, name: previewPersona.name, avatarUrl: previewPersona.avatarUrl, variant: previewPersonaVariant } : undefined}
        editCanvasReferences={editCanvasReferences}
        editPersonas={editPersonas}
        identities={personas}
        initialEditReferences={previewEditReferences}
        models={models}
        createdAt={String(previewNode.data.generatedAt || previewNode.data.createdAt || project.updatedAt)}
        projectName={workspace.name}
        canvasName={previewNode.id.startsWith("library:") ? String(previewNode.data.subtitle || project.name) : project.name}
        initialMode={previewMode}
        onClose={() => { setPreviewNode(null); setPreviewMedia(null); }}
        onDelete={previewNode.id.startsWith("library:") ? undefined : () => deleteCanvasNode(previewNode.id)}
        onRefineEdit={(brief, options, editReferences) => composeImageEditPrompt(previewNode, brief, options, editReferences)}
        onCreateEdit={(prompt, options, editReferences, onPhase) => editImageInPlace(previewNode, prompt, options, editReferences, onPhase)}
        onUploadEditReferences={uploadImageEditReferences}
        onEditReferencesChange={(editReferences) => persistImageEditReferences(previewNode.id, String(previewNode.data.assetId || ""), editReferences)}
        onAddToIdentity={addGeneratedAssetToIdentity}
        onCreateIdentityFromAsset={createIdentityFromGeneratedAsset}
      /> : null}

      {nodeCreator && (
        <div className="node-creator-menu" style={{ left: nodeCreator.clientX, top: nodeCreator.clientY }} role="dialog" aria-label="Create connected node">
          <div className="node-creator-title"><span>{nodeCreator.segment ? `${nodeCreator.segment.label} · replace` : "Continue from media"}</span><button onClick={() => setNodeCreator(null)} aria-label="Close node creator"><X size={13} /></button></div>
          {nodeCreator.segment ? <>
            <button onClick={() => createConnectedNode("video")}><span className="node-creator-icon video"><Video size={16} /></span><span><strong>Generate replacement</strong><small>Build a timed video clip from this scene</small></span></button>
            <label className="node-creator-upload"><span className="node-creator-icon media"><Upload size={16} /></span><span><strong>Upload replacement</strong><small>Use your own MP4, MOV or WebM clip</small></span><input type="file" accept=".mp4,.mov,.webm,.m4v,video/mp4,video/quicktime,video/webm" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void uploadVideoSegmentReplacement(nodeCreator.nodeId, nodeCreator.segment!.id, file); }} /></label>
          </> : <>
            <button onClick={() => createConnectedNode("image")}><span className="node-creator-icon image"><ImagePlus size={16} /></span><span><strong>Image Generator</strong><small>Use this media as a reference</small></span></button>
            <button onClick={() => createConnectedNode("video")}><span className="node-creator-icon video"><Video size={16} /></span><span><strong>Video Generator</strong><small>Continue with a video model</small></span></button>
            <button onClick={() => createConnectedNode("assistant")}><span className="node-creator-icon assistant"><Sparkles size={16} /></span><span><strong>Assistant</strong><small>Use this media as context</small></span></button>
          </>}
        </div>
      )}

      {hookLibraryOpen && (
        <section className="hook-library">
          <header className="hook-page-head">
            <div className="hook-page-title"><p className="eyebrow">{workspace.name.toUpperCase()} / CREATIVE INTELLIGENCE</p><div><h1>Hooks</h1><span>{hooks.filter((item) => item.kind !== "generated").length} saved sources · {hooks.filter((item) => item.kind === "generated").length} active variants</span></div></div>
            <button className="hook-page-close" onClick={() => setHookLibraryOpen(false)} title="Back to canvas" aria-label="Back to canvas"><X size={18} /></button>
          </header>

          <div className="hook-library-body">
            <div className="hook-page-toolbar">
              <label className="hook-search"><Search size={15} /><input value={hookSearch} onChange={(event) => setHookSearch(event.target.value)} placeholder="Search hook text or angle…" /></label>
              <div className="hook-filters" role="group" aria-label="Filter hooks">
                {([['all', 'All'], ['original', 'Imported'], ['manual', 'Manual'], ['generated', 'AI variants']] as const).map(([value, label]) => <button key={value} className={hookFilter === value ? "is-active" : ""} onClick={() => setHookFilter(value)}>{label}</button>)}
              </div>
            </div>

            <div className="hook-settings-row">
              <details className="hook-settings-panel">
                <summary><span><Settings2 size={14} /><b>Generation role</b><small>Controls how source hooks are adapted</small></span>{roleSaveState === "error" && <span className="role-autosave role-error">Save failed</span>}</summary>
                <div className="hook-role-card"><textarea value={workspace.rolePrompt} onChange={(event) => setWorkspace((current) => ({ ...current, rolePrompt: event.target.value }))} placeholder="Describe the product, audience, tone and restrictions…" /></div>
              </details>
              <details className="hook-settings-panel hook-add-panel">
                <summary><span><Plus size={14} /><b>Add saved hook</b><small>Store a hook and its performance manually</small></span></summary>
                <form className="manual-hook-form" onSubmit={createManualHook}><textarea name="hookText" placeholder="Paste hook text…" /><div className="manual-hook-side"><label><Eye size={12} /><input name="hookViews" type="number" min="0" step="1" placeholder="Views" aria-label="Hook views" /></label><button type="submit"><Plus size={13} />Save hook</button></div></form>
              </details>
            </div>

            <div className="hook-table-shell">
              <div className="hook-table-head"><span>Source hook</span><span>Generated result</span><span>Type & angle</span><span>Performance</span><span>Source</span><span>Added</span></div>
              <div className="hook-table-body">
                {visibleHooks.map((hook) => {
                  const variants = hooks.filter((item) => item.kind === "generated" && item.parentHookId === hook.id);
                  const selectedVariantIndex = Math.min(variants.length - 1, selectedVariantByHook[hook.id] || 0);
                  const selectedVariant = variants[selectedVariantIndex];
                  const linkedProject = hook.projectId ? projects.find((item) => item.id === hook.projectId) : null;
                  return <article key={hook.id} className={`hook-table-row hook-${hook.kind}`}>
                    <div className="hook-table-copy"><p title={hook.text}>{hook.text}</p></div>
                    <div className={`hook-generated-result ${selectedVariant ? "has-result" : ""}`}>
                      <div key={selectedVariant?.id || "empty"} className="hook-result-content">{selectedVariant ? <><div className="hook-result-meta"><span>AI result</span>{variants.length > 1 && <select value={selectedVariantIndex} onChange={(event) => setSelectedVariantByHook((current) => ({ ...current, [hook.id]: Number(event.target.value) }))} aria-label={`Select generated variant for ${hook.text}`}>{variants.map((variant, index) => <option key={variant.id} value={index}>{index + 1} / {variants.length}</option>)}</select>}</div><p title={selectedVariant.text}>{selectedVariant.text}</p></> : <span>Not generated yet</span>}</div>
                      <div className="hook-result-actions">{selectedVariant && <button onClick={() => void copyHook(selectedVariant)} title="Copy generated result" aria-label="Copy generated result"><Copy size={13} /></button>}<button className="hook-generate" onClick={() => void generateHooks(hook)} disabled={hookBusy} title={`Replace with ${hookVariantCount} new variant${hookVariantCount === 1 ? "" : "s"}`} aria-label={`Regenerate ${hookVariantCount} variant${hookVariantCount === 1 ? "" : "s"}`}><RefreshCcw className={hookBusy ? "spin" : ""} size={13} /></button></div>
                    </div>
                    <div className="hook-table-kind"><span>{hook.kind === "original" ? "Imported" : "Manual"}</span><small>{hook.angle || "Saved source"}</small>{variants.length > 0 && <em>{variants.length} active {variants.length === 1 ? "variant" : "variants"}</em>}</div>
                    <div className={`hook-table-performance ${hook.views > 0 ? "has-views" : ""}`}><Eye size={13} /><strong>{hook.views > 0 ? formatMetric(hook.views) : "Draft"}</strong></div>
                    <div className="hook-table-source">{hook.sourceUrl ? <a href={hook.sourceUrl} target="_blank" rel="noreferrer">TikTok post <ExternalLink size={11} /></a> : <span>{linkedProject?.name || "Manual library"}</span>}</div>
                    <time>{new Date(hook.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" })}</time>
                  </article>;
                })}
                {!visibleHooks.length && <div className="hook-table-empty"><Quote size={24} /><strong>No matching hooks</strong><p>Import a TikTok or add a saved hook manually.</p></div>}
              </div>
            </div>
          </div>
        </section>
      )}

      {identityLibraryOpen && (
        <section className={`identity-library identity-library-page ${personaDragActive ? "is-dragging" : ""}`}>
          <header className="identity-page-head">
            <div className="identity-page-title"><p className="eyebrow">{workspace.name.toUpperCase()} / PROJECT LIBRARY</p><div><h1>Library</h1><span>{librarySection === "media" ? `${libraryCounts.all} media item${libraryCounts.all === 1 ? "" : "s"}` : `${personas.length} identit${personas.length === 1 ? "y" : "ies"}`}</span></div></div>
            <nav className="asset-library-tabs" aria-label="Library sections">
              <button type="button" className={librarySection === "media" ? "is-active" : ""} onClick={() => setLibrarySection("media")}><Images size={14} /><span>Media</span><small>{libraryCounts.all}</small></button>
              <button type="button" className={librarySection === "identities" ? "is-active" : ""} onClick={() => setLibrarySection("identities")}><UserRound size={14} /><span>Identities</span><small>{personas.length}</small></button>
            </nav>
            <div className="identity-library-actions">{librarySection === "identities" ? <button className="library-add" onClick={() => setPersonaFormOpen(true)}><Plus size={14} />New identity</button> : <><button type="button" className="library-media-upload" onClick={() => { setLibraryUploadOpen(true); setLibraryUploadError(""); }} title="Add media directly to Library"><Upload size={14} /><span>Add media</span></button><button className="library-refresh" onClick={() => setLibraryRefreshToken((value) => value + 1)} disabled={libraryLoading} title="Refresh Library" aria-label="Refresh Library"><RefreshCcw className={libraryLoading ? "spin" : ""} size={14} /></button></>}<button className="identity-close" onClick={() => setIdentityLibraryOpen(false)} title="Back to canvas" aria-label="Back to canvas"><X size={18} /></button></div>
          </header>
          {librarySection === "media" ? <>
            <div className="asset-library-toolbar">
              <div className={`asset-library-canvas-picker ${libraryCanvasMenuOpen ? "is-open" : ""}`}>
                <button type="button" className="asset-library-canvas-trigger" aria-haspopup="listbox" aria-expanded={libraryCanvasMenuOpen} onClick={() => setLibraryCanvasMenuOpen((value) => !value)}><span><small>Canvas</small><strong>{libraryProjectFilter === "all" ? "All canvases" : libraryProjects.find((item) => item.id === libraryProjectFilter)?.name || "All canvases"}</strong></span><ChevronDown size={13} /></button>
                {libraryCanvasMenuOpen && <div className="asset-library-canvas-menu" role="listbox" aria-label="Filter Library by canvas">
                  <button type="button" role="option" aria-selected={libraryProjectFilter === "all"} className={libraryProjectFilter === "all" ? "is-selected" : ""} onClick={() => { setLibraryProjectFilter("all"); setLibraryCanvasMenuOpen(false); }}><span><strong>All canvases</strong><small>Every canvas in this project</small></span>{libraryProjectFilter === "all" && <Check size={13} />}</button>
                  {libraryProjects.map((item) => <button type="button" role="option" aria-selected={libraryProjectFilter === item.id} className={libraryProjectFilter === item.id ? "is-selected" : ""} key={item.id} onClick={() => { setLibraryProjectFilter(item.id); setLibraryCanvasMenuOpen(false); }}><span><strong>{item.name}</strong><small>{item.id === project.id ? "Current canvas" : "Project canvas"}</small></span>{libraryProjectFilter === item.id && <Check size={13} />}</button>)}
                </div>}
              </div>
              <div className="asset-library-type-filter" role="group" aria-label="Media type">
                {([['all', 'All'], ['image', 'Images'], ['video', 'Videos']] as const).map(([value, label]) => <button type="button" key={value} className={libraryMediaFilter === value ? "is-active" : ""} onClick={() => setLibraryMediaFilter(value)}><span>{label}</span><small>{libraryCounts[value]}</small></button>)}
              </div>
              <label className="asset-library-search"><Search size={14} /><input value={librarySearch} onChange={(event) => setLibrarySearch(event.target.value)} placeholder="Search canvas or file…" aria-label="Search generated media" />{librarySearch && <button type="button" onClick={() => setLibrarySearch("")} aria-label="Clear media search"><X size={12} /></button>}</label>
              <span className="asset-library-sort">NEWEST FIRST</span>
            </div>
            <div className="asset-library-body">
              {libraryLoading ? <div className="asset-library-status"><LoaderCircle className="spin" size={22} /><strong>Loading generated media</strong><span>Preparing lightweight previews…</span></div> : libraryError ? <div className="asset-library-status is-error"><Images size={23} /><strong>Library could not load</strong><span>{libraryError}</span><button type="button" onClick={() => setLibraryRefreshToken((value) => value + 1)}>Try again</button></div> : libraryAssets.length ? <>
                <div className="asset-library-grid">
                  {libraryAssets.map((asset, index) => {
                    const modelLabel = models.find((model) => model.id === asset.modelId)?.label || (asset.mediaType === "video" ? "Generated video" : "Generated image");
                    return <article className={`asset-library-card is-${asset.mediaType}`} key={asset.id}>
                      <button type="button" className="asset-library-preview" onClick={() => openLibraryAsset(asset)} aria-label={`Open ${asset.mediaType} from ${asset.canvasName}`}>
                        <img src={asset.thumbnailUrl} alt="" loading="lazy" decoding="async" />
                        <span className="asset-library-index">{String(index + 1).padStart(2, "0")}</span>
                        <span className="asset-library-media-badge">{asset.mediaType === "video" ? <><Video size={11} />{asset.durationSeconds ? `${asset.durationSeconds.toFixed(asset.durationSeconds < 10 ? 1 : 0)}s` : "VIDEO"}</> : <><ImagePlus size={11} />IMAGE</>}</span>
                        {asset.mediaType === "video" && <i className="asset-library-play"><Video size={18} /></i>}
                      </button>
                      <footer><span><strong>{asset.source === "uploaded" ? asset.originalName || "Library media" : asset.canvasName}</strong><small>{asset.source === "uploaded" ? `Library upload · ${asset.canvasName}` : modelLabel} · {new Date(asset.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</small></span><div><button type="button" onClick={() => placeLibraryAsset(asset)} title="Add to current canvas" aria-label={`Add ${asset.mediaType} to current canvas`}><Plus size={13} /></button><a href={assetDownloadUrl(asset.url)} download title="Download" aria-label={`Download ${asset.mediaType}`}><Download size={13} /></a></div></footer>
                    </article>;
                  })}
                </div>
                {libraryCursor && <button type="button" className="asset-library-load-more" onClick={() => void loadMoreLibraryMedia()} disabled={libraryLoadingMore}>{libraryLoadingMore ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}{libraryLoadingMore ? "Loading" : "Load more"}</button>}
          </> : <div className="asset-library-status"><Images size={24} /><strong>No media here yet</strong><span>{librarySearch ? "Try another search or filter." : "Upload project media or generate an image or video to see it here."}</span></div>}
            </div>
          </> : <div className="identity-library-body identity-page-body">
            {personas.map((persona) => {
              const before = persona.assets.filter((asset) => asset.role === "before");
              const after = persona.assets.filter((asset) => asset.role === "after");
              const reference = persona.assets.filter((asset) => asset.role === "reference");
              const states = reference.length ? ([['reference', reference]] as const) : ([['before', before], ['after', after]] as const);
              return (
                <article className={`identity-record identity-page-record ${reference.length ? "is-single-identity" : "is-transformation-identity"}`} key={persona.id}>
                  <div className="identity-record-title">
                    <div className="identity-avatar">{persona.avatarUrl ? <img src={persona.avatarUrl} alt={`${persona.name} avatar`} decoding="async" /> : <span>{persona.name.slice(0, 1).toUpperCase()}</span>}<em>{reference.length ? "IDENTITY" : "AFTER"}</em></div>
                    <span><strong>{persona.name}</strong><small>{persona.notes || "No identity notes"}</small><b>{persona.assets.length} references total</b></span>
                  </div>
                  <div className="identity-states identity-page-states">
                    {states.map(([variant, assets]) => {
                      const selected = selectedAssetsFor(persona, variant);
                      const variantLabel = variant === "reference" ? "Character" : variant;
                      const upload = personaUploads[personaSelectionKey(persona.id, variant)];
                      return <section
                      key={variant}
                      className={`identity-state-panel ${variant}-state`}
                      onDragOver={(event) => { event.preventDefault(); event.currentTarget.classList.add("is-drop-target"); }}
                      onDragLeave={(event) => event.currentTarget.classList.remove("is-drop-target")}
                      onDrop={(event) => { event.preventDefault(); event.currentTarget.classList.remove("is-drop-target"); void appendPersonaAssets(persona.id, variant, Array.from(event.dataTransfer.files)); }}
                    data-reordering={personaReorderSavingKey === personaSelectionKey(persona.id, variant) ? "true" : undefined}
                    >
                      <header><span><b>{variantLabel}</b><small>{upload ? `Uploading ${upload.progress}%` : `${assets.length} ref${assets.length === 1 ? "" : "s"}${selected.length ? ` · ${selected.length} selected` : ""}`}</small></span><div className="identity-state-actions">{selected.length > 0 && <button type="button" className="identity-place-compact" draggable onDragStart={(event) => beginPersonaDrag(event, persona, variant)} onDragEnd={() => setPersonaDragActive(false)} onClick={() => placePersona(persona, variant)} title={`Add ${selected.length} selected reference${selected.length === 1 ? "" : "s"} to canvas`}><MousePointer2 size={12} /><span>Add {selected.length}</span></button>}<label className={upload ? "is-disabled" : ""} title={`Upload ${variantLabel} references`}><Plus size={13} /><span>Add</span><input type="file" accept=".jpg,.jpeg,.png,image/jpeg,image/png" multiple disabled={Boolean(upload)} onChange={(event) => { void appendPersonaAssets(persona.id, variant, Array.from(event.target.files || [])); event.currentTarget.value = ""; }} /></label></div></header>
                      <div className="identity-asset-strip">
                        {assets.map((asset, index) => {
                          const isSelected = selected.some((item) => item.id === asset.id);
                          const isDeleting = deletingPersonaAssetIds.includes(asset.id);
                          const isDragging = personaAssetDrag?.assetId === asset.id;
                          const isDragOver = personaAssetDragOverId === asset.id && personaAssetDrag?.role === variant && personaAssetDrag?.personaId === persona.id;
                          return <div
                            className={`identity-asset-card ${isSelected ? "is-selected" : ""} ${isDragging ? "is-reordering" : ""} ${isDragOver ? "is-reorder-target" : ""}`}
                            key={asset.id}
                            draggable={!isDeleting && personaReorderSavingKey !== personaSelectionKey(persona.id, variant)}
                            onDragStart={(event) => {
                              event.stopPropagation();
                              event.dataTransfer.effectAllowed = "move";
                              event.dataTransfer.setData("application/x-scenelith-persona-ref", asset.id);
                              setPersonaAssetDrag({ personaId: persona.id, role: variant, assetId: asset.id });
                            }}
                            onDragOver={(event) => {
                              if (personaAssetDrag?.personaId !== persona.id || personaAssetDrag.role !== variant) return;
                              event.preventDefault();
                              event.stopPropagation();
                              event.dataTransfer.dropEffect = "move";
                              setPersonaAssetDragOverId(asset.id);
                            }}
                            onDrop={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              const sourceId = personaAssetDrag?.assetId;
                              setPersonaAssetDrag(null);
                              setPersonaAssetDragOverId(null);
                              if (sourceId) void reorderPersonaAssets(persona.id, variant, sourceId, asset.id);
                            }}
                            onDragEnd={() => { setPersonaAssetDrag(null); setPersonaAssetDragOverId(null); }}
                          >
                            <button type="button" className="identity-asset-select" onClick={() => togglePersonaAsset(persona.id, variant, asset.id)} aria-pressed={isSelected} title={isSelected ? "Remove from selection" : "Select reference"}><img src={asset.thumbnailUrl || asset.url} alt={`${persona.name} ${variantLabel} ${index + 1}`} loading="lazy" decoding="async" /><span>{String(index + 1).padStart(2, "0")}</span>{isSelected && <Check size={12} />}</button>
                            <button type="button" className="identity-asset-remove" disabled={isDeleting} onClick={(event) => { event.stopPropagation(); void deletePersonaAsset(persona.id, asset.id); }} aria-label={`Remove ${persona.name} reference ${index + 1}`} title="Remove reference">{isDeleting ? <LoaderCircle className="spin" size={10} /> : <X size={10} />}</button>
                          </div>;
                        })}
                        {upload?.files.map((file, index) => <PersonaFilePreview key={`${file.name}:${file.size}:${index}`} file={file} index={assets.length + index} progress={upload.progress} />)}
                        {!assets.length && !upload && <div className="identity-state-empty"><Upload size={16} /><span>Drop {variantLabel.toLowerCase()} photos here</span></div>}
                      </div>
                    </section>})}
                  </div>
                </article>
              );
            })}
            {!personas.length && <div className="identity-library-empty"><UserRound size={28} /><h3>Your cast is empty</h3><p>Create a person once, then keep Before and After references together.</p><button className="primary-button" onClick={() => setPersonaFormOpen(true)}><Plus size={14} />Create first identity</button></div>}
          </div>}
        </section>
      )}

      {libraryUploadOpen && (
        <div className="modal-backdrop library-upload-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeLibraryUpload(); }}>
          <section className="library-upload-dialog" role="dialog" aria-modal="true" aria-labelledby="library-upload-title">
            <header>
              <h2 id="library-upload-title">Add media</h2>
              <button type="button" onClick={closeLibraryUpload} disabled={libraryUploadBusy} aria-label="Close media upload"><X size={17} /></button>
            </header>
            <div className="library-upload-content">
              <label
                className={`library-upload-dropzone ${libraryUploadDragActive ? "is-dragging" : ""} ${libraryUploadFiles.length ? "has-files" : ""}`}
                onDragEnter={(event) => { event.preventDefault(); if (!libraryUploadBusy) setLibraryUploadDragActive(true); }}
                onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
                onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setLibraryUploadDragActive(false); }}
                onDrop={(event) => { event.preventDefault(); if (!libraryUploadBusy) stageLibraryMedia(Array.from(event.dataTransfer.files || [])); }}
              >
                <input type="file" accept=".jpg,.jpeg,.png,.mp4,.mov,.webm,.m4v,image/jpeg,image/png,video/mp4,video/quicktime,video/webm" multiple disabled={libraryUploadBusy} onChange={(event) => { stageLibraryMedia(Array.from(event.currentTarget.files || [])); event.currentTarget.value = ""; }} />
                <Upload className="library-upload-drop-icon" size={21} />
                <strong>{libraryUploadDragActive ? "Drop files to add them" : "Drop images or videos here"}</strong>
                <small>or click to browse</small>
              </label>
              <p className="library-upload-limits">JPG, PNG, MP4, MOV or WebM · up to 20 files · 25 MB per image · 250 MB per video</p>
              {libraryUploadFiles.length > 0 && <section className="library-upload-queue">
                <header><span><strong>Ready to upload</strong><small>{libraryUploadFiles.length} / {LIBRARY_MAX_FILES} files</small></span><b>{formatBytes(libraryUploadFiles.reduce((total, file) => total + file.size, 0))} total</b></header>
                <div>{libraryUploadFiles.map((file) => <article key={`${file.name}:${file.size}:${file.lastModified}`}>
                  <span className={`library-upload-file-icon is-${isLibraryVideo(file) ? "video" : "image"}`}>{isLibraryVideo(file) ? <Video size={14} /> : <ImagePlus size={14} />}</span>
                  <span><strong title={file.name}>{file.name}</strong><small>{isLibraryVideo(file) ? "Video" : "Image"} · {formatBytes(file.size)}</small></span>
                  <button type="button" disabled={libraryUploadBusy} onClick={(event) => { event.preventDefault(); setLibraryUploadFiles((current) => current.filter((item) => item !== file)); setLibraryUploadError(""); }} aria-label={`Remove ${file.name}`} title="Remove file"><X size={13} /></button>
                </article>)}</div>
              </section>}
              {libraryUploadError && <div className="library-upload-error" role="alert"><X size={13} /><span>{libraryUploadError}</span></div>}
              {libraryUploadBusy && <div className="library-upload-progress"><span><strong>Uploading to private project storage</strong><small>{libraryUploadProgress}%</small></span><i><b style={{ width: `${libraryUploadProgress}%` }} /></i></div>}
            </div>
            <footer><button type="button" className="library-upload-cancel" onClick={closeLibraryUpload} disabled={libraryUploadBusy}>Cancel</button><button type="button" className="library-upload-submit" onClick={() => void uploadLibraryMedia()} disabled={libraryUploadBusy || !libraryUploadFiles.length}>{libraryUploadBusy && <LoaderCircle className="spin" size={14} />}{libraryUploadBusy ? "Uploading" : libraryUploadFiles.length ? `Add ${libraryUploadFiles.length} to Library` : "Add to Library"}</button></footer>
          </section>
        </div>
      )}

      {sidebarOpen && selectedNode && !["prompt", "note", "scene", "videoMaster"].includes(selectedNode.data.kind) && (
        <aside className={`inspector inspector-${selectedNode.data.kind} ${selectedNode.data.kind === "source" ? "inspector-source" : ""}`}>
          <div className="inspector-head"><div><p className="eyebrow">{selectedNode.data.kind === "source" ? "SOURCE · TIKTOK" : selectedNode.data.kind === "prompt" ? "GENERATOR" : selectedNode.data.kind === "scene" ? "SOURCE FRAME" : selectedNode.data.kind === "persona" ? "IDENTITY" : "NODE"}</p><h2>{selectedNode.data.kind === "source" ? "Post details" : selectedNode.data.kind === "prompt" ? "Image generator" : selectedNode.data.kind === "scene" ? "Screen details" : selectedNode.data.kind === "persona" ? "Identity reference" : "Node details"}</h2></div><button className="icon-button" onClick={() => setSidebarOpen(false)} aria-label="Close inspector"><X size={15} /></button></div>
          {selectedNode ? (
            <div className="inspector-body">
              <div className="inspector-title-field"><label className="field-label">Name</label><input className="panel-input" value={selectedNode.data.title} onChange={(event) => updateSelected({ title: event.target.value })} /></div>
              {selectedNode.data.kind === "source" && selectedNode.data.sourceUrl && (
                <><div className="post-insights">
                  <div className="post-insights-head"><span><BarChart3 size={14} /><strong>Publication</strong></span><button onClick={() => void refreshSourceStats(selectedNode)} disabled={refreshingStats} title="Refresh TikTok stats"><RefreshCcw className={refreshingStats ? "spin" : ""} size={13} /></button></div>
                  <div className="post-link-box"><span>{selectedNode.data.sourceUrl}</span><button onClick={() => void copySourceLink(String(selectedNode.data.sourceUrl))} title="Copy post link">{copiedPostLink ? <Check size={13} /> : <Copy size={13} />}</button><a href={String(selectedNode.data.sourceUrl)} target="_blank" rel="noreferrer" title="Open TikTok"><ExternalLink size={13} /></a></div>
                  <div className="post-meta"><span>@{selectedNode.data.author || "unknown"}</span>{selectedNode.data.publishedAt && <span><CalendarDays size={12} />{new Date(selectedNode.data.publishedAt).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>}</div>
                  {selectedNode.data.postStats ? <div className="post-stat-grid">
                    <div><Eye size={14} /><strong>{formatMetric(selectedNode.data.postStats.views)}</strong><span>Views</span></div>
                    <div><Heart size={14} /><strong>{formatMetric(selectedNode.data.postStats.likes)}</strong><span>Likes</span></div>
                    <div><MessageCircle size={14} /><strong>{formatMetric(selectedNode.data.postStats.comments)}</strong><span>Comments</span></div>
                    <div><Share2 size={14} /><strong>{formatMetric(selectedNode.data.postStats.shares)}</strong><span>Shares</span></div>
                    <div><Bookmark size={14} /><strong>{formatMetric(selectedNode.data.postStats.saves)}</strong><span>Saves</span></div>
                  </div> : <div className="post-stats-loading">{refreshingStats ? <><LoaderCircle className="spin" size={14} />Loading publication stats…</> : <button onClick={() => void refreshSourceStats(selectedNode)}>Load publication stats</button>}</div>}
                </div>{(selectedNode.data.hookText || inspectorSourceHook) && <div className="source-hook-card">
                  <div className="source-hook-head"><span><Quote size={13} />Extracted hook</span><div className="source-hook-head-actions">{inspectorGeneratedHook && <button onClick={() => void copyHook(inspectorGeneratedHook)} title="Copy generated hook" aria-label="Copy generated hook"><Copy size={13} /></button>}<button className={nodeHookSettingsOpen ? "is-active" : ""} onClick={() => setNodeHookSettingsOpen((value) => !value)} title="Edit generation role" aria-label="Edit generation role"><Settings2 size={13} /></button><button onClick={() => { if (inspectorSourceHook) void generateHooks(inspectorSourceHook); }} disabled={hookBusy || !inspectorSourceHook} title={`Regenerate ${hookVariantCount} hook variant${hookVariantCount === 1 ? "" : "s"}`} aria-label={`Regenerate ${hookVariantCount} hook variant${hookVariantCount === 1 ? "" : "s"}`}><RefreshCcw className={hookBusy ? "spin" : ""} size={13} /></button></div></div>
                  <p className="source-hook-original">{inspectorSourceHook?.text || selectedNode.data.hookText}</p>
                  <div key={inspectorGeneratedHook?.id || "empty"} className={`source-hook-result ${inspectorGeneratedHook ? "has-result" : ""}`}><span>AI result{inspectorGeneratedHooks.length > 1 ? ` · ${inspectorGeneratedIndex + 1}/${inspectorGeneratedHooks.length}` : ""}</span><p>{inspectorGeneratedHook?.text || "Not generated yet"}</p></div>
                  {nodeHookSettingsOpen && <div className="source-hook-role-editor"><div><span><Settings2 size={11} />Generation role</span>{roleSaveState === "error" && <em className="role-error">Save failed</em>}</div><textarea value={workspace.rolePrompt} onChange={(event) => setWorkspace((current) => ({ ...current, rolePrompt: event.target.value }))} placeholder="Describe the product, audience, tone and restrictions…" /></div>}
                </div>}</>
              )}
              {selectedNode.data.kind === "hook" && <><label className="field-label">Hook text</label><textarea className="prompt-editor hook-node-editor" value={selectedNode.data.hookText || ""} onChange={(event) => updateSelected({ hookText: event.target.value })} /><button className="primary-button" onClick={() => void navigator.clipboard.writeText(selectedNode.data.hookText || "")}><Copy size={14} />Copy hook</button></>}
              {selectedNode.data.kind === "scene" && (
                <>
                  {selectedNode.data.imageUrl && <div className={`inspector-screen ${selectedNode.data.mediaType === "video" ? "is-video" : ""}`}><img src={assetThumbnailUrl(String(selectedNode.data.imageUrl))} alt="Selected source screen" /></div>}
                  <label className="field-label">Screen role</label>
                  <InspectorSelect label="Screen role" value={selectedNode.data.role || "scene"} options={["video", "hook", "before", "after", "transition", "proof", "education", "checklist", "infographic", "comparison", "app_or_score", "cta", "scene"].map((role) => ({ value: role, label: role.replaceAll("_", " ") }))} onChange={(role) => updateSelected({ role })} />
                  <button className="remake-button" onClick={() => createRemakeBranch(selectedNode)}><Sparkles size={16} /><span><strong>Create my version</strong><small>Build a prompt branch from this exact screen</small></span></button>
                  <p className="panel-help">The screen will be sent as composition reference. Connect an Identity node to the new prompt when the person must stay consistent.</p>
                </>
              )}
              {selectedNode.data.kind === "prompt" && (
                <>
                  <div className="section-title"><span>Prompt</span><button onClick={draftPrompt}><Sparkles size={13} /> Draft from nodes</button></div>
                  <textarea className="prompt-editor" value={selectedNode.data.prompt || ""} onChange={(event) => updateSelected({ prompt: event.target.value })} placeholder="Connect a scene and identity, then draft a prompt…" />
                  <label className="field-label">Output type and model</label>
                  <InspectorSelect label="Output type and model" value={selectedNode.data.modelId || "nano-banana-2"} options={models.map((item) => ({
                    value: item.id,
                    label: item.label,
                    description: generatorModelCreditDescription(item, {
                      resolution: item.id === selectedNode.data.modelId ? selectedNode.data.resolution : undefined,
                      duration: item.id === selectedNode.data.modelId ? selectedNode.data.duration : undefined,
                      referenceCount: inspectorGeneratorReferences.length,
                      generateAudio: item.id === selectedNode.data.modelId ? selectedNode.data.generateAudio : item.defaultGenerateAudio,
                      hasVideoInput: inspectorHasVideoInput,
                      inputVideoDurationSeconds: inspectorInputVideoDuration,
                    }),
                    group: item.mediaType === "image" ? "Image models" : "Video models",
                  }))} onChange={(modelId) => {
                    const nextModel = models.find((item) => item.id === modelId);
                    const next = generatorSettingsForModel(nextModel, { aspectRatio: selectedNode.data.aspectRatio, resolution: selectedNode.data.resolution, duration: selectedNode.data.duration }, inspectorGeneratorReferences.length > 0, inspectorHasVideoInput);
                    updateSelected({
                      modelId,
                      mediaType: nextModel?.mediaType || "image",
                      resolution: next.resolution as NonNullable<FrameNode["data"]["resolution"]>,
                      duration: next.duration as NonNullable<FrameNode["data"]["duration"]>,
                      aspectRatio: next.aspectRatio as NonNullable<FrameNode["data"]["aspectRatio"]>,
                      ratioMode: selectedNode.data.ratioMode === "original" && !next.preservedAspectRatio ? "custom" : selectedNode.data.ratioMode,
                      generateAudio: nextModel?.defaultGenerateAudio ?? false,
                    });
                  }} />
                  {(() => {
                    const currentModel = models.find((item) => item.id === (selectedNode.data.modelId || "nano-banana-2"));
                    return currentModel ? <div className={`model-card model-${currentModel.mediaType}`}>{currentModel.mediaType === "video" ? <Video size={15} /> : <ImagePlus size={15} />}<span><strong>{currentModel.label}</strong><small>{generatorModelCreditDescription(currentModel, { resolution: selectedNode.data.resolution, duration: selectedNode.data.duration, referenceCount: inspectorGeneratorReferences.length, generateAudio: selectedNode.data.generateAudio, hasVideoInput: inspectorHasVideoInput, inputVideoDurationSeconds: inspectorInputVideoDuration })}</small></span></div> : null;
                  })()}
                  {Boolean(models.find((item) => item.id === selectedNode.data.modelId)?.durations?.length) && <><label className="field-label">Video duration</label><InspectorSelect label="Video duration" value={selectedNode.data.duration || models.find((item) => item.id === selectedNode.data.modelId)?.defaultDuration || models.find((item) => item.id === selectedNode.data.modelId)?.durations?.[0] || "5"} options={(models.find((item) => item.id === selectedNode.data.modelId)?.durations || []).map((duration) => ({ value: duration, label: `${duration} seconds` }))} onChange={(duration) => updateSelected({ duration: duration as NonNullable<FrameNode["data"]["duration"]> })} /></>}
                  {(() => {
                    const inspectorModel = models.find((item) => item.id === selectedNode.data.modelId);
                    const inspectorResolutions = generatorResolutionsFor(inspectorModel, inspectorHasVideoInput);
                    const inspectorResolution = inspectorResolutions.includes(String(selectedNode.data.resolution || ""))
                      ? String(selectedNode.data.resolution)
                      : inspectorResolutions.includes(inspectorModel?.defaultResolution || "") ? inspectorModel!.defaultResolution! : inspectorResolutions[0] || "1K";
                    const hasReferences = nodeReferencePreviews(selectedNode.id).length > 0;
                    const inspectorRatios = generatorRatiosFor(inspectorModel, inspectorResolution, hasReferences);
                    return <div className="generation-settings-grid">
                      <label><span>Aspect ratio</span><InspectorSelect label="Aspect ratio" value={selectedNode.data.aspectRatio || inspectorModel?.defaultRatio || inspectorRatios[0] || "1:1"} options={inspectorRatios.map((ratio) => ({ value: ratio, label: ratio === "auto" || ratio === "adaptive" ? `${ratio[0].toUpperCase()}${ratio.slice(1)}` : ratio }))} onChange={(aspectRatio) => updateSelected({ aspectRatio: aspectRatio as NonNullable<FrameNode["data"]["aspectRatio"]> })} /></label>
                      <label><span>Quality</span><InspectorSelect label="Quality" value={inspectorResolution} options={inspectorResolutions.map((resolution) => ({ value: resolution, label: resolution }))} onChange={(resolution) => {
                        const nextRatios = generatorRatiosFor(inspectorModel, resolution, hasReferences);
                        const currentRatio = String(selectedNode.data.aspectRatio || inspectorModel?.defaultRatio || "1:1");
                        const nextRatio = nextRatios.includes(currentRatio) ? currentRatio : nextRatios.includes(inspectorModel?.defaultRatio || "") ? inspectorModel!.defaultRatio! : nextRatios[0];
                        updateSelected({ resolution: resolution as NonNullable<FrameNode["data"]["resolution"]>, aspectRatio: nextRatio as NonNullable<FrameNode["data"]["aspectRatio"]>, ratioMode: nextRatio === currentRatio ? selectedNode.data.ratioMode : "custom" });
                      }} /></label>
                    </div>;
                  })()}
                  <label className="generation-count-control"><span><b>Number of generators</b><small>Each version becomes a separate node beside this one</small></span><span><button type="button" onClick={() => updateSelected({ generationCount: Math.max(1, Number(selectedNode.data.generationCount || 1) - 1) })} aria-label="Decrease generators">−</button><strong>{selectedNode.data.generationCount || 1}</strong><button type="button" onClick={() => updateSelected({ generationCount: Math.min(MAX_GENERATION_BATCH, Number(selectedNode.data.generationCount || 1) + 1) })} aria-label="Increase generators">+</button></span></label>
                  <div className="reference-summary">
                    <p>Connected references</p>
                    {incomingNodes(selectedNode.id).length ? incomingNodes(selectedNode.id).map((node) => <span key={node.id}>{node.data.kind} · {node.data.title}</span>) : <small>Drag connections into this node.</small>}
                  </div>
                  <button className="primary-button" onClick={() => void generate()} disabled={generating || activeGenerationNodeIds.includes(selectedNode.id) || !selectedNode.data.prompt}>{models.find((item) => item.id === selectedNode.data.modelId)?.mediaType === "video" ? <Video size={15} /> : <Sparkles size={15} />}{generating || activeGenerationNodeIds.includes(selectedNode.id) ? "Generating…" : `Generate ${selectedNode.data.generationCount || 1} ${models.find((item) => item.id === selectedNode.data.modelId)?.mediaType || "image"}${Number(selectedNode.data.generationCount || 1) === 1 ? "" : "s"}`}</button>
                </>
              )}
              {selectedNode.data.sourceUrl && selectedNode.data.kind !== "source" && <a className="source-link" href={String(selectedNode.data.sourceUrl)} target="_blank" rel="noreferrer">Open original TikTok ↗</a>}
            </div>
          ) : (
            <div className="inspector-body">
              <label className="field-label">Canvas name</label>
              <input className="panel-input canvas-name-editor" value={projectNameDraft} onChange={(event) => setProjectNameDraft(event.target.value)} onBlur={() => void renameProject()} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setProjectNameDraft(project.name); event.currentTarget.blur(); } }} maxLength={120} aria-label="Canvas name" />
              <p className="panel-help canvas-name-help">Press Enter or leave the field to save.</p>
              <div className="section-title"><span>Identities</span><button onClick={() => setPersonaFormOpen(true)}><Plus size={13} /> Add</button></div>
              <p className="panel-help">Reusable people and products. Original full-resolution photos are passed to the selected model as references.</p>
              <div className="persona-list">
                {personas.map((persona) => <button key={persona.id} className="persona-card" onClick={() => { setLibrarySection("identities"); setIdentityLibraryOpen(true); setSelectedId(null); }}>{persona.avatarUrl ? <img src={persona.avatarUrl} alt="" loading="lazy" decoding="async" /> : <UserRound />}<span><strong>{persona.name}</strong><small>{persona.assets.filter((asset) => asset.role === "before").length} before · {persona.assets.filter((asset) => asset.role === "after").length} after</small></span><ChevronDown size={14} /></button>)}
                {!personas.length && <div className="empty-persona"><UserRound size={20} /><span>No identities yet</span></div>}
              </div>
              <div className="workspace-stats"><div><strong>{nodes.filter((n) => n.data.kind === "scene").length}</strong><span>frames</span></div><div><strong>{nodes.filter((n) => n.data.kind === "prompt").length}</strong><span>prompts</span></div><div><strong>{nodes.filter((n) => n.data.kind === "generation" || Boolean(n.data.outputUrl)).length}</strong><span>outputs</span></div></div>
            </div>
          )}
        </aside>
      )}

      {personaFormOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (!personaSaving && event.target === event.currentTarget) setPersonaFormOpen(false); }}>
          <form className="modal identity-create-modal" onSubmit={createPersona}>
            <div className="modal-head"><div><p className="eyebrow">REFERENCE LIBRARY</p><h2>Add an identity</h2></div><button type="button" className="icon-button" disabled={personaSaving} onClick={() => setPersonaFormOpen(false)}><X size={16} /></button></div>
            <p className="panel-help">Choose how this character will be used. A single identity is one reusable look; transformation keeps Before and After separate.</p>
            <input type="hidden" name="workspaceId" value={workspace.id} />
            <label className="field-label">Name</label><input className="panel-input" name="name" required placeholder="e.g. Emma Carter" />
            <label className="field-label">Identity notes</label><textarea className="panel-textarea" name="notes" placeholder="Hair, age range, features that must stay consistent…" />
            <div className="identity-mode-picker" role="radiogroup" aria-label="Identity type">
              <button type="button" disabled={personaSaving} className={personaMode === "single" ? "is-active" : ""} onClick={() => { setPersonaMode("single"); setPersonaDraftFiles({ reference: [], before: [], after: [] }); }}><UserRound size={15} /><span><strong>Single identity</strong><small>One consistent character or product</small></span></button>
              <button type="button" disabled={personaSaving} className={personaMode === "transformation" ? "is-active" : ""} onClick={() => { setPersonaMode("transformation"); setPersonaDraftFiles({ reference: [], before: [], after: [] }); }}><Images size={15} /><span><strong>Before / After</strong><small>Two distinct visual stages</small></span></button>
            </div>
            <div className={`identity-upload-grid ${personaMode === "single" ? "is-single" : ""}`}>
              {(personaMode === "single" ? ([['reference', 'Consistent character references']] as const) : ([['before', 'Natural starting state'], ['after', 'Changed / final state']] as const)).map(([variant, help]) => {
                const files = personaDraftFiles[variant];
                const totalFiles = personaDraftFiles.reference.length + personaDraftFiles.before.length + personaDraftFiles.after.length;
                return <div key={variant} className={`upload-zone ${variant}-upload ${files.length ? "has-files" : ""}`} onDragOver={(event) => { if (!personaSaving) { event.preventDefault(); event.currentTarget.classList.add("is-drop-target"); } }} onDragLeave={(event) => event.currentTarget.classList.remove("is-drop-target")} onDrop={(event) => { event.preventDefault(); event.currentTarget.classList.remove("is-drop-target"); if (!personaSaving) addPersonaDraftFiles(variant, Array.from(event.dataTransfer.files)); }}>
                  <span className="upload-state">{variant === "reference" ? "IDENTITY" : variant.toUpperCase()}</span>
                  {files.length ? <div className="identity-draft-grid">
                    {files.map((file, index) => <PersonaFilePreview key={`${file.name}:${file.size}:${file.lastModified}`} file={file} index={index} progress={personaSaving ? personaSaveProgress : undefined} onRemove={personaSaving ? undefined : () => removePersonaDraftFile(variant, index)} />)}
                    {totalFiles < MAX_PERSONA_REFERENCES && !personaSaving && <label className="identity-draft-add" title="Add more references"><Plus size={15} /><span>Add</span><input type="file" accept=".jpg,.jpeg,.png,image/jpeg,image/png" multiple onChange={(event) => { addPersonaDraftFiles(variant, Array.from(event.target.files || [])); event.currentTarget.value = ""; }} /></label>}
                  </div> : <label className="identity-upload-empty"><Upload size={20} /><strong>{variant === "reference" ? "Character" : variant === "before" ? "Before" : "After"} references</strong><span>{help} · click or drop</span><input type="file" accept=".jpg,.jpeg,.png,image/jpeg,image/png" multiple disabled={personaSaving} onChange={(event) => { addPersonaDraftFiles(variant, Array.from(event.target.files || [])); event.currentTarget.value = ""; }} /></label>}
                  {files.length > 0 && <div className="upload-file-count"><Images size={12} />{files.length}</div>}
                </div>;
              })}
            </div>
            <p className="upload-footnote">JPG or PNG · up to {MAX_PERSONA_REFERENCES} images total</p>
            <button className="primary-button" type="submit" disabled={personaSaving}>{personaSaving ? <><LoaderCircle className="spin" size={15} />Uploading {personaSaveProgress}%</> : <><UserRound size={15} />Save identity</>}</button>
          </form>
        </div>
      )}
      {workspace.memberRole === "owner" && newProjectFormOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setNewProjectFormOpen(false); }}>
          <form className="modal project-create-modal" onSubmit={createProject}>
            <div className="modal-head"><div><p className="eyebrow">NEW CANVAS</p><h2>Create a canvas</h2></div><button type="button" className="icon-button" onClick={() => setNewProjectFormOpen(false)}><X size={16} /></button></div>
            <p className="panel-help">This canvas belongs to {workspace.name}. Its identities and hook library stay inside this project.</p>
            <label className="field-label">Canvas name <small>(optional)</small></label><input className="panel-input project-name-input" name="projectName" autoFocus maxLength={120} placeholder="Canvas 01" />
            <button className="primary-button" type="submit"><LayoutGrid size={15} />Create empty canvas</button>
          </form>
        </div>
      )}
      {workspace.memberRole === "owner" && newWorkspaceFormOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setNewWorkspaceFormOpen(false); }}>
          <form className="modal project-create-modal" onSubmit={createWorkspace}>
            <div className="modal-head"><div><p className="eyebrow">NEW PROJECT</p><h2>Create a project</h2></div><button type="button" className="icon-button" onClick={() => setNewWorkspaceFormOpen(false)}><X size={16} /></button></div>
            <p className="panel-help">A project keeps its canvases, identities and hook library separate from your other products.</p>
            <label className="field-label">Project name</label><input className="panel-input project-name-input" name="workspaceName" required autoFocus maxLength={80} placeholder="e.g. Renava" />
            <label className="field-label">Hook-writing role</label><textarea className="panel-textarea" name="rolePrompt" placeholder="Product, audience, promise, tone and restrictions…" />
            <button className="primary-button" type="submit"><Boxes size={15} />Create project and first canvas</button>
          </form>
        </div>
      )}
      {notice && <div className={`toast ${/fail|wrong|could not|not complete|configured/i.test(notice) ? "toast-error" : ""}`}>{notice}</div>}
    </main>
  );
}

export function CanvasApp(props: { initialProject: ProjectRecord; projects: ProjectRecord[]; initialWorkspace: WorkspaceRecord; workspaces: WorkspaceRecord[]; user: UserRecord; creditUsage: UsageSummary; initialModels: ModelOption[] }) {
  return <ReactFlowProvider><CanvasWorkspace {...props} /></ReactFlowProvider>;
}
