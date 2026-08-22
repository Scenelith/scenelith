import type { Edge, Node } from "@xyflow/react";

export type FrameNodeKind =
  | "source"
  | "scene"
  | "persona"
  | "hook"
  | "prompt"
  | "assistant"
  | "generation"
  | "videoMaster"
  | "note";

export type VideoSceneSegment = {
  id: string;
  index: number;
  /** User-controlled sequence order; source start/end stay frame-accurate. */
  sequenceIndex?: number;
  label: string;
  role: "hook" | "scene" | "cta";
  start: number;
  end: number;
  confidence: number;
  thumbnailAssetId?: string;
  thumbnailUrl?: string;
  thumbnailTime?: number;
  replacementAssetId?: string;
  replacementUrl?: string;
  clipAssetId?: string;
  clipUrl?: string;
};

export type VideoMasterClip = {
  id: string;
  /** Explicit edit order. Legacy masters migrate from their Scene NN title. */
  sequenceIndex?: number;
  title: string;
  role: VideoSceneSegment["role"];
  origin: "source" | "upload" | "generated";
  duration: number;
  /** Duration kept on the edited timeline. Generated media may be longer. */
  generationDuration?: number;
  /** Physical duration returned by the provider before the timeline trim. */
  generatedDuration?: number;
  prompt: string;
  modelId?: string;
  aspectRatio?: string;
  aspectRatioMode?: "original" | "custom";
  /** Numeric width / height ratio measured from this clip's source media. */
  sourceAspectRatio?: number;
  resolution?: string;
  generateAudio?: boolean;
  attachedReferences?: Array<{
    assetId: string;
    url: string;
    title: string;
    personaId?: string;
    variant?: "reference" | "before" | "after";
    role?: GeneratorInputRole;
    durationSeconds?: number;
    thumbnailUrl?: string;
  }>;
  sourceNodeId?: string;
  sourceSegmentId?: string;
  sourceStart?: number;
  sourceEnd?: number;
  sourceUrl?: string;
  sourceAssetId?: string;
  /** Materialized scene media used for reliable zero-based playback. */
  sourceClipUrl?: string;
  sourceClipAssetId?: string;
  thumbnailUrl?: string;
  outputUrl?: string;
  outputAssetId?: string;
  generatedOutputs?: Array<{
    url: string;
    assetId?: string;
    modelId?: string;
    durationSeconds?: number;
    thumbnailUrl?: string;
  }>;
};

export type FrameNodeData = {
  kind: FrameNodeKind;
  title: string;
  subtitle?: string;
  assetId?: string;
  imageUrl?: string;
  sourceUrl?: string;
  postId?: string;
  /** Authoritative media type returned by the TikTok importer. */
  tiktokMediaType?: "slideshow" | "video";
  /** Stable slideshow lineage, independent of the current canvas edge layout. */
  tiktokSourceNodeId?: string;
  author?: string;
  publishedAt?: string;
  postStats?: {
    views: number;
    likes: number;
    comments: number;
    shares: number;
    saves: number;
  };
  hookId?: string;
  hookText?: string;
  noteText?: string;
  noteColor?: "yellow" | "blue" | "rose" | "gray";
  role?: string;
  prompt?: string;
  assistantInput?: string;
  assistantOutput?: string;
  systemPrompt?: string;
  textModelId?: string;
  status?: "idle" | "queued" | "working" | "ready" | "failed";
  generationError?: string;
  createdAt?: string;
  generatedAt?: string;
  queueReason?: "plan" | "provider";
  personaId?: string;
  personaVariant?: "reference" | "before" | "after";
  referenceAssetIds?: string[];
  attachedReferences?: Array<{
    assetId: string;
    url: string;
    title: string;
    personaId?: string;
    variant?: "reference" | "before" | "after";
    role?: GeneratorInputRole;
    durationSeconds?: number;
    thumbnailUrl?: string;
  }>;
  editReferencesByAssetId?: Record<string, Array<{
    assetId: string;
    url: string;
    thumbnailUrl?: string;
    title: string;
    origin: "canvas" | "identity" | "upload";
    detail: string;
    personaId?: string;
    variant?: "reference" | "before" | "after";
  }>>;
  outputUrl?: string;
  mediaType?: "image" | "video";
  canvasMediaOrigin?: "clipboard" | "drop" | "capture";
  capturedFromNodeId?: string;
  capturedAtSeconds?: number;
  videoSegments?: VideoSceneSegment[];
  /** Immutable scene cuts detected when the source video was imported. */
  videoDetectedSegments?: VideoSceneSegment[];
  videoDurationSeconds?: number;
  videoAspectRatio?: number;
  videoClipStart?: number;
  videoClipEnd?: number;
  videoSourceNodeId?: string;
  videoSegmentId?: string;
  videoOutputSelection?: "full" | string;
  videoSourceAssetId?: string;
  videoMasterSourceNodeId?: string;
  videoMasterClips?: VideoMasterClip[];
  videoMasterSelectedClipId?: string;
  videoMasterGeneratingClipId?: string;
  segmentMaterializing?: boolean;
  videoTimelineSprite?: {
    assetId: string;
    url: string;
    frameCount: number;
    columns?: number;
    rows?: number;
  };
  replacementFor?: {
    sourceNodeId: string;
    segmentId: string;
    start: number;
    end: number;
  };
  modelId?: string;
  duration?: string;
  generateAudio?: boolean;
  aspectRatio?: "auto" | "adaptive" | "1:1" | "1:4" | "1:8" | "2:1" | "1:2" | "2:3" | "3:1" | "1:3" | "3:2" | "4:1" | "4:3" | "3:4" | "5:4" | "4:5" | "8:1" | "16:9" | "9:16" | "21:9" | "9:21";
  ratioMode?: "custom" | "original";
  resolution?: "1K" | "2K" | "3K" | "4K" | "480P" | "720P" | "1080P";
  generationCount?: number;
  nodeWidth?: number;
  nodeHeight?: number;
  generatedOutputs?: Array<{
    url: string;
    assetId?: string;
    mediaType: "image" | "video";
    modelId?: string;
  }>;
  activeGeneratedOutputIndex?: number;
  demoAssistantOpen?: boolean;
  demoAssistantTypingText?: string;
  demoAssistantReferenceId?: string;
  demoAssistantReferenceDelayMs?: number;
  demoAssistantBuild?: boolean;
  demoAssistantBusy?: boolean;
  demoAssistantClick?: boolean;
  demoRunClick?: boolean;
  demoNodeHovered?: boolean;
  demoRequireHover?: boolean;
  demoOutputHandleClick?: boolean;
  demoReferenceHandleClick?: boolean;
  demoSourceClickSegmentId?: string;
  demoOutputGalleryOpen?: boolean;
  demoOutputGalleryToken?: number;
  demoSourcePlaybackToken?: number;
  demoSourcePlaybackSegmentId?: string;
  demoMasterPlaybackToken?: number;
  demoMasterPlaybackClipId?: string;
  demoMasterPlaybackLane?: "output" | "original";
  demoMasterPlaybackRelativeTime?: number;
  [key: string]: unknown;
};

export type FrameNode = Node<FrameNodeData>;
export type FramePortType = "text" | "image" | "video" | "audio";
export type GeneratorInputRole = "reference-image" | "start-frame" | "end-frame" | "motion-video" | "reference-video" | "reference-audio";
export type FrameEdge = Edge<{
  portType?: FramePortType;
  inputRole?: GeneratorInputRole;
  /** Keeps Video Master inputs isolated to the scene that owns them. */
  masterClipId?: string;
  automationKind?: "tiktok-slideshow";
  automationSourceNodeId?: string;
  automationSlideIndex?: number;
  sourceSegmentId?: string;
  sourceSegmentStart?: number;
  sourceSegmentEnd?: number;
  sourceSegmentLabel?: string;
  sourceSegmentThumbnailUrl?: string;
  clipAssetId?: string;
  clipUrl?: string;
  /** Exact source-scene trim prepared for the currently selected generation duration. */
  generationClipAssetId?: string;
  generationClipUrl?: string;
  generationClipDuration?: number;
}>;

export type ProjectGraph = {
  nodes: FrameNode[];
  edges: FrameEdge[];
  viewport?: { x: number; y: number; zoom: number };
};

export type ProjectRecord = {
  id: string;
  /** Monotonic server revision of the persisted graph snapshot. */
  revision: number;
  name: string;
  sourceUrl: string | null;
  status: string;
  workspaceId: string;
  graph: ProjectGraph;
  summary?: {
    scenes: number;
    prompts: number;
    outputs: number;
    previews: Array<{ id: string; imageUrl: string }>;
  };
  createdAt: string;
  updatedAt: string;
};

export type PersonaRecord = {
  id: string;
  name: string;
  notes: string;
  workspaceId: string;
  avatarUrl?: string;
  assets: Array<{ id: string; url: string; thumbnailUrl?: string; filename: string; role: "reference" | "before" | "after"; sortOrder: number; sourceAssetId?: string }>;
  createdAt: string;
};

export type LibraryMediaAsset = {
  id: string;
  projectId: string;
  canvasName: string;
  filename: string;
  originalName?: string;
  source: "generated" | "uploaded";
  mediaType: "image" | "video";
  mimeType: string;
  url: string;
  thumbnailUrl: string;
  createdAt: string;
  modelId?: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
  aspectRatio?: number;
};

export type WorkspaceRole = "owner" | "member";

export type WorkspaceRecord = {
  id: string;
  name: string;
  rolePrompt: string;
  memberRole: WorkspaceRole;
  createdAt: string;
  updatedAt: string;
};

export type UserRecord = {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  emailVerified: boolean;
  createdAt: string;
};

export type SupportTicketStatus = "open" | "in_progress" | "resolved" | "closed";
export type SupportTicketPriority = "normal" | "high" | "urgent";

export type SupportMessageRecord = {
  id: string;
  ticketId: string;
  authorUserId: string;
  authorName: string;
  isAdmin: boolean;
  body: string;
  createdAt: string;
};

export type SupportTicketRecord = {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  workspaceId: string | null;
  workspaceName: string | null;
  supportTier: "community" | "standard" | "priority";
  supportTierName: string;
  supportRank: number;
  needsReply: boolean;
  subject: string;
  category: "bug" | "generation" | "account" | "other";
  status: SupportTicketStatus;
  priority: SupportTicketPriority;
  messageCount: number;
  lastMessage?: string;
  messages?: SupportMessageRecord[];
  createdAt: string;
  updatedAt: string;
};

export type FeatureRequestStatus = "pending" | "approved" | "rejected" | "planned" | "in_progress" | "shipped";

export type FeatureRequestRecord = {
  id: string;
  userId: string;
  userName: string;
  isOwner: boolean;
  title: string;
  description: string;
  status: FeatureRequestStatus;
  hidden: boolean;
  moderationNote: string;
  voteCount: number;
  hasVoted: boolean;
  createdAt: string;
  updatedAt: string;
};

export type NotificationRecord = {
  id: string;
  recipientUserId: string | null;
  kind: "ticket_reply" | "ticket_status" | "feature_status" | "feature_update" | "announcement" | "admin_queue";
  title: string;
  body: string;
  actionType: "support" | "features" | "admin" | null;
  actionId: string | null;
  isRead: boolean;
  createdAt: string;
};

export type BackgroundTaskRecord = {
  id: string;
  kind: "generation" | "automation";
  projectId: string;
  projectName: string;
  nodeId: string;
  title: string;
  status: "queued" | "running" | "completed" | "failed";
  stageLabel: string;
  progress: number;
  mediaType?: "image" | "video";
  modelId?: string;
  operation?: "generation" | "edit";
  outputUrl?: string | null;
  assetId?: string | null;
  creditCost?: number;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type HookRecord = {
  id: string;
  workspaceId: string;
  projectId: string | null;
  parentHookId: string | null;
  sourceAssetId: string | null;
  sourceUrl: string | null;
  kind: "original" | "generated" | "manual";
  text: string;
  angle: string;
  language: string;
  views: number;
  createdAt: string;
};
