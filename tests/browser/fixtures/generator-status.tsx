import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ReactFlow, type NodeTypes } from "@xyflow/react";
import { FrameNodeCard, GeneratorNodeContext, type GeneratorNodeActions } from "../../../src/components/FrameNode";
import { restoreGeneratorTask } from "../../../src/lib/generator-task-state";
import type { BackgroundTaskRecord, ProjectGraph } from "../../../src/lib/types";

const nodeTypes: NodeTypes = { frameNode: FrameNodeCard };
const thumbnail = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="90" height="160"><rect width="90" height="160" fill="%23495547"/></svg>';
const noop = () => {};
function Fixture() {
  const [graph, setGraph] = useState<ProjectGraph>({ nodes: [{ id: "image", type: "frameNode", position: { x: 100, y: 100 }, data: { kind: "prompt", title: "Image", modelId: "nano-banana-2", aspectRatio: "1:1", prompt: "Portrait", status: "idle" } }], edges: [] });
  const updateNode: GeneratorNodeActions["updateNode"] = (id, data) => setGraph((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === id ? { ...node, data: { ...node.data, ...data } } : node) }));
  const apply = (status: BackgroundTaskRecord["status"], minute: number) => {
    const task: BackgroundTaskRecord = { id: `attempt-${minute}`, kind: "generation", projectId: "p", projectName: "P", nodeId: "image", title: "Image", status, stageLabel: status, progress: 100,
      createdAt: `2026-09-08T10:${minute}:00Z`, updatedAt: "2026-09-08T11:00:00Z", outputUrl: status === "completed" ? thumbnail : null, mediaType: "image", modelId: "nano-banana-2", error: status === "failed" ? "Failure" : null };
    setGraph((current) => ({ ...current, nodes: current.nodes.map((node) => restoreGeneratorTask(node, task)) }));
  };
  const actions: GeneratorNodeActions = {
    models: [{ id: "nano-banana-2", label: "Fixture", mediaType: "image", description: "", maxReferences: 1, ratios: ["1:1", "9:16", "16:9"], resolutions: ["1K"] }],
    personas: [], selectNode: noop, focusMasterClipSource: noop, updateNode, saveNow: noop,
    composePrompt: async () => "", composeMasterPrompt: async () => "", generateNode: noop, generateMasterClip: noop,
    updateMasterClipModel: noop, removeMasterClip: noop, uploadMasterClips: noop, runAssistant: noop, generateChain: noop,
    captureVideoFrame: async () => {}, extractVideoSegment: noop, openPreview: noop, downloadMasterMedia: async () => false,
    openEdit: noop, addToIdentity: async () => ({}), createIdentityFromAsset: async () => {}, deleteNode: noop,
    hasDownstreamGenerator: () => false, disconnectReference: noop, getReferences: () => [], getTextInput: () => null,
    generatingNodeIds: [], preparingMasterClipIds: {}, generationConcurrency: 1, queueLabel: "test", runningAssistantNodeId: null, activePreviewNodeId: null,
  };
  return <>
    <button onClick={() => apply("failed", 10)}>Old failure</button>
    <button onClick={() => apply("completed", 20)}>New success</button>
    <button onClick={() => apply("queued", 30)}>New attempt</button>
    <button onClick={() => apply("failed", 30)}>New failure</button>
    <div style={{ width: 1500, height: 1500 }}><GeneratorNodeContext.Provider value={actions}>
      <ReactFlow nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} defaultViewport={{ x: 220, y: 20, zoom: .5 }} />
    </GeneratorNodeContext.Provider></div>
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
