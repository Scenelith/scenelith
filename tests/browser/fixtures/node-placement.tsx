import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ReactFlow, type NodeTypes } from "@xyflow/react";
import { FrameNodeCard, GeneratorNodeContext, type GeneratorNodeActions } from "../../../src/components/FrameNode";
import { placeChangedCanvasNodes } from "../../../src/lib/canvas-node-placement";
import type { FrameNode, ProjectGraph } from "../../../src/lib/types";

const nodeTypes: NodeTypes = { frameNode: FrameNodeCard };
const thumbnail = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="90" height="160"><rect width="90" height="160" fill="%23495547"/></svg>';
const noop = () => {};
function Fixture() {
  const [graph, setGraph] = useState<ProjectGraph>({ nodes: [], edges: [] });
  const updateNode: GeneratorNodeActions["updateNode"] = (id, data) => setGraph((current) => placeChangedCanvasNodes(current, { ...current, nodes: current.nodes.map((node) => node.id === id ? { ...node, data: { ...node.data, ...data } } : node) }));
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
    <button onClick={() => setGraph((current) => {
      const nodes: FrameNode[] = Array.from({ length: 4 }, (_, index) => ({ id: `image-${index}`, type: "frameNode", position: { x: 200, y: 160 + index * 430 }, data: { kind: "prompt", title: `Image ${index}`, nodeNumber: index + 1, modelId: "nano-banana-2", aspectRatio: "1:1", resolution: "1K", prompt: "Create a natural photo avatar using the person in the reference.", status: "idle" } }));
      return placeChangedCanvasNodes(current, { nodes, edges: [] });
    })}>Create column</button>
    <button onClick={() => updateNode("image-1", { aspectRatio: "9:16" })}>Make portrait</button>
    <button onClick={() => updateNode("image-1", { outputUrl: thumbnail, generatedOutputs: [{ url: thumbnail, mediaType: "image" }] })}>Add result</button>
    <div style={{ width: 1500, height: 1500 }}><GeneratorNodeContext.Provider value={actions}>
      <ReactFlow nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} defaultViewport={{ x: 220, y: 20, zoom: .5 }} />
    </GeneratorNodeContext.Provider></div>
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
