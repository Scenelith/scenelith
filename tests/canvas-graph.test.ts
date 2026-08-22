import assert from "node:assert/strict";
import test from "node:test";
import { duplicateGraphSelection, generatorInputCapacity, generatorSourceAssetIds, normalizeEdgePorts, selectGraphNode, stableGraphNodes, upsertGraphEdge } from "../src/lib/canvas-graph";
import type { FrameEdge, FrameNode } from "../src/lib/types";

function node(id: string, kind: FrameNode["data"]["kind"], data: Partial<FrameNode["data"]> = {}, x = 0): FrameNode {
  return { id, type: "frameNode", position: { x, y: 0 }, data: { kind, title: id, ...data } } as FrameNode;
}

test("saved graph nodes exclude transient React Flow measurements and interaction state", () => {
  const input = { ...node("scene-1", "scene"), measured: { width: 320, height: 480 }, selected: true, dragging: true, resizing: true } as FrameNode;
  const [stable] = stableGraphNodes([input]);
  assert.equal("measured" in stable, false);
  assert.equal("selected" in stable, false);
  assert.equal("dragging" in stable, false);
  assert.equal("resizing" in stable, false);
});

test("exclusive live selection transfers to a newly imported editor", () => {
  const previous = { ...node("previous", "videoMaster"), selected: true } as FrameNode;
  const importedCard = node("source-card", "source");
  const importedTimeline = node("source-timeline", "source", { mediaType: "video" });

  const selected = selectGraphNode([previous, importedCard, importedTimeline], importedTimeline.id);

  assert.deepEqual(selected.map((item) => [item.id, Boolean(item.selected)]), [
    ["previous", false],
    ["source-card", false],
    ["source-timeline", true],
  ]);
  assert.equal(stableGraphNodes(selected).some((item) => "selected" in item), false);
});

test("edit references stay saved per image without becoming generator attachments", () => {
  const input = node("editable", "prompt", {
    assetId: "source-asset",
    editReferencesByAssetId: {
      "source-asset": [{
        assetId: "supporting-asset",
        url: "/api/assets/supporting-asset",
        title: "Olivia · After 01",
        origin: "identity",
        detail: "After identity reference",
      }],
    },
  });
  const [stable] = stableGraphNodes([input]);
  assert.equal(stable.data.editReferencesByAssetId?.["source-asset"]?.[0]?.assetId, "supporting-asset");
  assert.equal(stable.data.attachedReferences, undefined);
  assert.equal(stable.data.referenceAssetIds, undefined);
});

test("edge hydration is idempotent and repairs missing TikTok lineage", () => {
  const nodes = [
    node("source", "source"),
    node("scene-1", "scene", {}, 100),
    node("scene-2", "scene", {}, 200),
    node("generated-2", "prompt", {
      automationKind: "tiktok-slideshow",
      automationSourceNodeId: "source",
      automationSlideIndex: 2,
    }),
  ];
  const edges: FrameEdge[] = [
    { id: "source-1", source: "source", target: "scene-1", sourceHandle: "output", targetHandle: "input" },
    { id: "source-2", source: "source", target: "scene-2", sourceHandle: "output", targetHandle: "input" },
  ];
  const first = normalizeEdgePorts(edges, nodes);
  const repaired = first.find((edge) => edge.target === "generated-2");
  assert.equal(repaired?.source, "scene-2");
  assert.equal(repaired?.targetHandle, "reference-image-input");
  assert.equal(repaired?.data?.automationKind, "tiktok-slideshow");

  const second = normalizeEdgePorts(first.map((edge) => edge.id === repaired?.id
    ? { ...edge, className: "is-automation-lineage-edge is-automation-lineage-edge" }
    : edge), nodes);
  assert.equal(second.length, first.length);
  assert.equal(second.find((edge) => edge.target === "generated-2")?.className, "is-automation-lineage-edge");
});

test("legacy quick-create and manual connections collapse into one canonical generator edge", () => {
  const nodes = [node("source", "scene"), node("generator", "prompt")];
  const edges: FrameEdge[] = [
    { id: "quick", source: "source", sourceHandle: "output", target: "generator", targetHandle: "image-input", animated: true, data: { portType: "image" } },
    { id: "manual", source: "source", sourceHandle: "output", target: "generator", targetHandle: "reference-image-input", animated: true, data: { portType: "image", inputRole: "reference-image" } },
  ];
  const normalized = normalizeEdgePorts(edges, nodes);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].targetHandle, "reference-image-input");
  assert.equal(normalized[0].data?.inputRole, "reference-image");
});

test("generator output handles stay stable and legacy visual handles collapse after reload", () => {
  const nodes = [
    node("generated", "prompt", { mediaType: "image" }),
    node("next", "prompt", { mediaType: "image" }),
  ];
  const normalized = normalizeEdgePorts([
    {
      id: "legacy-quick",
      source: "generated",
      sourceHandle: "output",
      target: "next",
      targetHandle: "reference-image-input",
      data: { portType: "image", inputRole: "reference-image" },
    },
    {
      id: "manual",
      source: "generated",
      sourceHandle: "image-output",
      target: "next",
      targetHandle: "reference-image-input",
      data: { portType: "image", inputRole: "reference-image" },
    },
  ], nodes);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].sourceHandle, "output");
  assert.deepEqual(normalizeEdgePorts(normalized, nodes), normalized);
});

test("graph edge upsert prevents duplicate connections and remains stable after reload", () => {
  const nodes = [node("source", "scene"), node("generator", "prompt")];
  const created = upsertGraphEdge([], nodes, {
    id: "quick",
    source: "source",
    sourceHandle: "output",
    target: "generator",
    targetHandle: "reference-image-input",
    animated: true,
    data: { portType: "image", inputRole: "reference-image" },
  });
  const reconnected = upsertGraphEdge(created, nodes, {
    id: "manual",
    source: "source",
    sourceHandle: "output",
    target: "generator",
    targetHandle: "reference-image-input",
    animated: true,
    data: { portType: "image", inputRole: "reference-image" },
  }, { replaceTargetInput: true });
  assert.equal(reconnected.length, 1);
  assert.deepEqual(normalizeEdgePorts(reconnected, nodes), reconnected);
});

test("image generator reference capacity comes from maxReferences when ports are synthetic", () => {
  assert.equal(generatorInputCapacity({ mediaType: "image", maxReferences: 14 }, "reference-image"), 14);
  assert.equal(generatorInputCapacity({ mediaType: "image", maxReferences: 0 }, "reference-image"), 0);
  assert.equal(generatorInputCapacity({
    mediaType: "video",
    maxReferences: 15,
    inputPorts: [{ id: "reference-image", max: 9 }],
  }, "reference-image"), 9);
  assert.equal(generatorInputCapacity({
    mediaType: "video",
    maxReferences: 2,
    inputPorts: [{ id: "start-frame", max: 1 }],
  }, "start-frame"), 1);
});

test("two image nodes remain connected to a multi-reference image generator", () => {
  const nodes = [
    node("image-1", "scene", { mediaType: "image" }),
    node("image-2", "scene", { mediaType: "image" }),
    node("generator", "prompt", { mediaType: "image", modelId: "nano-banana-2" }),
  ];
  const capacity = generatorInputCapacity({ mediaType: "image", maxReferences: 14 }, "reference-image");
  const first = upsertGraphEdge([], nodes, {
    id: "image-edge-1",
    source: "image-1",
    sourceHandle: "output",
    target: "generator",
    targetHandle: "reference-image-input",
    data: { portType: "image", inputRole: "reference-image" },
  }, { replaceTargetInput: capacity <= 1 });
  const both = upsertGraphEdge(first, nodes, {
    id: "image-edge-2",
    source: "image-2",
    sourceHandle: "output",
    target: "generator",
    targetHandle: "reference-image-input",
    data: { portType: "image", inputRole: "reference-image" },
  }, { replaceTargetInput: capacity <= 1 });

  assert.equal(both.length, 2);
  assert.deepEqual(both.map((edge) => edge.source), ["image-1", "image-2"]);
  assert.deepEqual(normalizeEdgePorts(both, nodes), both);
});

test("a generated image exposes only its current output instead of hidden input provenance", () => {
  const generated = node("generated", "prompt", {
    assetId: "current-output",
    referenceAssetIds: ["old-input-1", "old-input-2"],
  });
  const persona = node("persona", "persona", {
    assetId: "persona-cover",
    referenceAssetIds: ["identity-1", "identity-2"],
  });

  assert.deepEqual(generatorSourceAssetIds(generated), ["current-output"]);
  assert.deepEqual(generatorSourceAssetIds(persona), ["identity-1", "identity-2"]);
});

test("edge hydration preserves non-image generator port types", () => {
  const nodes = [node("video", "prompt", { mediaType: "video" }), node("generator", "prompt")];
  const [edge] = normalizeEdgePorts([{
    id: "video-reference",
    source: "video",
    sourceHandle: "output",
    target: "generator",
    targetHandle: "reference-video-input",
    data: { portType: "video", inputRole: "reference-video" },
  }], nodes);
  assert.equal(edge.data?.portType, "video");
  assert.equal(edge.data?.inputRole, "reference-video");
  assert.equal(edge.sourceHandle, "output");
  assert.equal(edge.targetHandle, "reference-video-input");
});

test("video timeline segment handles and exact clip metadata survive reload", () => {
  const nodes = [
    node("timeline", "source", { mediaType: "video" }),
    node("generator", "prompt", { mediaType: "video" }),
  ];
  const [edge] = normalizeEdgePorts([{
    id: "segment-reference",
    source: "timeline",
    sourceHandle: "segment-output:scene-02",
    target: "generator",
    targetHandle: "reference-video-input",
    data: {
      portType: "video",
      inputRole: "reference-video",
      sourceSegmentId: "scene-02",
      sourceSegmentStart: 4.033,
      sourceSegmentEnd: 7.067,
      sourceSegmentLabel: "Scene 02",
      clipAssetId: "clip-asset",
    },
  }], nodes);
  assert.equal(edge.sourceHandle, "segment-output:scene-02");
  assert.equal(edge.data?.sourceSegmentId, "scene-02");
  assert.equal(edge.data?.sourceSegmentStart, 4.033);
  assert.equal(edge.data?.sourceSegmentEnd, 7.067);
  assert.deepEqual(normalizeEdgePorts([edge], nodes), [edge]);
});

test("multiple timeline segments can feed the same multi-reference video input", () => {
  const nodes = [
    node("timeline", "source", { mediaType: "video" }),
    node("generator", "prompt", { mediaType: "video" }),
  ];
  const first = upsertGraphEdge([], nodes, {
    id: "segment-1",
    source: "timeline",
    sourceHandle: "segment-output:scene-01",
    target: "generator",
    targetHandle: "reference-video-input",
    data: { portType: "video", inputRole: "reference-video", sourceSegmentId: "scene-01" },
  }, { replaceTargetInput: false });
  const both = upsertGraphEdge(first, nodes, {
    id: "segment-2",
    source: "timeline",
    sourceHandle: "segment-output:scene-02",
    target: "generator",
    targetHandle: "reference-video-input",
    data: { portType: "video", inputRole: "reference-video", sourceSegmentId: "scene-02" },
  }, { replaceTargetInput: false });
  assert.equal(both.length, 2);
  assert.deepEqual(both.map((edge) => edge.sourceHandle), ["segment-output:scene-01", "segment-output:scene-02"]);
});

test("video master keeps identical model inputs isolated per scene after reload", () => {
  const nodes = [
    node("timeline", "source", { mediaType: "video" }),
    node("master", "videoMaster", { mediaType: "video" }),
  ];
  const normalized = normalizeEdgePorts([
    {
      id: "master-scene-1",
      source: "timeline",
      sourceHandle: "segment-output:scene-01",
      target: "master",
      targetHandle: "master:clip-01:reference-video-input",
      data: { portType: "video", inputRole: "reference-video", masterClipId: "clip-01", sourceSegmentId: "scene-01" },
    },
    {
      id: "master-scene-2",
      source: "timeline",
      sourceHandle: "segment-output:scene-02",
      target: "master",
      targetHandle: "master:clip-02:reference-video-input",
      data: { portType: "video", inputRole: "reference-video", masterClipId: "clip-02", sourceSegmentId: "scene-02" },
    },
  ], nodes);

  assert.equal(normalized.length, 2);
  assert.deepEqual(normalized.map((edge) => edge.data?.masterClipId), ["clip-01", "clip-02"]);
  assert.deepEqual(normalizeEdgePorts(normalized, nodes), normalized);
});

test("video master drops its obsolete generic input edge after hydration", () => {
  const nodes = [
    node("timeline", "source", { mediaType: "video" }),
    node("master", "videoMaster", { mediaType: "video" }),
  ];
  const normalized = normalizeEdgePorts([
    {
      id: "legacy-master-input",
      source: "timeline",
      sourceHandle: "video-output",
      target: "master",
      targetHandle: "video-master-input",
      data: { portType: "video", inputRole: "reference-video" },
    },
    {
      id: "master-scene-input",
      source: "timeline",
      sourceHandle: "segment-output:scene-01",
      target: "master",
      targetHandle: "master:clip-01:reference-video-input",
      data: { portType: "video", inputRole: "reference-video", masterClipId: "clip-01", sourceSegmentId: "scene-01" },
    },
  ], nodes);

  assert.equal(normalized.some((edge) => edge.targetHandle === "video-master-input"), false);
  assert.equal(normalized.some((edge) => edge.targetHandle === "master:clip-01:reference-video-input"), true);
});

test("full timeline video keeps its single semantic output after hydration", () => {
  const nodes = [
    node("timeline", "source", { mediaType: "video", videoSegments: [{ id: "scene-01", index: 1, label: "Scene 01", role: "hook", start: 0, end: 4, confidence: 1 }] }),
    node("generator", "prompt", { mediaType: "video" }),
  ];
  const [edge] = normalizeEdgePorts([{
    id: "full-video",
    source: "timeline",
    sourceHandle: "output",
    target: "generator",
    targetHandle: "reference-video-input",
    data: { portType: "video", inputRole: "reference-video" },
  }], nodes);

  assert.equal(edge.sourceHandle, "video-output");
  assert.equal(edge.targetHandle, "reference-video-input");
  assert.deepEqual(normalizeEdgePorts([edge], nodes), [edge]);
});

test("TikTok metadata source stays connected to its video timeline after graph hydration", () => {
  const nodes = [
    node("tiktok-card", "source"),
    node("video-timeline", "source", { mediaType: "video", videoDurationSeconds: 13 }),
  ];
  const normalized = normalizeEdgePorts([{
    id: "tiktok-video",
    source: "tiktok-card",
    sourceHandle: "output",
    target: "video-timeline",
    targetHandle: "input",
    data: { portType: "video" },
  }], nodes);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].sourceHandle, "output");
  assert.equal(normalized[0].targetHandle, "input");
  assert.equal(normalized[0].data?.portType, "video");
  assert.deepEqual(normalizeEdgePorts(normalized, nodes), normalized);
});

test("duplicate selection offsets nodes, preserves internal edges, and drops automation lineage", () => {
  const nodes = [
    node("source", "scene", {}, 100),
    node("generated", "prompt", {
      automationKind: "tiktok-slideshow",
      automationSourceNodeId: "source-slideshow",
      automationSlideIndex: 1,
    }, 300),
    node("outside", "note", {}, 700),
  ];
  const edges: FrameEdge[] = [
    { id: "inside", source: "source", target: "generated" },
    { id: "outside", source: "generated", target: "outside" },
  ];
  let id = 0;
  const duplicated = duplicateGraphSelection(nodes, edges, ["source", "generated"], (prefix) => `${prefix}-copy-${++id}`, { x: 40, y: 60 });

  assert.equal(duplicated.nodes.length, 2);
  assert.equal(duplicated.edges.length, 1);
  assert.deepEqual(duplicated.nodes.map((item) => item.position), [{ x: 140, y: 60 }, { x: 340, y: 60 }]);
  assert.equal(duplicated.edges[0].source, duplicated.nodes[0].id);
  assert.equal(duplicated.edges[0].target, duplicated.nodes[1].id);
  assert.equal(duplicated.nodes[1].data.automationKind, undefined);
  assert.equal(duplicated.nodes[1].data.automationSourceNodeId, undefined);
  assert.equal(duplicated.nodes[1].data.automationSlideIndex, undefined);
});
