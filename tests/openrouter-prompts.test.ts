import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { finalizeVideoPrompt, imagePromptSystemInstruction, parseOpenRouterJson, videoPromptSystemInstruction } from "../src/lib/openrouter";
import {
  assembleTikTokSemanticContract,
  buildTikTokConceptReferenceBindingPlan,
  buildTikTokIntentContractSchema,
  buildTikTokAnalysisSchema,
  buildTikTokSourceTextDecompositionSchema,
  buildTikTokTextSequenceSchema,
  buildTikTokGenerationSchema,
  buildTikTokReferenceBindingSchema,
  buildTikTokSeriesReviewSchema,
  directionFromTikTokIntentContract,
  enforceTikTokAutomationPreferenceContract,
  normalizeTikTokGenerationCandidate,
  resolveTikTokTextSequenceFallback,
  tiktokAutomationRetryDelayMs,
  TIKTOK_AUTOMATION_PROMPT_MAX_CHARS,
  validateTikTokGenerationCandidate,
  validateTikTokIntentContract,
  validateTikTokReferenceBindingPlan,
  validateTikTokSemanticContract,
  validateTikTokSourceTextDecomposition,
  validateTikTokTextSequence,
} from "../src/lib/tiktok-automation";
import type { TikTokAutomationAnalysis, TikTokAutomationIntentContract, TikTokAutomationSemanticContract } from "../src/lib/tiktok-automation-types";

test("TikTok automation core contains no project-domain prompt preset", () => {
  const source = readFileSync(new URL("../src/lib/tiktok-automation.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:posture|slouch|spinal|spine|torso|hips)\b|side[-_ ]profile/i);
});

test("Seedance video assistant preserves declared multimodal roles", () => {
  const instruction = videoPromptSystemInstruction({
    modelId: "seedance-2-fast",
    modelLabel: "Seedance 2 Fast",
    duration: "8",
    generateAudio: true,
    references: [
      { path: "start.png", mimeType: "image/png", token: "@Start", title: "Opening frame", role: "start-frame" },
      { path: "end.png", mimeType: "image/png", token: "@End", title: "Closing frame", role: "end-frame" },
      { path: "beat.mp3", mimeType: "audio/mpeg", token: "@Beat", title: "Beat", role: "reference-audio" },
    ],
  });
  assert.match(instruction, /single coherent shot/i);
  assert.match(instruction, /continuous transition/i);
  assert.match(instruction, /reference audio supplies rhythm/i);
  assert.match(instruction, /8 seconds/i);
  assert.match(instruction, /Keep every supplied @token exactly unchanged/i);
});

test("Kling Motion assistant defers timing and movement to the reference video", () => {
  const instruction = videoPromptSystemInstruction({
    modelId: "kling-3-motion",
    modelLabel: "Kling 3.0 Motion Control",
    generateAudio: false,
    references: [
      { path: "subject.png", mimeType: "image/png", token: "@Subject", title: "Start image", role: "start-frame" },
      { path: "motion.mp4", mimeType: "video/mp4", token: "@Motion", title: "Reference video", role: "reference-video" },
    ],
  });
  assert.match(instruction, /reference video defines pose, body movement, timing and motion trajectory/i);
  assert.match(instruction, /Do not request a duration/i);
  assert.match(instruction, /Do not add sound-design instructions/i);
  assert.match(instruction, /short replacement instruction/i);
  assert.match(instruction, /do not.*add timecodes/i);
});

test("Seedance 2.5 Video Master assistant plans the generated duration and safe timeline trim", () => {
  const instruction = videoPromptSystemInstruction({
    modelId: "seedance-2-5",
    modelLabel: "Seedance 2.5",
    duration: "4",
    generateAudio: true,
    references: [{ path: "scene.mp4", mimeType: "video/mp4", token: "@Scene", title: "Scene 01", role: "reference-video", durationSeconds: 3 }],
    sceneSource: { path: "scene.mp4", mimeType: "video/mp4", token: "@Scene", title: "Scene 01", durationSeconds: 3 },
    videoMasterContext: {
      nodeId: "master-1",
      clipId: "scene-1",
      clipTitle: "Scene 01",
      timelineDurationSeconds: 3,
      generationDurationSeconds: 4,
      sourceKind: "source-segment",
      sourceAspectRatio: "9:16",
      outputAspectRatio: "9:16",
      outputRatioChanged: false,
    },
  });
  assert.match(instruction, /TIMELINE/i);
  assert.match(instruction, /first 3\.000 seconds/i);
  assert.match(instruction, /provider generates 4\.000 seconds/i);
  assert.match(instruction, /storyboard frames.*chronologically/i);
  assert.match(instruction, /Source format: 9:16\. Output format: 9:16/i);
  assert.match(instruction, /four seconds is 00:04\.000, never 04:00/i);
  assert.match(instruction, /selected scene source storyboard is the authoritative visual record/i);
  assert.match(instruction, /Do not borrow appearance, clothing, movement or location from another scene/i);
  assert.match(instruction, /refer to this exact selected source as @Scene/i);
  assert.match(instruction, /authoring alias only/i);
});

test("Seedance 2.5 Video Master prompt always receives an exact deterministic trim contract", () => {
  const prompt = finalizeVideoPrompt("REFERENCE ROLES:\n- @Scene: reference videoCHRONOLOGICAL STORYBOARD FOR @Scene\n\nTIMELINE:\n- 00:00 - 04:00: Continue the movement.", {
    modelId: "seedance-2-5",
    videoMasterContext: {
      nodeId: "master-1",
      clipId: "scene-3",
      clipTitle: "Scene 03",
      timelineDurationSeconds: 3.042,
      generationDurationSeconds: 4,
      sourceKind: "source-segment",
      sourceAspectRatio: "9:16",
      outputAspectRatio: "9:16",
      outputRatioChanged: false,
    },
  });
  assert.match(prompt, /Generate exactly 4\.000 seconds \(00:00\.000–00:04\.000\) in 9:16/i);
  assert.match(prompt, /keeps only 00:00\.000–00:03\.042/i);
  assert.match(prompt, /00:03\.042–00:04\.000 is disposable natural continuation/i);
  assert.match(prompt, /no later action beat may straddle 00:03\.042/i);
  assert.doesNotMatch(prompt, /CHRONOLOGICAL STORYBOARD FOR/i);
  assert.match(prompt, /TIMELINE:/i);
});

test("image assistant system instruction enforces exact operational identity bindings", () => {
  const instruction = imagePromptSystemInstruction();
  assert.match(instruction, /source-composition reference controls framing/i);
  assert.match(instruction, /must never supply the replacement person's face/i);
  assert.match(instruction, /Name every token used for identity directly in subject\.identity and in the task/i);
  assert.match(instruction, /Keep every supplied token exactly once in reference_plan/i);
  assert.match(instruction, /preserve and change must be explicit and non-contradictory/i);
});

test("image edit assistant keeps the source authoritative and binds named supporting references", () => {
  const instruction = imagePromptSystemInstruction({
    editMode: true,
    modelId: "nano-banana-2",
    modelLabel: "Nano Banana 2",
    aspectRatio: "4:5",
    resolution: "2K",
    sourceAspectRatio: "4:5",
    sourceDimensions: "1600x2000",
    outputSizeChanged: false,
  });
  assert.match(instruction, /@EditSource is the exact current image/i);
  assert.match(instruction, /supporting evidence, never a replacement canvas/i);
  assert.match(instruction, /reference declared as identity controls the named person's stable identity only/i);
  assert.match(instruction, /visible reference title and exact @token together/i);
  assert.match(instruction, /Keep the original composition and framing/i);
});

function semanticContract(): TikTokAutomationSemanticContract {
  return {
    userIntentSummary: "Preserve the project-specific visible body alignment demonstrated in the selected Emma photographs.",
    requirements: [{
      id: "user-brief-1",
      instruction: "Use the exact visible posture demonstrated by the selected Emma views.",
      appliesToSlideIndexes: [1],
      priority: "required",
      sourceOfTruth: "user_brief",
      acceptanceCriteria: [
        "The plan explicitly binds posture to the selected Emma views.",
        "The source slide controls framing only and does not override the requested posture.",
      ],
    }],
    globalRules: ["The source controls composition while the selected target photographs control identity and the requested visible property."],
    ambiguitiesResolved: ["The user's phrase refers to the demonstrated posture in the selected Emma photographs."],
    sequence: {
      mode: "comparison",
      comparisonFeature: "posture",
      comparisonVisibilityRule: "Keep the spine and shoulders visible on every slide.",
      sharedCameraAngle: "side profile",
      sharedFraming: "mirror selfie",
      sharedSubjectScale: "three-quarter body showing shoulders, spine, waist, and hips",
      sharedVisualConstraints: ["matching side-profile camera angle", "matching three-quarter body framing"],
      slideDifferences: [{ index: 1, instruction: "Show the baseline posture." }],
    },
    slides: [{
      index: 1,
      usesPersona: true,
      interpretation: "Retain the source storytelling setup while using Emma's demonstrated identity and body alignment.",
      requirementIds: ["user-brief-1"],
      sourceResponsibilities: ["framing", "camera position"],
      targetReferenceResponsibilities: ["identity", "posture"],
      plannedFaceVisibility: "visible",
      requiredIdentityEvidence: ["face_identity", "pose_or_form"],
      identityCoverage: [
        { need: "face_identity", assetIds: ["asset-b"] },
        { need: "pose_or_form", assetIds: ["asset-e"] },
      ],
      selectedPersonaAssetIds: ["asset-b", "asset-e"],
      directive: "Use the exact visible body alignment from the selected target views and retain only the source framing.",
      sourceText: "Original",
      overlayText: "Rewritten original",
      textRelation: "Rewrites the source line for the posture setup.",
      textStyleMode: "preserve_source",
      textStyleInstruction: "Keep the source typography and placement; change only wording.",
      expressionInstruction: "Natural.",
      visualRequirements: ["Keep the spine and shoulders visible."],
    }],
  };
}

function intentContract(): TikTokAutomationIntentContract {
  return {
    userIntentSummary: "Carry the posture demonstrated in the selected target views into both slides.",
    requirements: [{
      id: "posture",
      instruction: "Use the target person's demonstrated posture without changing image quality between stages.",
      appliesToSlideIndexes: [1, 2],
      priority: "required",
      sourceOfTruth: "user_brief",
      acceptanceCriteria: ["Both slides assign posture to target-reference evidence."],
    }],
    globalRules: ["Before and After are neutral identity-reference groups."],
    ambiguitiesResolved: ["Our posture refers to the selected target photographs."],
    campaign: {
      campaignName: "Posture sequence",
      creativeThesis: "Retain the source mechanic while making posture the visible through-line.",
      wardrobeDirection: "",
      locationDirection: "",
      visualTreatmentMode: "preserve_target_genre",
      visualTreatment: "Natural target-reference capture style.",
      consistencyRules: ["Use one coherent visual treatment across both slides."],
      rewrittenHook: "",
      commentAngle: "",
      endingInstruction: "End on the second source slide's payoff function.",
    },
    sequence: {
      mode: "comparison",
      comparisonFeature: "posture",
      comparisonVisibilityRule: "Keep the compared posture visible on every slide.",
      sharedCameraAngle: "side profile",
      sharedFraming: "mirror selfie",
      sharedSubjectScale: "three-quarter body",
      sharedVisualConstraints: ["matching side-profile camera angle", "matching body crop"],
      slideDifferences: [
        { index: 1, instruction: "Show the baseline posture." },
        { index: 2, instruction: "Show the changed posture." },
      ],
    },
    slides: [1, 2].map((index) => ({
      index,
      interpretation: `Adapt source slide ${index} using the user's posture requirement.`,
      requirementIds: ["posture"],
      directive: `Operationalize the target-supported posture on slide ${index}.`,
      sourceText: `Source ${index}`,
      overlayText: `Rewrite ${index}`,
      textRelation: `Rewrites source slide ${index}.`,
      textStyleMode: "preserve_source" as const,
      textStyleInstruction: "Keep the source typography and placement; change only wording.",
      expressionInstruction: "Natural.",
      visualRequirements: ["Keep posture visibly comparable."],
    })),
  };
}

test("identity automation treats disabled wardrobe and location toggles as exact per-slide source preservation", () => {
  const contract = intentContract();
  contract.requirements.push({
    id: "model-invented-ui-rule",
    instruction: "Disabled toggles mean wardrobe and location are free to change.",
    appliesToSlideIndexes: [1, 2],
    priority: "required",
    sourceOfTruth: "ui_choices",
    acceptanceCriteria: ["Invent different clothes and rooms."],
  });
  contract.slides.forEach((slide) => slide.requirementIds.push("model-invented-ui-rule"));
  const enforced = enforceTikTokAutomationPreferenceContract(contract, {
    mode: "identity",
    newOutfit: false,
    newLocation: false,
    textStrategy: "remove",
    creativeBrief: "",
  });
  const wardrobe = enforced.requirements.find((item) => item.id === "ui-preserve-source-wardrobe");
  const location = enforced.requirements.find((item) => item.id === "ui-preserve-source-location");
  assert.equal(wardrobe?.sourceOfTruth, "ui_choices");
  assert.equal(location?.sourceOfTruth, "ui_choices");
  assert.equal(enforced.requirements.some((item) => item.id === "model-invented-ui-rule"), false);
  assert.deepEqual(wardrobe?.appliesToSlideIndexes, [1, 2]);
  assert.deepEqual(location?.appliesToSlideIndexes, [1, 2]);
  assert.match(enforced.campaign.wardrobeDirection, /Preserve the exact wardrobe/);
  assert.match(enforced.campaign.locationDirection, /Preserve the exact location/);
  for (const slide of enforced.slides) {
    assert.equal(slide.requirementIds.includes("model-invented-ui-rule"), false);
    assert.ok(slide.requirementIds.includes("ui-preserve-source-wardrobe"));
    assert.ok(slide.requirementIds.includes("ui-preserve-source-location"));
    assert.match(slide.directive, /target identity references must not contribute or replace wardrobe/);
    assert.match(slide.directive, /target identity references must not contribute or replace location/);
  }
  for (const difference of enforced.sequence.slideDifferences) {
    assert.match(difference.instruction, /Preserve the exact wardrobe/);
    assert.match(difference.instruction, /Preserve the exact location/);
  }
});

test("intent interpretation is structurally separate from exact reference binding", () => {
  const intent = validateTikTokIntentContract(intentContract(), [1, 2]);
  assert.equal(intent.slides.length, 2);
  assert.equal("selectedPersonaAssetIds" in intent.slides[0], false);

  const binding = validateTikTokReferenceBindingPlan({ slides: [
    { index: 1, usesPersona: true, sourceResponsibilities: ["framing"], targetReferenceResponsibilities: ["identity", "posture"], plannedFaceVisibility: "incidental", requiredIdentityEvidence: ["pose_or_form"], identityCoverage: [{ need: "pose_or_form", assetIds: ["before-a"] }], selectedPersonaAssetIds: ["before-a"] },
    { index: 2, usesPersona: true, sourceResponsibilities: ["framing"], targetReferenceResponsibilities: ["identity", "posture"], plannedFaceVisibility: "incidental", requiredIdentityEvidence: ["pose_or_form"], identityCoverage: [{ need: "pose_or_form", assetIds: ["after-a"] }], selectedPersonaAssetIds: ["after-a"] },
  ] }, { slideIndexes: [1, 2], assetIds: ["before-a", "after-a"], maxPersonaReferences: 3 });

  const assembled = assembleTikTokSemanticContract(intent, binding);
  assert.deepEqual(assembled.slides[0].selectedPersonaAssetIds, ["before-a"]);
  assert.deepEqual(assembled.slides[1].selectedPersonaAssetIds, ["after-a"]);
});

test("rewrite mode authors distinct text from each slide's own source text", () => {
  const intent = intentContract();
  assert.doesNotThrow(() => validateTikTokIntentContract(intent, [1, 2], {
    strategy: "rewrite",
    sourceTextBySlide: { 1: "Source 1", 2: "Source 2" },
  }));
  intent.slides[1].overlayText = intent.slides[0].overlayText;
  assert.throws(() => validateTikTokIntentContract(intent, [1, 2], {
    strategy: "rewrite",
    sourceTextBySlide: { 1: "Source 1", 2: "Source 2" },
  }), /distinct overlay text/i);
});

test("dedicated text sequence preserves source mechanics while building a connected payoff", () => {
  const candidate = {
    seriesLogic: "The first line reframes the setup around the target topic; the second keeps the original blunt punch as the payoff.",
    slides: [
      {
        index: 1,
        sourceText: "Go easy on my mind",
        sourceFunction: "personal setup",
        sourceMechanics: ["compact plea", "first-person phrasing", "soft rhythm"],
        adaptedText: "Go easy on my spine",
        adaptationLogic: "Changes only the final noun so the original cadence introduces the target topic.",
        sequenceRole: "hook and setup",
        connectionToPrevious: "Opening line.",
        connectionToNext: "Creates the problem that the next line resolves with attitude.",
        viralMechanic: "recognizable phrase twist",
      },
      {
        index: 2,
        sourceText: "mofo.",
        sourceFunction: "blunt punchline",
        sourceMechanics: ["slang", "abrupt punctuation", "attitude"],
        adaptedText: "Stand tall, mofo.",
        adaptationLogic: "Keeps the slang payoff while adding the shortest topic-native action.",
        sequenceRole: "payoff",
        connectionToPrevious: "Answers the setup with a direct resolution.",
        connectionToNext: "Closing line.",
        viralMechanic: "abrupt attitude payoff",
      },
    ],
  };
  assert.doesNotThrow(() => validateTikTokTextSequence(candidate, { 1: "Go easy on my mind", 2: "mofo." }, [1, 2]));
  candidate.slides[0].adaptedText = candidate.slides[1].adaptedText;
  assert.throws(() => validateTikTokTextSequence(candidate, { 1: "Go easy on my mind", 2: "mofo." }, [1, 2]), /reused the same adapted line/i);
});

test("text-sequence QA falls back without aborting an otherwise valid automation plan", () => {
  const contract = intentContract();
  const fallback = {
    seriesLogic: "The first line creates curiosity and the second delivers the payoff.",
    slides: contract.slides.map((slide) => ({
      index: slide.index,
      sourceText: slide.sourceText,
      sourceFunction: "Preserve this slide's rhetorical job.",
      sourceMechanics: ["compact hook"],
      adaptedText: `Adapted line ${slide.index}`,
      adaptationLogic: "Keeps the source function while changing the topic-specific wording.",
      sequenceRole: slide.index === 1 ? "setup" : "payoff",
      connectionToPrevious: slide.index === 1 ? "Opens the sequence." : "Answers the setup.",
      connectionToNext: slide.index === 1 ? "Leads into the payoff." : "Ends the sequence.",
      viralMechanic: "curiosity and payoff",
    })),
  };
  const resolved = resolveTikTokTextSequenceFallback(contract, fallback, null);
  assert.equal(resolved.slides[0].overlayText, "Adapted line 1");
  assert.match(resolved.slides[0].textRelation, /curiosity and payoff/i);
  assert.equal(resolveTikTokTextSequenceFallback(contract, null, null), contract);
});

test("source copy decomposition makes slang and profanity a non-negotiable voice constraint", () => {
  const decomposition = {
    seriesMechanic: "A familiar gentle setup flips into an abrupt confrontational payoff.",
    slides: [
      {
        index: 1,
        sourceText: "Go easy on my mind",
        sourceFunction: "recognizable personal setup",
        phraseSkeleton: "Go easy on my [noun]",
        voiceFeatures: ["first person", "gentle plea"],
        rhetoricalRegister: "emotional",
        edgeMustRemain: false,
        nonNegotiables: ["recognizable cadence", "first-person perspective"],
        sequenceRole: "setup",
        connectionToNext: "The next line breaks the softness with a punch.",
        transferableMechanics: ["familiar phrase twist", "curiosity"],
      },
      {
        index: 2,
        sourceText: "mofo.",
        sourceFunction: "abrupt confrontational payoff",
        phraseSkeleton: "single profane address",
        voiceFeatures: ["profane slang", "fragment", "hard stop"],
        rhetoricalRegister: "profane",
        edgeMustRemain: true,
        nonNegotiables: ["profane or equally confrontational address", "abrupt payoff"],
        sequenceRole: "payoff",
        connectionToNext: "Closing line.",
        transferableMechanics: ["pattern interruption", "attitude"],
      },
    ],
  };
  assert.doesNotThrow(() => validateTikTokSourceTextDecomposition(decomposition, { 1: "Go easy on my mind", 2: "mofo." }, [1, 2]));
  decomposition.slides[1].edgeMustRemain = false;
  assert.throws(() => validateTikTokSourceTextDecomposition(decomposition, { 1: "Go easy on my mind", 2: "mofo." }, [1, 2]), /must preserve its slang or profane edge/i);
});

test("reference binding always assigns persona assets their identity responsibility", () => {
  assert.throws(() => validateTikTokReferenceBindingPlan({ slides: [{
    index: 1,
    usesPersona: true,
    sourceResponsibilities: ["framing"],
    targetReferenceResponsibilities: ["posture"],
    selectedPersonaAssetIds: ["target-a"],
  }] }, { slideIndexes: [1], assetIds: ["target-a"], maxPersonaReferences: 3 }), /mandatory identity responsibility/i);
});

test("identity binding cannot contradict source analysis about whether a slide uses the selected persona", () => {
  const plan = validateTikTokReferenceBindingPlan({ slides: [{
    index: 1,
    usesPersona: false,
    sourceResponsibilities: ["framing"],
    targetReferenceResponsibilities: ["identity", "body form"],
    plannedFaceVisibility: "incidental",
    requiredIdentityEvidence: ["body_identity"],
    identityCoverage: [{ need: "body_identity", assetIds: ["target-a"] }],
    selectedPersonaAssetIds: ["target-a"],
  }] }, {
    slideIndexes: [1],
    assetIds: ["target-a"],
    maxPersonaReferences: 3,
    expectedUsesPersonaBySlide: { 1: true },
  });

  assert.equal(plan.slides[0].usesPersona, true);
  assert.deepEqual(plan.slides[0].selectedPersonaAssetIds, ["target-a"]);
});

test("reference binding cannot discard the source TikTok visual template", () => {
  assert.throws(() => validateTikTokReferenceBindingPlan({ slides: [{
    index: 1,
    usesPersona: false,
    sourceResponsibilities: ["text placement", "storytelling position"],
    targetReferenceResponsibilities: [],
    plannedFaceVisibility: "hidden",
    requiredIdentityEvidence: [],
    identityCoverage: [],
    selectedPersonaAssetIds: [],
  }] }, { slideIndexes: [1], assetIds: [], maxPersonaReferences: 3 }), /retain at least one visual responsibility from its source TikTok slide/i);
});

test("concept adaptation never requires or binds an identity", () => {
  const analysis: TikTokAutomationAnalysis = {
    format: "list",
    summary: "A sequence of hairstyle idea cards.",
    theme: "Hairstyle inspiration",
    narrativeArc: "Hook, examples, payoff",
    language: "English",
    transformationBoundary: 0,
    slides: [1, 2].map((index) => ({
      index,
      role: index === 1 ? "hook" : "payoff",
      personaVariant: "none",
      visibleText: index === 1 ? "Hair ideas" : "Save your favorite",
      visibleTextStyle: "Bold editorial caption",
      visualBrief: "A compact beauty reference board with labeled examples",
      faceVisibility: "partial",
      faceAngle: "three_quarter",
      faceDetail: "low",
      bodyFraming: "face_closeup",
      confidence: 0.96,
    })),
  };
  const plan = buildTikTokConceptReferenceBindingPlan(analysis, [1, 2]);
  assert.deepEqual(plan.slides.map((slide) => slide.index), [1, 2]);
  assert.ok(plan.slides.every((slide) => !slide.usesPersona));
  assert.ok(plan.slides.every((slide) => slide.selectedPersonaAssetIds.length === 0));
  assert.ok(plan.slides.every((slide) => slide.targetReferenceResponsibilities.length === 0));
  assert.ok(plan.slides.every((slide) => slide.sourceResponsibilities.includes("content function")));
});

test("reference binding treats Before and After as strict neutral asset groups", () => {
  assert.throws(() => validateTikTokReferenceBindingPlan({ slides: [{
    index: 1,
    usesPersona: true,
    sourceResponsibilities: ["framing"],
    targetReferenceResponsibilities: ["identity", "posture"],
    selectedPersonaAssetIds: ["after-a"],
  }] }, {
    slideIndexes: [1],
    assetIds: ["before-a", "after-a"],
    maxPersonaReferences: 3,
    assetRolesById: { "before-a": "before", "after-a": "after" },
    requiredAssetRolesBySlide: { 1: "before" },
  }), /must select only before identity assets/i);
});

test("a clear face anchor from another state group is always forbidden", () => {
  assert.throws(() => validateTikTokReferenceBindingPlan({ slides: [{
    index: 1,
    usesPersona: true,
    sourceResponsibilities: ["composition"],
    targetReferenceResponsibilities: ["identity", "pose"],
    plannedFaceVisibility: "visible",
    requiredIdentityEvidence: ["face_identity", "pose_or_form"],
    identityCoverage: [
      { need: "face_identity", assetIds: ["face-after"] },
      { need: "pose_or_form", assetIds: ["pose-before"] },
    ],
    selectedPersonaAssetIds: ["face-after", "pose-before"],
  }] }, {
    slideIndexes: [1],
    assetIds: ["face-after", "pose-before"],
    maxPersonaReferences: 3,
    assetRolesById: { "face-after": "after", "pose-before": "before" },
    requiredAssetRolesBySlide: { 1: "before" },
    observationsByAssetId: {
      "face-after": { assetId: "face-after", role: "after", visualSummary: "Detailed face", observableAttributes: [], usefulFor: [], faceVisibility: "clear", faceAngle: "front", faceDetail: "high", bodyFraming: "face_closeup", identitySignals: ["face"], captureStyle: "Phone photo" },
      "pose-before": { assetId: "pose-before", role: "before", visualSummary: "Body pose", observableAttributes: [], usefulFor: [], faceVisibility: "partial", faceAngle: "profile", faceDetail: "low", bodyFraming: "full_body", identitySignals: ["body", "pose_or_form"], captureStyle: "Phone photo" },
    },
  }), /must select only before identity assets/i);
});

test("a cross-group face anchor cannot leak into pose coverage", () => {
  assert.throws(() => validateTikTokReferenceBindingPlan({ slides: [{
    index: 1,
    usesPersona: true,
    sourceResponsibilities: ["composition"],
    targetReferenceResponsibilities: ["identity", "pose"],
    plannedFaceVisibility: "visible",
    requiredIdentityEvidence: ["face_identity", "pose_or_form"],
    identityCoverage: [
      { need: "face_identity", assetIds: ["face-after"] },
      { need: "pose_or_form", assetIds: ["face-after"] },
    ],
    selectedPersonaAssetIds: ["face-after"],
  }] }, {
    slideIndexes: [1],
    assetIds: ["face-after", "pose-before"],
    maxPersonaReferences: 3,
    assetRolesById: { "face-after": "after", "pose-before": "before" },
    requiredAssetRolesBySlide: { 1: "before" },
    observationsByAssetId: {
      "face-after": { assetId: "face-after", role: "after", visualSummary: "Detailed face", observableAttributes: [], usefulFor: [], faceVisibility: "clear", faceAngle: "front", faceDetail: "high", bodyFraming: "face_closeup", identitySignals: ["face"], captureStyle: "Phone photo" },
    },
  }), /must select only before identity assets/i);
});

test("visible faces require complementary target identity references when available", () => {
  assert.throws(() => validateTikTokReferenceBindingPlan({ slides: [{
    index: 1,
    usesPersona: true,
    sourceResponsibilities: ["framing"],
    targetReferenceResponsibilities: ["identity", "profile"],
    plannedFaceVisibility: "visible",
    requiredIdentityEvidence: ["face_identity", "profile_identity"],
    identityCoverage: [
      { need: "face_identity", assetIds: ["pose-a"] },
      { need: "profile_identity", assetIds: ["pose-a"] },
    ],
    selectedPersonaAssetIds: ["pose-a"],
  }] }, {
    slideIndexes: [1],
    assetIds: ["face-a", "pose-a"],
    maxPersonaReferences: 3,
    assetRolesById: { "face-a": "after", "pose-a": "after" },
    requiredAssetRolesBySlide: { 1: "after" },
  }), /at least 2 complementary identity references/i);
});

test("face identity coverage must include a clear detailed target face", () => {
  assert.throws(() => validateTikTokReferenceBindingPlan({ slides: [{
    index: 1,
    usesPersona: true,
    sourceResponsibilities: ["framing"],
    targetReferenceResponsibilities: ["identity", "profile"],
    plannedFaceVisibility: "visible",
    requiredIdentityEvidence: ["face_identity", "profile_identity"],
    identityCoverage: [
      { need: "face_identity", assetIds: ["pose-a"] },
      { need: "profile_identity", assetIds: ["profile-a"] },
    ],
    selectedPersonaAssetIds: ["pose-a", "profile-a"],
  }] }, {
    slideIndexes: [1],
    assetIds: ["pose-a", "profile-a"],
    maxPersonaReferences: 3,
    assetRolesById: { "pose-a": "after", "profile-a": "after" },
    requiredAssetRolesBySlide: { 1: "after" },
    observationsByAssetId: {
      "pose-a": { assetId: "pose-a", role: "after", visualSummary: "Distant pose", observableAttributes: [], usefulFor: [], faceVisibility: "partial", faceAngle: "three_quarter", faceDetail: "low", bodyFraming: "full_body", identitySignals: ["body", "pose_or_form"], captureStyle: "Natural phone photo." },
      "profile-a": { assetId: "profile-a", role: "after", visualSummary: "Profile", observableAttributes: [], usefulFor: [], faceVisibility: "clear", faceAngle: "profile", faceDetail: "medium", bodyFraming: "upper_body", identitySignals: ["face", "profile"], captureStyle: "Natural phone photo." },
    },
  }), /face identity must use an available clear target face reference/i);
});

test("a front face anchor can support identity for a profile output", () => {
  assert.doesNotThrow(() => validateTikTokReferenceBindingPlan({ slides: [{
    index: 2,
    usesPersona: true,
    sourceResponsibilities: ["composition"],
    targetReferenceResponsibilities: ["identity", "profile", "posture"],
    plannedFaceVisibility: "visible",
    requiredIdentityEvidence: ["face_identity", "profile_identity", "pose_or_form"],
    identityCoverage: [
      { need: "face_identity", assetIds: ["front-face"] },
      { need: "profile_identity", assetIds: ["profile-pose"] },
      { need: "pose_or_form", assetIds: ["profile-pose"] },
    ],
    selectedPersonaAssetIds: ["front-face", "profile-pose"],
  }] }, {
    slideIndexes: [2],
    assetIds: ["front-face", "profile-pose"],
    maxPersonaReferences: 3,
    assetRolesById: { "front-face": "after", "profile-pose": "after" },
    requiredAssetRolesBySlide: { 2: "after" },
    observationsByAssetId: {
      "front-face": { assetId: "front-face", role: "after", visualSummary: "Close face", observableAttributes: [], usefulFor: [], faceVisibility: "clear", faceAngle: "front", faceDetail: "high", bodyFraming: "face_closeup", identitySignals: ["face"], captureStyle: "Natural phone photo." },
      "profile-pose": { assetId: "profile-pose", role: "after", visualSummary: "Profile posture", observableAttributes: [], usefulFor: [], faceVisibility: "partial", faceAngle: "profile", faceDetail: "medium", bodyFraming: "full_body", identitySignals: ["profile", "body", "pose_or_form"], captureStyle: "Natural phone photo." },
    },
  }));
});

test("preserving a source composition with a clear face requires visible target face identity", () => {
  assert.throws(() => validateTikTokReferenceBindingPlan({ slides: [{
    index: 1,
    usesPersona: true,
    sourceResponsibilities: ["composition", "camera perspective"],
    targetReferenceResponsibilities: ["identity", "pose"],
    plannedFaceVisibility: "incidental",
    requiredIdentityEvidence: ["pose_or_form"],
    identityCoverage: [{ need: "pose_or_form", assetIds: ["pose-a"] }],
    selectedPersonaAssetIds: ["pose-a"],
  }] }, {
    slideIndexes: [1],
    assetIds: ["face-a", "pose-a"],
    maxPersonaReferences: 3,
    assetRolesById: { "face-a": "after", "pose-a": "after" },
    requiredAssetRolesBySlide: { 1: "after" },
    sourceAnalysisBySlide: {
      1: {
        index: 1,
        role: "after",
        personaVariant: "after",
        visibleText: "",
        visibleTextStyle: "",
        visualBrief: "A source portrait with the face clearly visible.",
        faceVisibility: "clear",
        faceAngle: "three_quarter",
        faceDetail: "high",
        bodyFraming: "upper_body",
        confidence: 1,
      },
    },
  }), /must plan the target face as visible/i);
});

test("UI campaign summary is a lossless view of model-authored intent", () => {
  const intent = intentContract();
  const direction = directionFromTikTokIntentContract(intent);
  assert.equal(direction.campaignName, intent.campaign.campaignName);
  assert.equal(direction.creativeThesis, intent.campaign.creativeThesis);
  assert.deepEqual(direction.creativeRequirements, intent.requirements.map((item) => item.instruction));
  assert.deepEqual(direction.slideDirectives, intent.slides.map((item) => ({ index: item.index, directive: item.directive })));
});

test("provider backoff applies only to transient failures and grows exponentially", () => {
  assert.equal(tiktokAutomationRetryDelayMs(new Error("OpenRouter returned 503"), 0, 0), 1_000);
  assert.equal(tiktokAutomationRetryDelayMs(new Error("OpenRouter returned 503"), 3, 0), 8_000);
  assert.equal(tiktokAutomationRetryDelayMs(new Error("semantic contract has wrong indexes"), 0, 0), 0);
});

test("Gemini schemas constrain numeric slide indexes without unsupported numeric enums", () => {
  const schemas = [
    buildTikTokAnalysisSchema([1, 2]),
    buildTikTokIntentContractSchema([1, 2]),
    buildTikTokSourceTextDecompositionSchema([1, 2]),
    buildTikTokTextSequenceSchema([1, 2]),
    buildTikTokReferenceBindingSchema([1, 2], 4),
    buildTikTokSeriesReviewSchema([1, 2]),
  ] as Array<{ properties: { slides: { items: { properties: { index: Record<string, unknown> } } } } }>;
  for (const schema of schemas) {
    const index = schema.properties.slides.items.properties.index;
    assert.equal(index.minimum, 1);
    assert.equal(index.maximum, 2);
    assert.equal(index.enum, undefined);
  }
});

test("OpenRouter structured responses tolerate provider wrappers without weakening validation", () => {
  assert.deepEqual(parseOpenRouterJson('```json\n{"slides":[1,2]}\n```'), { slides: [1, 2] });
  assert.deepEqual(parseOpenRouterJson('<think>checking</think>\n{"slides":[1,2]}'), { slides: [1, 2] });
  assert.throws(() => parseOpenRouterJson("not json"), /invalid structured data/i);
});

test("semantic contract accepts arbitrary project-specific intent with exact model-selected references", () => {
  const result = validateTikTokSemanticContract(semanticContract(), {
    slideIndexes: [1],
    assetIds: ["asset-a", "asset-b", "asset-e"],
    maxPersonaReferences: 3,
  });
  assert.equal(result.userIntentSummary, semanticContract().userIntentSummary);
  assert.deepEqual(result.slides[0].selectedPersonaAssetIds, ["asset-b", "asset-e"]);
  assert.match(result.requirements[0].instruction, /exact visible posture/i);
});

test("semantic contract rejects references that were not supplied by the user", () => {
  const contract = semanticContract();
  contract.slides[0].selectedPersonaAssetIds = ["asset-unknown"];
  assert.throws(
    () => validateTikTokSemanticContract(contract, {
      slideIndexes: [1],
      assetIds: ["asset-a", "asset-b"],
      maxPersonaReferences: 3,
    }),
    /unknown identity image/i,
  );
});

test("semantic contract permits a deliberately person-free slide only when declared by the model", () => {
  const contract: TikTokAutomationSemanticContract = {
    userIntentSummary: "Keep the second slide as a product-only payoff.",
    requirements: [{
      id: "product-only",
      instruction: "Do not add a person to slide 2.",
      appliesToSlideIndexes: [2],
      priority: "required",
      sourceOfTruth: "user_brief",
      acceptanceCriteria: ["Slide 2 contains no human subject."],
    }],
    globalRules: ["Follow the project brief."],
    ambiguitiesResolved: ["The second slide is intentionally person-free."],
    sequence: {
      mode: "independent",
      comparisonFeature: "",
      comparisonVisibilityRule: "",
      sharedCameraAngle: "product angle",
      sharedFraming: "product framing",
      sharedSubjectScale: "full product",
      sharedVisualConstraints: ["Follow the project framing."],
      slideDifferences: [{ index: 2, instruction: "Show the product-only payoff." }],
    },
    slides: [{
      index: 2,
      usesPersona: false,
      interpretation: "Product-only payoff.",
      requirementIds: ["product-only"],
      sourceResponsibilities: ["product composition"],
      targetReferenceResponsibilities: [],
      plannedFaceVisibility: "hidden",
      requiredIdentityEvidence: [],
      identityCoverage: [],
      selectedPersonaAssetIds: [],
      directive: "Keep this slide person-free.",
      sourceText: "",
      overlayText: "",
      textRelation: "No source text.",
      textStyleMode: "remove",
      textStyleInstruction: "Remove all overlay text.",
      expressionInstruction: "Natural.",
      visualRequirements: ["Keep the slide person-free."],
    }],
  };
  assert.doesNotThrow(() => validateTikTokSemanticContract(contract, {
    slideIndexes: [2],
    assetIds: ["asset-a"],
    maxPersonaReferences: 3,
  }));
});

test("semantic contract requires target references when the interpreted slide uses a persona", () => {
  const contract = semanticContract();
  contract.slides[0].selectedPersonaAssetIds = [];
  contract.slides[0].targetReferenceResponsibilities = [];
  assert.throws(() => validateTikTokSemanticContract(contract, {
    slideIndexes: [1], assetIds: ["asset-a"], maxPersonaReferences: 3,
  }), /uses a persona but has no selected visual evidence/i);
});

test("semantic contract forbids persona references on a model-declared person-free slide", () => {
  const contract = semanticContract();
  contract.slides[0].usesPersona = false;
  assert.throws(() => validateTikTokSemanticContract(contract, {
    slideIndexes: [1], assetIds: ["asset-b", "asset-e"], maxPersonaReferences: 3,
  }), /does not use a persona but binds identity evidence/i);
});

test("semantic contract requires every applicable requirement on every named slide", () => {
  const contract = semanticContract();
  contract.requirements.push({
    id: "brief-2", instruction: "Keep a project-specific visual property.", appliesToSlideIndexes: [1],
    priority: "required", sourceOfTruth: "user_brief", acceptanceCriteria: ["The property is explicitly assigned."],
  });
  assert.throws(() => validateTikTokSemanticContract(contract, {
    slideIndexes: [1], assetIds: ["asset-b", "asset-e"], maxPersonaReferences: 3,
  }), /does not cite applicable requirement brief-2/i);
});

function generationCandidate() {
  return {
    title: "Reference-driven recreation",
    task: "Use @Screen_01_1 for composition and replace its subject with the identity from @Emma_2.",
    reference_plan: [
      { token: "@Screen_01_1", title: "Source", role: "source composition", instruction: "Use framing and camera. Apply text_plan and preserve source text styling." },
      { token: "@Emma_2", title: "Emma", role: "identity", instruction: "Use identity and assigned visible properties." },
    ],
    text_plan: {
      mode: "preserve_source",
      text: "",
      source_style_reference: "@Screen_01_1",
      style_instruction: "Keep the source typography and placement; change only wording.",
    },
    visual_style_plan: {
      mode: "preserve_target_genre",
      treatment: "Natural target-reference capture style.",
    },
    wardrobe_plan: {
      mode: "change_required",
      instruction: "Use visibly different clothing from every supplied source and target reference. Target references may provide identity, pose, or form evidence, but must not provide the output wardrobe.",
    },
    location_plan: {
      mode: "change_required",
      instruction: "Use a visibly different place from every supplied source and target reference. Target references may provide identity, pose, or form evidence, but must not provide the output location.",
    },
    sequence_plan: {
      mode: "independent",
      comparison_feature: "",
      comparison_visibility_rule: "",
      shared_camera_angle: "source angle",
      shared_framing: "source framing",
      shared_subject_scale: "source subject scale",
      shared_visual_constraints: ["Keep the source composition."],
      slide_difference: "Render this slide.",
      slide_visual_requirements: ["Keep the subject visible."],
    },
    subject: { identity: "The person from @Emma_2", appearance: [], pose: "Follow the contract.", expression: "Natural." },
    scene: { environment: "Follow the contract.", composition: "Use @Screen_01_1.", lighting: "Follow the contract.", camera: "Use the source camera." },
    preserve: ["Assigned source responsibilities"], change: ["Subject identity"], avoid: ["Identity blending"],
    output: { format: "image", style: "photorealistic" }, overlayText: "", confidence: 0.9,
  };
}

function generationContractExpectations() {
  return {
    overlayText: "",
    textStyleMode: "preserve_source" as const,
    textStyleInstruction: "Keep the source typography and placement; change only wording.",
    expressionInstruction: "Natural.",
    visualTreatmentMode: "preserve_target_genre" as const,
    visualTreatment: "Natural target-reference capture style.",
    wardrobePlan: {
      mode: "change_required" as const,
      instruction: "Use visibly different clothing from every supplied source and target reference. Target references may provide identity, pose, or form evidence, but must not provide the output wardrobe.",
    },
    locationPlan: {
      mode: "change_required" as const,
      instruction: "Use a visibly different place from every supplied source and target reference. Target references may provide identity, pose, or form evidence, but must not provide the output location.",
    },
    sourceResponsibilities: ["framing", "camera"],
    sequence: {
      mode: "independent" as const,
      comparisonFeature: "",
      comparisonVisibilityRule: "",
      sharedCameraAngle: "source angle",
      sharedFraming: "source framing",
      sharedSubjectScale: "source subject scale",
      sharedVisualConstraints: ["Keep the source composition."],
      slideDifferences: [{ index: 1, instruction: "Render this slide." }],
    },
    slideDifference: "Render this slide.",
    visualRequirements: ["Keep the subject visible."],
  };
}

test("generation candidate fits the real generation endpoint and keeps source out of identity", () => {
  assert.doesNotThrow(() => validateTikTokGenerationCandidate(generationCandidate(), "@Screen_01_1", [{
    id: "asset-b", filename: "emma.jpg", role: "before", path: "unused", mimeType: "image/jpeg",
    token: "@Emma_2", title: "Emma",
  }], true));
});

test("generation candidate rejects a source token mislabeled as identity even when a fallback exists", () => {
  const candidate = generationCandidate();
  candidate.reference_plan[0].role = "source identity";
  assert.throws(() => validateTikTokGenerationCandidate(candidate, "@Screen_01_1", [{
    id: "asset-b", filename: "emma.jpg", role: "before", path: "unused", mimeType: "image/jpeg",
    token: "@Emma_2", title: "Emma",
  }], true), /role must be exactly "source composition"/i);
});

test("generation candidate rejects leaked internal asset IDs", () => {
  const candidate = generationCandidate();
  candidate.reference_plan[1].instruction = "Use asset-b for identity.";
  assert.throws(() => validateTikTokGenerationCandidate(candidate, "@Screen_01_1", [{
    id: "asset-b", filename: "emma.jpg", role: "before", path: "unused", mimeType: "image/jpeg",
    token: "@Emma_2", title: "Emma",
  }], true), /must use @tokens instead of internal asset IDs/i);
});

test("generation candidate must preserve slide text and sequence contracts exactly", () => {
  const candidate = generationCandidate();
  assert.doesNotThrow(() => validateTikTokGenerationCandidate(candidate, "@Screen_01_1", [{
    id: "asset-b", filename: "emma.jpg", role: "before", path: "unused", mimeType: "image/jpeg",
    token: "@Emma_2", title: "Emma",
  }], true, {
    overlayText: "",
    textStyleMode: "preserve_source",
    textStyleInstruction: "Keep the source typography and placement; change only wording.",
    expressionInstruction: "Natural.",
    visualTreatmentMode: "preserve_target_genre",
    visualTreatment: "Natural target-reference capture style.",
    sequence: {
      mode: "independent",
      comparisonFeature: "",
      comparisonVisibilityRule: "",
      sharedCameraAngle: "source angle",
      sharedFraming: "source framing",
      sharedSubjectScale: "source subject scale",
      sharedVisualConstraints: ["Keep the source composition."],
      slideDifferences: [{ index: 1, instruction: "Render this slide." }],
    },
    slideDifference: "Render this slide.",
    visualRequirements: ["Keep the subject visible."],
  }));
  candidate.subject.expression = "Invented narrative mood.";
  assert.throws(() => validateTikTokGenerationCandidate(candidate, "@Screen_01_1", [{
    id: "asset-b", filename: "emma.jpg", role: "before", path: "unused", mimeType: "image/jpeg",
    token: "@Emma_2", title: "Emma",
  }], true, {
    overlayText: "",
    textStyleMode: "preserve_source",
    textStyleInstruction: "Keep the source typography and placement; change only wording.",
    expressionInstruction: "Natural.",
    visualTreatmentMode: "preserve_target_genre",
    visualTreatment: "Natural target-reference capture style.",
    sequence: {
      mode: "independent",
      comparisonFeature: "",
      comparisonVisibilityRule: "",
      sharedCameraAngle: "source angle",
      sharedFraming: "source framing",
      sharedSubjectScale: "source subject scale",
      sharedVisualConstraints: ["Keep the source composition."],
      slideDifferences: [{ index: 1, instruction: "Render this slide." }],
    },
    slideDifference: "Render this slide.",
    visualRequirements: ["Keep the subject visible."],
  }), /expressionInstruction/i);
  candidate.subject.expression = "Natural.";
  candidate.overlayText = "Shared campaign slogan";
  assert.throws(() => validateTikTokGenerationCandidate(candidate, "@Screen_01_1", [{
    id: "asset-b", filename: "emma.jpg", role: "before", path: "unused", mimeType: "image/jpeg",
    token: "@Emma_2", title: "Emma",
  }], true, {
    overlayText: "",
    textStyleMode: "preserve_source",
    textStyleInstruction: "Keep the source typography and placement; change only wording.",
    expressionInstruction: "Natural.",
    visualTreatmentMode: "preserve_target_genre",
    visualTreatment: "Natural target-reference capture style.",
    sequence: {
      mode: "independent",
      comparisonFeature: "",
      comparisonVisibilityRule: "",
      sharedCameraAngle: "source angle",
      sharedFraming: "source framing",
      sharedSubjectScale: "source subject scale",
      sharedVisualConstraints: ["Keep the source composition."],
      slideDifferences: [{ index: 1, instruction: "Render this slide." }],
    },
    slideDifference: "Render this slide.",
    visualRequirements: ["Keep the subject visible."],
  }), /overlayText must exactly match/i);
});

test("generation candidate cannot redesign source text or upgrade target capture genre", () => {
  const references = [{
    id: "asset-b", filename: "emma.jpg", role: "before" as const, path: "unused", mimeType: "image/jpeg",
    token: "@Emma_2", title: "Emma",
  }];
  const redesignedText = generationCandidate();
  redesignedText.text_plan.style_instruction = "Replace it with a polished editorial serif treatment.";
  assert.throws(() => validateTikTokGenerationCandidate(redesignedText, "@Screen_01_1", references, true, generationContractExpectations()), /text_plan\.style_instruction/i);

  const upgradedGenre = generationCandidate();
  upgradedGenre.visual_style_plan.treatment = "High-end studio campaign.";
  assert.throws(() => validateTikTokGenerationCandidate(upgradedGenre, "@Screen_01_1", references, true, generationContractExpectations()), /visual_style_plan\.treatment/i);

  const copiedWardrobe = generationCandidate();
  copiedWardrobe.wardrobe_plan.mode = "follow_contract";
  assert.throws(() => validateTikTokGenerationCandidate(copiedWardrobe, "@Screen_01_1", references, true, generationContractExpectations()), /wardrobe_plan/i);
});

test("disabled identity toggles require the source reference to own exact wardrobe and location", () => {
  const wardrobeInstruction = "Preserve the exact wardrobe, clothing, accessories, and styling visible in this slide's imported TikTok source image. Change only the person's identity; target identity references must not contribute or replace wardrobe.";
  const locationInstruction = "Preserve the exact location, background, environment, room layout, and visible setting details from this slide's imported TikTok source image. Change only the person's identity; target identity references must not contribute or replace location.";
  const candidate = generationCandidate();
  candidate.wardrobe_plan = { mode: "follow_contract", instruction: wardrobeInstruction };
  candidate.location_plan = { mode: "follow_contract", instruction: locationInstruction };
  candidate.reference_plan[0].instruction += ` ${wardrobeInstruction} ${locationInstruction}`;
  candidate.subject.appearance = [wardrobeInstruction];
  candidate.scene.environment = locationInstruction;
  const expectations = {
    ...generationContractExpectations(),
    wardrobePlan: { mode: "follow_contract" as const, instruction: wardrobeInstruction },
    locationPlan: { mode: "follow_contract" as const, instruction: locationInstruction },
  };
  const references = [{
    id: "asset-b", filename: "emma.jpg", role: "before" as const, path: "unused", mimeType: "image/jpeg",
    token: "@Emma_2", title: "Emma",
  }];
  assert.doesNotThrow(() => validateTikTokGenerationCandidate(candidate, "@Screen_01_1", references, true, expectations));

  const missingSourceWardrobe = structuredClone(candidate);
  missingSourceWardrobe.reference_plan[0].instruction = missingSourceWardrobe.reference_plan[0].instruction.replace(wardrobeInstruction, "");
  assert.throws(() => validateTikTokGenerationCandidate(missingSourceWardrobe, "@Screen_01_1", references, true, expectations), /exact wardrobe from this source slide/i);
});

test("application locks deterministic generation contracts while preserving model-authored prose", () => {
  const wardrobeInstruction = "Preserve the exact wardrobe, clothing, accessories, and styling visible in this slide's imported TikTok source image. Change only the person's identity; target identity references must not contribute or replace wardrobe.";
  const locationInstruction = "Preserve the exact location, background, environment, room layout, and visible setting details from this slide's imported TikTok source image. Change only the person's identity; target identity references must not contribute or replace location.";
  const references = [{
    id: "asset-b", filename: "emma.jpg", role: "before" as const, path: "unused", mimeType: "image/jpeg",
    token: "@Emma_2", title: "Emma",
  }];
  const expectations = {
    ...generationContractExpectations(),
    wardrobePlan: { mode: "follow_contract" as const, instruction: wardrobeInstruction },
    locationPlan: { mode: "follow_contract" as const, instruction: locationInstruction },
  };
  const authored = generationCandidate();
  authored.task = "Use @Screen_01_1 as the composition and @Emma_2 as the person.";
  authored.reference_plan[0].instruction = "Keep this slide's framing and camera.";
  authored.text_plan.style_instruction = "Same meaning in different words.";
  authored.visual_style_plan.treatment = "A paraphrase of the requested capture style.";
  authored.wardrobe_plan = { mode: "follow_contract", instruction: "Keep the clothes shown in the source." };
  authored.location_plan = { mode: "follow_contract", instruction: "Keep the room shown in the source." };
  authored.sequence_plan.slide_difference = "A paraphrase of this slide's intended action.";
  authored.subject.appearance = ["Keep the same clothes."];
  authored.subject.expression = "A natural expression, phrased differently.";
  authored.scene.environment = "Use the same room.";

  const normalized = normalizeTikTokGenerationCandidate(authored, "@Screen_01_1", expectations) as ReturnType<typeof generationCandidate>;
  assert.doesNotThrow(() => validateTikTokGenerationCandidate(normalized, "@Screen_01_1", references, true, expectations));
  assert.match(normalized.reference_plan[0].instruction, /Keep this slide's framing and camera/);
  assert.ok(normalized.subject.appearance.includes("Keep the same clothes."));
  assert.match(normalized.scene.environment, /Use the same room/);
  assert.equal(normalized.sequence_plan.slide_difference, expectations.slideDifference);
  assert.equal(normalized.text_plan.style_instruction, expectations.textStyleInstruction);
});

test("generation schema fixes reference count and role vocabulary before model output", () => {
  const schema = buildTikTokGenerationSchema(4);
  assert.equal(schema.properties.reference_plan.minItems, 4);
  assert.equal(schema.properties.reference_plan.maxItems, 4);
  assert.deepEqual(schema.properties.reference_plan.items.properties.role.enum, ["source composition", "identity"]);
  assert.deepEqual(schema.properties.text_plan.properties.mode.enum, ["preserve_source", "change_requested", "remove"]);
  assert.deepEqual(schema.properties.visual_style_plan.properties.mode.enum, ["preserve_target_genre", "change_requested"]);
  assert.deepEqual(schema.properties.wardrobe_plan.properties.mode.enum, ["change_required", "follow_contract"]);
  assert.deepEqual(schema.properties.location_plan.properties.mode.enum, ["change_required", "follow_contract"]);
});

test("generation candidate retries JSON that the generation endpoint would reject as oversized", () => {
  const candidate = generationCandidate();
  candidate.scene.environment = "x".repeat(TIKTOK_AUTOMATION_PROMPT_MAX_CHARS);
  assert.throws(() => validateTikTokGenerationCandidate(candidate, "@Screen_01_1", [{
    id: "asset-b", filename: "emma.jpg", role: "before", path: "unused", mimeType: "image/jpeg",
    token: "@Emma_2", title: "Emma",
  }], true), /transport limit/i);
});
