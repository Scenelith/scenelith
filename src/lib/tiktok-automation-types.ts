export type TikTokAutomationFormat =
  | "transformation"
  | "story"
  | "list"
  | "tutorial"
  | "comparison"
  | "aesthetic"
  | "other";

export type TikTokSlideRole = "hook" | "context" | "before" | "turn" | "after" | "payoff" | "cta" | "other";
export type TikTokPersonaVariant = "reference" | "before" | "after" | "none";
export type TikTokTextStrategy = "keep" | "rewrite" | "remove";
export type TikTokAutomationMode = "concept" | "identity";

export type TikTokAutomationPreferences = {
  mode: TikTokAutomationMode;
  newOutfit: boolean;
  newLocation: boolean;
  textStrategy: TikTokTextStrategy;
  creativeBrief: string;
};

export type TikTokAutomationAnalysisSlide = {
  index: number;
  role: TikTokSlideRole;
  personaVariant: TikTokPersonaVariant;
  visibleText: string;
  visibleTextStyle: string;
  visualBrief: string;
  faceVisibility: "clear" | "partial" | "not_visible";
  faceAngle: "front" | "three_quarter" | "profile" | "rear_or_obscured";
  faceDetail: "high" | "medium" | "low" | "none";
  bodyFraming: "face_closeup" | "upper_body" | "three_quarter_body" | "full_body" | "other";
  confidence: number;
};

export type TikTokAutomationAnalysis = {
  format: TikTokAutomationFormat;
  summary: string;
  theme: string;
  narrativeArc: string;
  language: string;
  transformationBoundary: number;
  slides: TikTokAutomationAnalysisSlide[];
};

export type TikTokReferenceObservation = {
  assetId: string;
  role: "reference" | "before" | "after";
  visualSummary: string;
  observableAttributes: string[];
  usefulFor: string[];
  faceVisibility: "clear" | "partial" | "not_visible";
  faceAngle: "front" | "three_quarter" | "profile" | "rear_or_obscured";
  faceDetail: "high" | "medium" | "low" | "none";
  bodyFraming: "face_closeup" | "upper_body" | "three_quarter_body" | "full_body" | "other";
  identitySignals: Array<"face" | "profile" | "hair" | "body" | "pose_or_form">;
  captureStyle: string;
};

export type TikTokIdentityEvidenceNeed = "face_identity" | "profile_identity" | "body_identity" | "pose_or_form";

export type TikTokIdentityCoverage = {
  need: TikTokIdentityEvidenceNeed;
  assetIds: string[];
};

export type TikTokAutomationRequirement = {
  id: string;
  instruction: string;
  appliesToSlideIndexes: number[];
  priority: "required" | "preferred";
  sourceOfTruth: "user_brief" | "target_references" | "source_slides" | "ui_choices";
  acceptanceCriteria: string[];
};

export type TikTokAutomationCampaignSpec = {
  campaignName: string;
  creativeThesis: string;
  wardrobeDirection: string;
  locationDirection: string;
  visualTreatmentMode: "preserve_target_genre" | "change_requested";
  visualTreatment: string;
  consistencyRules: string[];
  rewrittenHook: string;
  commentAngle: string;
  endingInstruction: string;
};

export type TikTokAutomationSlideIntent = {
  index: number;
  interpretation: string;
  requirementIds: string[];
  directive: string;
  sourceText: string;
  overlayText: string;
  textRelation: string;
  textStyleMode: "preserve_source" | "change_requested" | "remove";
  textStyleInstruction: string;
  expressionInstruction: string;
  visualRequirements: string[];
};

export type TikTokAutomationSequenceSpec = {
  mode: "independent" | "progression" | "comparison";
  comparisonFeature: string;
  comparisonVisibilityRule: string;
  sharedCameraAngle: string;
  sharedFraming: string;
  sharedSubjectScale: string;
  sharedVisualConstraints: string[];
  slideDifferences: Array<{ index: number; instruction: string }>;
};

export type TikTokAutomationIntentContract = {
  userIntentSummary: string;
  requirements: TikTokAutomationRequirement[];
  globalRules: string[];
  ambiguitiesResolved: string[];
  campaign: TikTokAutomationCampaignSpec;
  sequence: TikTokAutomationSequenceSpec;
  slides: TikTokAutomationSlideIntent[];
};

export type TikTokAutomationReferenceBinding = {
  index: number;
  usesPersona: boolean;
  sourceResponsibilities: string[];
  targetReferenceResponsibilities: string[];
  plannedFaceVisibility: "prominent" | "visible" | "incidental" | "hidden";
  requiredIdentityEvidence: TikTokIdentityEvidenceNeed[];
  identityCoverage: TikTokIdentityCoverage[];
  selectedPersonaAssetIds: string[];
};

export type TikTokAutomationReferenceBindingPlan = {
  slides: TikTokAutomationReferenceBinding[];
};

export type TikTokAutomationSlideContract = {
  index: number;
  usesPersona: boolean;
  interpretation: string;
  requirementIds: string[];
  sourceResponsibilities: string[];
  targetReferenceResponsibilities: string[];
  plannedFaceVisibility: "prominent" | "visible" | "incidental" | "hidden";
  requiredIdentityEvidence: TikTokIdentityEvidenceNeed[];
  identityCoverage: TikTokIdentityCoverage[];
  selectedPersonaAssetIds: string[];
  directive: string;
  sourceText: string;
  overlayText: string;
  textRelation: string;
  textStyleMode: "preserve_source" | "change_requested" | "remove";
  textStyleInstruction: string;
  expressionInstruction: string;
  visualRequirements: string[];
};

export type TikTokAutomationSemanticContract = {
  userIntentSummary: string;
  requirements: TikTokAutomationRequirement[];
  globalRules: string[];
  ambiguitiesResolved: string[];
  sequence: TikTokAutomationSequenceSpec;
  slides: TikTokAutomationSlideContract[];
};

export type TikTokAutomationDirection = {
  campaignName: string;
  creativeThesis: string;
  creativeRequirements: string[];
  wardrobeDirection: string;
  locationDirection: string;
  visualTreatmentMode: "preserve_target_genre" | "change_requested";
  visualTreatment: string;
  consistencyRules: string[];
  rewrittenHook: string;
  commentAngle: string;
  endingInstruction: string;
  slideDirectives: Array<{ index: number; directive: string }>;
  sequence: TikTokAutomationSequenceSpec;
};

export type TikTokAutomationSlidePlan = {
  index: number;
  sourceAssetId: string;
  role: TikTokSlideRole;
  personaVariant: TikTokPersonaVariant;
  prompt: string;
  overlayText: string;
  preserve: string[];
  change: string[];
  confidence: number;
  reviewPassed: boolean;
  reviewIssues: string[];
  attempts: number;
  personaAssetIds: string[];
  referenceLabels: string[];
  referenceCount: number;
  creditCost: number;
};

export type TikTokAutomationPlanResponse = {
  analysis: TikTokAutomationAnalysis;
  semanticContract: TikTokAutomationSemanticContract;
  direction: TikTokAutomationDirection;
  slides: TikTokAutomationSlidePlan[];
  persona: {
    id: string;
    name: string;
    notes: string;
    assets: Array<{ id: string; url: string; role: "reference" | "before" | "after"; filename: string }>;
  } | null;
  model: { id: string; label: string; maxReferences: number; defaultRatio: string; defaultResolution: string };
  planningModel: { id: string; label: string };
  planningCredits: number;
  planningCostUsd: number;
  generationCredits: number;
  estimatedCredits: number;
  availableCredits: number;
};
