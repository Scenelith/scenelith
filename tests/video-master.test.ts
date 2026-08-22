import assert from "node:assert/strict";
import test from "node:test";
import type { FrameNode, VideoMasterClip } from "../src/lib/types";
import { assetIdFromAssetUrl, compatibleMasterReferences, hydrateVideoMasterSourceClips, masterClipHasVideoReference, masterClipOriginalReference, modelSupportsVideoReference, moveUploadedMasterClipToLane, nearestVideoMasterRatio, reconciledVideoMasterClipDuration, reconciledVideoMasterGeneratedDuration, resolveVideoMasterSourceTarget, shouldIncludeAutomaticMasterVideoReference, useVideoMasterGeneratedOutput, videoMasterClipDownloadSource, videoMasterClipExportMedia, videoMasterDownloadAvailability, videoMasterClipPlaybackMedia, videoMasterClipThumbnail, videoMasterGeneratedOutputs, videoMasterGenerationDuration, videoMasterGenerationDurationChoices, videoMasterModelsForScene, videoMasterProviderAspectRatio, videoMasterTimelineDuration } from "../src/lib/video-master";
import { validateVideoMasterGenerationReferences, videoMasterTargetAcceptsAsset } from "../src/lib/video-master-validation";
import type { ProjectGraph } from "../src/lib/types";
import { coalesceContiguousVideoAssets, videoMasterExportRequestSchema } from "../src/lib/video-export";

const models = [
  { id: "text-video", mediaType: "video" as const },
  { id: "image-video", mediaType: "video" as const, inputPorts: [{ id: "start-frame", kind: "image" as const }] },
  { id: "reference-video", mediaType: "video" as const, inputPorts: [{ id: "reference-video", kind: "video" as const }] },
];

const uploadedClip: VideoMasterClip = {
  id: "clip-1",
  title: "Uploaded clip",
  role: "scene",
  origin: "upload",
  duration: 5,
  prompt: "",
  sourceUrl: "/api/assets/video-1",
  sourceAssetId: "video-1",
};

test("Video Master keeps and can reactivate per-scene generated versions", () => {
  const generated: VideoMasterClip = {
    ...uploadedClip,
    origin: "generated",
    outputUrl: "/api/assets/version-2",
    outputAssetId: "version-2",
    generatedDuration: 4,
    generatedOutputs: [
      { url: "/api/assets/version-1", assetId: "version-1", modelId: "seedance-2-5", durationSeconds: 4 },
      { url: "/api/assets/version-2", assetId: "version-2", modelId: "seedance-2-5", durationSeconds: 4 },
    ],
  };
  assert.deepEqual(videoMasterGeneratedOutputs(generated).map((output) => output.assetId), ["version-1", "version-2"]);
  const [reactivated] = useVideoMasterGeneratedOutput([generated], generated.id, generated.generatedOutputs![0]);
  assert.equal(reactivated.outputAssetId, "version-1");
  assert.equal(reactivated.outputUrl, "/api/assets/version-1");
  assert.deepEqual(reactivated.generatedOutputs?.map((output) => output.assetId), ["version-1", "version-2"]);
});

test("a current output without saved history is not presented as a generated version", () => {
  const legacyOutputOnly: VideoMasterClip = {
    ...uploadedClip,
    origin: "generated",
    outputUrl: "/api/assets/current-output",
    outputAssetId: "current-output",
  };
  assert.deepEqual(videoMasterGeneratedOutputs(legacyOutputOnly), []);
});

test("a saved Video Master version can be copied into another scene", () => {
  const source: VideoMasterClip = {
    ...uploadedClip,
    id: "source-scene",
    origin: "generated",
    generatedOutputs: [{ url: "/api/assets/variant", assetId: "variant", modelId: "seedance-2-5", durationSeconds: 4 }],
  };
  const target: VideoMasterClip = { ...uploadedClip, id: "target-scene", title: "Target" };
  const result = useVideoMasterGeneratedOutput([source, target], target.id, source.generatedOutputs![0]);
  assert.equal(result[0].outputUrl, source.outputUrl);
  assert.equal(result[1].outputAssetId, "variant");
  assert.deepEqual(result[1].generatedOutputs?.map((output) => output.assetId), ["variant"]);
});

test("Video Master exposes every video model when the scene has no video reference", () => {
  assert.deepEqual(videoMasterModelsForScene(models, uploadedClip).map((model) => model.id), ["text-video", "image-video", "reference-video"]);
});

test("Video Master exposes only models with a video input when ORIGINAL contains a reference", () => {
  const referencedClip = moveUploadedMasterClipToLane(uploadedClip, "original");
  assert.equal(masterClipHasVideoReference(referencedClip, referencedClip.attachedReferences), true);
  assert.deepEqual(videoMasterModelsForScene(models, referencedClip, referencedClip.attachedReferences).map((model) => model.id), ["reference-video"]);
  assert.equal(modelSupportsVideoReference(models[1]), false);
  assert.equal(modelSupportsVideoReference(models[2]), true);
});

test("moving an uploaded clip to ORIGINAL attaches it as a scene video reference", () => {
  const referencedClip = moveUploadedMasterClipToLane(uploadedClip, "original");
  assert.equal(referencedClip.origin, "source");
  assert.deepEqual(referencedClip.attachedReferences, [{
    assetId: "video-1",
    url: "/api/assets/video-1",
    title: "Uploaded clip",
    thumbnailUrl: undefined,
    role: "reference-video",
    durationSeconds: 5,
  }]);

  const restoredClip = moveUploadedMasterClipToLane(referencedClip, "output");
  assert.equal(restoredClip.origin, "upload");
  assert.deepEqual(restoredClip.attachedReferences, []);
});

test("Seedance frame mode excludes the implicit ORIGINAL video and incompatible multimodal inputs", () => {
  assert.equal(shouldIncludeAutomaticMasterVideoReference("seedance-2-5", ["start-frame"]), false);
  assert.equal(shouldIncludeAutomaticMasterVideoReference("seedance-2-fast", ["end-frame"]), false);
  assert.equal(shouldIncludeAutomaticMasterVideoReference("seedance-2-5", ["reference-image"]), true);
  assert.equal(shouldIncludeAutomaticMasterVideoReference("kling-3-motion", ["start-frame"]), true);
  assert.equal(shouldIncludeAutomaticMasterVideoReference("seedance-2-5", ["reference-video"]), false);
  assert.deepEqual(compatibleMasterReferences("seedance-2-5", [
    { role: "start-frame", id: "frame" },
    { role: "reference-video", id: "video" },
    { role: "reference-image", id: "image" },
  ]), [{ role: "start-frame", id: "frame" }]);
  assert.equal(videoMasterProviderAspectRatio("seedance-2-5", "9:16", [{ role: "start-frame" }]), "adaptive");
  assert.equal(videoMasterProviderAspectRatio("seedance-2-5", "9:16", [{ role: "reference-image" }]), "9:16");
  assert.equal(videoMasterProviderAspectRatio("kling-3", "9:16", [{ role: "start-frame" }]), "9:16");
});

test("an ORIGINAL lane clip remains a reference even when legacy data has no attachedReferences", () => {
  const legacyOriginal: VideoMasterClip = {
    ...uploadedClip,
    origin: "source",
    sourceAssetId: undefined,
    attachedReferences: undefined,
  };
  assert.equal(assetIdFromAssetUrl(legacyOriginal.sourceUrl), "video-1");
  assert.deepEqual(masterClipOriginalReference(legacyOriginal), {
    id: "master-original-clip-1",
    url: "/api/assets/video-1",
    title: "Uploaded clip",
    assetId: "video-1",
    thumbnailUrl: undefined,
    role: "reference-video",
    durationSeconds: 5,
  });
});

test("standalone master references ignore a stale materialized clip from another scene", () => {
  const standalone: VideoMasterClip = {
    ...uploadedClip,
    origin: "source",
    sourceUrl: "/api/assets/scene-3",
    sourceAssetId: "scene-3",
    sourceClipUrl: "/api/assets/stale-scene-2",
    sourceClipAssetId: "stale-scene-2",
  };
  assert.deepEqual(masterClipOriginalReference(standalone), {
    id: "master-original-clip-1",
    url: "/api/assets/scene-3",
    title: "Uploaded clip",
    assetId: "scene-3",
    thumbnailUrl: undefined,
    role: "reference-video",
    durationSeconds: 5,
  });
  const master = {
    id: "master",
    type: "frameNode",
    position: { x: 0, y: 0 },
    data: { kind: "videoMaster", title: "Master", videoMasterSourceNodeId: "source", videoMasterClips: [standalone] },
  } as FrameNode;
  const source = {
    id: "source",
    type: "frameNode",
    position: { x: 0, y: 0 },
    data: { kind: "source", title: "Source", assetId: "source-video", videoSegments: [{ id: "scene-2", index: 2, label: "Scene 02", role: "scene", start: 7, end: 13, confidence: 1, clipAssetId: "stale-scene-2", clipUrl: "/api/assets/stale-scene-2" }] },
  } as FrameNode;
  const hydrated = hydrateVideoMasterSourceClips([source, master]);
  assert.equal(hydrated[1].data.videoMasterClips?.[0].sourceClipAssetId, undefined);
  assert.equal(hydrated[1].data.videoMasterClips?.[0].sourceClipUrl, undefined);
  assert.equal(resolveVideoMasterSourceTarget(hydrated, "master", "clip-1")?.sourceAssetId, "scene-3");
});

test("Video Master source validation rejects an adjacent scene asset", () => {
  const graph: ProjectGraph = {
    nodes: [{
      id: "source",
      type: "frameNode",
      position: { x: 0, y: 0 },
      data: { kind: "source", title: "Source", assetId: "full-video", videoSegments: [{ id: "scene-3", index: 3, label: "Scene 03", role: "scene", start: 13, end: 16, confidence: 1, clipAssetId: "scene-3-asset", clipUrl: "/api/assets/scene-3-asset" }] },
    }, {
      id: "master",
      type: "frameNode",
      position: { x: 0, y: 0 },
      data: { kind: "videoMaster", title: "Master", videoMasterClips: [{ id: "clip-3", title: "Scene 03", role: "scene", origin: "source", duration: 3, prompt: "", sourceNodeId: "source", sourceSegmentId: "scene-3", sourceAssetId: "full-video" }] },
    }],
    edges: [],
  };
  assert.equal(videoMasterTargetAcceptsAsset(graph, "master", "clip-3", "scene-3-asset", JSON.stringify({ sourceAssetId: "full-video", segmentId: "scene-3" })), true);
  assert.equal(videoMasterTargetAcceptsAsset(graph, "master", "clip-3", "scene-2-asset", JSON.stringify({ sourceAssetId: "full-video", segmentId: "scene-2" })), false);
  assert.equal(videoMasterTargetAcceptsAsset(graph, "master", "clip-3", "recreated-scene-3", JSON.stringify({ sourceAssetId: "full-video", segmentId: "scene-3" })), true);
  assert.equal(validateVideoMasterGenerationReferences({
    graph,
    nodeId: "master",
    clipId: "clip-3",
    targetSourceAssetId: "scene-2-asset",
    targetSourceMetadataJson: JSON.stringify({ sourceAssetId: "full-video", segmentId: "scene-2" }),
    referenceAssetIds: ["scene-2-asset"],
    referenceRoles: ["reference-video"],
  }), "The generation source does not match the selected Video Master scene");
  assert.equal(validateVideoMasterGenerationReferences({
    graph,
    nodeId: "master",
    clipId: "clip-3",
    targetSourceAssetId: "scene-3-asset",
    targetSourceMetadataJson: JSON.stringify({ sourceAssetId: "full-video", segmentId: "scene-3" }),
    referenceAssetIds: [],
    referenceRoles: [],
  }), "The selected scene video is missing from generation references");
  assert.equal(validateVideoMasterGenerationReferences({
    graph,
    nodeId: "master",
    clipId: "clip-3",
    targetSourceAssetId: "scene-3-asset",
    targetSourceMetadataJson: JSON.stringify({ sourceAssetId: "full-video", segmentId: "scene-3" }),
    referenceAssetIds: ["start-image"],
    referenceRoles: ["start-frame"],
  }), undefined);
});

test("playback timing follows the actual source segment instead of the generation duration", () => {
  const sourceClip: VideoMasterClip = {
    ...uploadedClip,
    origin: "source",
    duration: 8,
    sourceStart: 0,
    sourceEnd: 7.061,
  };
  assert.deepEqual(videoMasterClipPlaybackMedia(sourceClip, "output", { output: true, original: true }), {
    url: "/api/assets/video-1",
    outputUrl: "",
    originalUrl: "/api/assets/video-1",
    usesOutput: false,
    start: 0,
    end: 7.061,
    duration: 7.061,
  });
});

test("adjacent source scenes keep the original playback stream while materialized clips remain references", () => {
  const sourceClip: VideoMasterClip = {
    ...uploadedClip,
    origin: "source",
    sourceNodeId: "source-node",
    sourceSegmentId: "scene-2-segment",
    sourceStart: 7.061,
    sourceEnd: 13.025,
    sourceClipUrl: "/api/assets/scene-2",
    sourceClipAssetId: "scene-2",
  };
  assert.deepEqual(videoMasterClipPlaybackMedia(sourceClip, "original"), {
    url: "/api/assets/video-1",
    outputUrl: "",
    originalUrl: "/api/assets/video-1",
    usesOutput: false,
    start: 7.061,
    end: 13.025,
    duration: 5.964,
  });
  assert.deepEqual(videoMasterClipDownloadSource(sourceClip, "original"), { url: "/api/assets/video-1", assetId: "video-1" });
  assert.equal(masterClipOriginalReference(sourceClip)?.url, "/api/assets/scene-2");
});

test("full export resolves an original scene from the authoritative source timeline", () => {
  const staleClip: VideoMasterClip = {
    ...uploadedClip,
    origin: "source",
    sourceNodeId: "source",
    sourceSegmentId: "segment-2",
    sourceStart: 0,
    sourceEnd: 7,
  };
  const source = {
    id: "source",
    type: "frameNode",
    position: { x: 0, y: 0 },
    data: {
      kind: "source",
      title: "Source",
      assetId: "authoritative-video",
      imageUrl: "/api/assets/authoritative-video",
      videoSegments: [{ id: "segment-2", index: 2, label: "Scene 02", role: "scene", start: 7.061, end: 13.025, confidence: 1 }],
    },
  } as FrameNode;

  assert.deepEqual(videoMasterClipExportMedia(staleClip, "original", source), {
    source: { url: "/api/assets/authoritative-video", assetId: "authoritative-video" },
    start: 7.061,
    end: 13.025,
  });
});

test("legacy masters inherit materialized playback clips from their source scenes", () => {
  const source = {
    id: "source",
    type: "frameNode",
    position: { x: 0, y: 0 },
    data: {
      kind: "source",
      title: "Source",
      videoSegments: [{ id: "segment-2", index: 2, label: "Scene 02", role: "scene", start: 7, end: 13, confidence: 1, clipAssetId: "asset-2", clipUrl: "/api/assets/asset-2", thumbnailUrl: "/api/assets/scene-2-frame" }],
    },
  } as FrameNode;
  const master = {
    id: "master",
    type: "frameNode",
    position: { x: 100, y: 0 },
    data: {
      kind: "videoMaster",
      title: "Video Master",
      videoMasterClips: [{ id: "clip-2", title: "Scene 02", role: "scene", origin: "source", duration: 6, prompt: "", sourceNodeId: "source", sourceSegmentId: "segment-2", sourceStart: 7, sourceEnd: 13, sourceUrl: "/api/assets/source" }],
    },
  } as FrameNode;
  const hydrated = hydrateVideoMasterSourceClips([source, master]);
  assert.deepEqual(hydrated[1].data.videoMasterClips?.[0], {
    ...master.data.videoMasterClips?.[0],
    sourceClipAssetId: "asset-2",
    sourceClipUrl: "/api/assets/asset-2",
    thumbnailUrl: "/api/assets/scene-2-frame",
  });
});

test("uploaded clips always expose one static thumbnail source for the timeline and blur", () => {
  assert.equal(videoMasterClipThumbnail(uploadedClip, "output"), "/api/assets/video-1?variant=thumbnail&delivery=direct&v=3");
  assert.equal(videoMasterClipThumbnail({ ...uploadedClip, thumbnailUrl: "/api/assets/video-1?variant=thumbnail" }, "output"), "/api/assets/video-1?variant=thumbnail&delivery=direct&v=3");
  assert.equal(videoMasterClipThumbnail({ ...uploadedClip, origin: "source", outputUrl: "/api/assets/generated-1" }, "output"), "/api/assets/generated-1?variant=thumbnail&delivery=direct&v=3");
  assert.equal(videoMasterClipThumbnail({ ...uploadedClip, origin: "generated", outputUrl: "/api/assets/generated-1", generatedOutputs: [{ url: "/api/assets/generated-1", thumbnailUrl: "/api/assets/generated-poster" }] }, "output"), "/api/assets/generated-poster?variant=thumbnail&delivery=direct&v=3");
});

test("physical metadata repairs uploaded and legacy standalone durations without changing real source trims", () => {
  const uploadedPlayback = videoMasterClipPlaybackMedia(uploadedClip, "output");
  assert.equal(reconciledVideoMasterClipDuration(uploadedClip, uploadedPlayback, 3.041667), 3.041667);

  const legacyStandalone: VideoMasterClip = { ...uploadedClip, origin: "source", sourceStart: 0, sourceEnd: 5 };
  const legacyPlayback = videoMasterClipPlaybackMedia(legacyStandalone, "original");
  assert.equal(reconciledVideoMasterClipDuration(legacyStandalone, legacyPlayback, 3.041667), 3.041667);

  const sourceTrim: VideoMasterClip = { ...legacyStandalone, sourceSegmentId: "segment-1", sourceStart: 0, sourceEnd: 5 };
  assert.equal(reconciledVideoMasterClipDuration(sourceTrim, videoMasterClipPlaybackMedia(sourceTrim, "original"), 13), undefined);
});

test("a generated OUTPUT follows the physical provider file instead of a requested duration", () => {
  const generated: VideoMasterClip = {
    ...uploadedClip,
    origin: "source",
    duration: 7.1,
    sourceSegmentId: "segment-1",
    sourceStart: 0,
    sourceEnd: 7.1,
    outputUrl: "/api/assets/kling-output",
    generatedDuration: 7.1,
  };
  const outputPlayback = videoMasterClipPlaybackMedia(generated, "output");
  assert.equal(reconciledVideoMasterGeneratedDuration(generated, outputPlayback, 6.4), 6.4);
  assert.equal(reconciledVideoMasterGeneratedDuration(generated, outputPlayback, 8), 8);
  assert.equal(reconciledVideoMasterGeneratedDuration(generated, videoMasterClipPlaybackMedia(generated, "original"), 6.4), undefined);
});

test("Video Master download choices distinguish ORIGINAL and OUTPUT lanes", () => {
  const clips: VideoMasterClip[] = [
    { id: "scene-1", sequenceIndex: 0, title: "Scene 01", role: "hook", origin: "source", duration: 5, prompt: "", sourceUrl: "/api/assets/source-1", sourceAssetId: "source-1", outputUrl: "/api/assets/output-1", outputAssetId: "output-1" },
    { id: "scene-2", sequenceIndex: 1, title: "Scene 02", role: "scene", origin: "source", duration: 5, prompt: "", sourceUrl: "/api/assets/source-2", sourceAssetId: "source-2" },
  ];

  assert.deepEqual(videoMasterClipDownloadSource(clips[0], "original"), { url: "/api/assets/source-1", assetId: "source-1" });
  assert.deepEqual(videoMasterClipDownloadSource(clips[0], "output"), { url: "/api/assets/output-1", assetId: "output-1" });
  assert.deepEqual(videoMasterDownloadAvailability(clips, "original", "scene-2"), { selected: true, all: true, availableCount: 2, totalCount: 2 });
  assert.deepEqual(videoMasterDownloadAvailability(clips, "output", "scene-2"), { selected: false, all: false, availableCount: 1, totalCount: 2 });
});

test("an exact source segment is downloadable before its clipped asset is materialized", () => {
  const clip: VideoMasterClip = { id: "scene-1", sequenceIndex: 0, title: "Scene 01", role: "hook", origin: "source", duration: 4, prompt: "", sourceNodeId: "source", sourceSegmentId: "segment" };
  assert.equal(videoMasterClipDownloadSource(clip, "original"), undefined);
  assert.deepEqual(videoMasterDownloadAvailability([clip], "original", clip.id), { selected: true, all: true, availableCount: 1, totalCount: 1 });
});

test("export removes artificial cuts between contiguous scenes from one source", () => {
  assert.deepEqual(coalesceContiguousVideoAssets([
    { id: "source", start: 0, end: 7.061 },
    { id: "source", start: 7.061, end: 13.025 },
    { id: "upload", start: 0, end: 5 },
  ]), [
    { id: "source", start: 0, end: 13.025 },
    { id: "upload", start: 0, end: 5 },
  ]);
});

test("export preserves intentional repeats and non-contiguous source cuts", () => {
  assert.deepEqual(coalesceContiguousVideoAssets([
    { id: "source", start: 0, end: 4 },
    { id: "source", start: 8, end: 12 },
    { id: "source", start: 0, end: 4 },
  ]).length, 3);
});

test("all full-video export lanes accept UUID and legacy project ids", () => {
  const assets = [
    { id: "21174950-5b27-478f-84b0-8b7667cb35e3", start: 0, end: 13.025 },
    { id: "8db3b928-22b9-4b28-ace1-865d192896f7", start: 0, end: 3.041667 },
  ];
  for (const projectId of ["6ec55f01-88b6-49ce-8a72-0324ea7daf34", "qa-video-master-prod-20260812"]) {
    for (const lane of ["original", "output"]) {
      assert.equal(videoMasterExportRequestSchema.safeParse({ projectId, filename: `video-master-${lane}`, assets }).success, true);
    }
  }
});

test("Video Master generation duration rounds up without changing the timeline duration", () => {
  const clip: VideoMasterClip = { ...uploadedClip, duration: 3 };
  const model = { mediaType: "video" as const, durations: ["4", "5", "8"], defaultDuration: "5" };
  assert.equal(videoMasterGenerationDuration(model, clip), 4);
  assert.equal(clip.duration, 3);
  assert.equal(videoMasterClipPlaybackMedia({ ...clip, outputUrl: "/api/assets/generated" }, "output").duration, 3);
});

test("Video Master honors a longer generation and resolves a vertical Original ratio", () => {
  const clip: VideoMasterClip = { ...uploadedClip, duration: 3, generationDuration: 8 };
  const model = { mediaType: "video" as const, durations: ["4", "5", "8"], defaultDuration: "5" };
  assert.equal(videoMasterGenerationDuration(model, clip), 8);
  assert.equal(nearestVideoMasterRatio(9 / 16, ["16:9", "9:16", "1:1"]), "9:16");
});

test("Video Master honors a shorter explicit generation and trims only the generated output lane", () => {
  const clip: VideoMasterClip = { ...uploadedClip, origin: "source", duration: 7.043, sourceSegmentId: "segment-1", sourceStart: 0, sourceEnd: 7.043, generationDuration: 6 };
  const model = { mediaType: "video" as const, durations: ["4", "5", "6", "8"], defaultDuration: "5" };
  assert.equal(videoMasterTimelineDuration(clip), 7.043);
  assert.equal(videoMasterGenerationDuration(model, clip), 6);
  assert.equal(videoMasterClipPlaybackMedia({ ...clip, outputUrl: "/api/assets/generated", generatedDuration: 6 }, "output").duration, 6);
  assert.equal(videoMasterClipPlaybackMedia(clip, "original").duration, 7.043);
});

test("Kling Motion Control inherits the exact selected scene range without a separate duration control", () => {
  const model = { mediaType: "video" as const, durationSource: "reference-video" as const };
  const scene: VideoMasterClip = { ...uploadedClip, origin: "source", duration: 7.1, sourceSegmentId: "segment-1", sourceStart: 12.4, sourceEnd: 19.5 };
  assert.equal(videoMasterGenerationDuration(model, scene), 7.1);
  assert.equal(videoMasterGenerationDuration(model, { ...scene, generationDuration: 6 }), 7.1);
  assert.deepEqual(videoMasterGenerationDurationChoices(model, scene), []);
  assert.equal(videoMasterTimelineDuration(scene), 7.1);
});

test("legacy generated-duration edits cannot override an exact source segment range", () => {
  const clip: VideoMasterClip = { ...uploadedClip, origin: "source", duration: 8, sourceSegmentId: "segment-1", sourceStart: 0, sourceEnd: 7.061 };
  const model = { mediaType: "video" as const, durations: ["4", "5", "6", "7", "8"], defaultDuration: "5" };
  assert.equal(videoMasterTimelineDuration(clip), 7.061);
  assert.equal(videoMasterGenerationDuration(model, clip), 8);
  assert.equal(videoMasterClipPlaybackMedia({ ...clip, outputUrl: "/api/assets/generated" }, "output").duration, 7.061);
});
