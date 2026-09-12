import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ReactFlow, type NodeTypes } from "@xyflow/react";
import { FrameNodeCard, GeneratorNodeContext, type GeneratorNodeActions } from "../../../src/components/FrameNode";
import { newKieModels } from "../../../src/lib/kie-new-models";
import type { ProjectGraph } from "../../../src/lib/types";

const nodeTypes: NodeTypes = { frameNode: FrameNodeCard };
const thumbnail = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="90" height="160"><rect width="90" height="160" fill="%23495547"/></svg>';
const noop = () => {};
function Fixture() {
  const [videoReference, setVideoReference] = useState(false);
  const [graph, setGraph] = useState<ProjectGraph>({ nodes: [{ id: "image", type: "frameNode", selected: true, position: { x: 100, y: 100 }, data: { kind: "prompt", title: "Image", modelId: "gpt-image-2-5-flare", aspectRatio: "1:1", resolution: "1K", duration: "5", mediaType: "image", prompt: "Portrait", status: "idle" } }], edges: [] });
  const updateNode: GeneratorNodeActions["updateNode"] = (id, data) => setGraph((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === id ? { ...node, data: { ...node.data, ...data } } : node) }));
  const choose = (id: string) => { const model = newKieModels.find((m) => m.id === id)!; setVideoReference(false); updateNode("image", { modelId: id, mediaType: model.mediaType, aspectRatio: model.defaultRatio as never, resolution: model.defaultResolution as never, duration: model.defaultDuration || "5" }); };
  const actions: GeneratorNodeActions = {
    models: newKieModels,
    personas: [], selectNode: noop, focusMasterClipSource: noop, updateNode, saveNow: noop,
    composePrompt: async () => "", composeMasterPrompt: async () => "", generateNode: noop, generateMasterClip: noop,
    updateMasterClipModel: noop, removeMasterClip: noop, uploadMasterClips: noop, runAssistant: noop, generateChain: noop,
    captureVideoFrame: async () => {}, extractVideoSegment: noop, openPreview: noop, downloadMasterMedia: async () => false,
    openEdit: noop, addToIdentity: async () => ({}), createIdentityFromAsset: async () => {}, deleteNode: noop,
    hasDownstreamGenerator: () => false, disconnectReference: noop, getReferences: () => videoReference ? [{ id: "video", url: thumbnail, title: "Reference video", role: "reference-video", durationSeconds: 5, assetId: "video" }] : [], getTextInput: () => null,
    generatingNodeIds: [], preparingMasterClipIds: {}, generationConcurrency: 1, queueLabel: "test", runningAssistantNodeId: null, activePreviewNodeId: null,
  };
  return <>
    <button onClick={() => choose("gpt-image-2-5-flare")}>Images</button>
    <button onClick={() => choose("pixverse-v6-text")}>PixVerse</button>
    <button onClick={() => choose("gemini-omni-flash-1-1")}>Omni</button>
    <button onClick={() => setVideoReference((v) => !v)}>Toggle video reference</button>
    <div style={{ width: 1500, height: 1500 }}><GeneratorNodeContext.Provider value={actions}>
      <ReactFlow nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} defaultViewport={{ x: 220, y: 20, zoom: .5 }} />
    </GeneratorNodeContext.Provider></div>
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
