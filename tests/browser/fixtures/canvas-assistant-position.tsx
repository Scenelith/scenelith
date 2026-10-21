import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ReactFlow, type NodeTypes } from "@xyflow/react";
import { FrameNodeCard, GeneratorNodeContext, type GeneratorNodeActions } from "../../../src/components/FrameNode";
import type { ProjectGraph } from "../../../src/lib/types";
const nodeTypes: NodeTypes = { frameNode: FrameNodeCard };
const noop = () => {};
function Fixture() {
  const params = new URLSearchParams(location.search), master=params.has("master"), zoom=Number(params.get("zoom")||1);
  const [graph, setGraph] = useState<ProjectGraph>({nodes:[{id:"node",type:"frameNode",selected:true,position:{x:100,y:100},data:{
    kind:master?"videoMaster":"prompt", title:master?"Master":"Image", nodeWidth:master?720:560, modelId:"nano-banana-2",aspectRatio:"1:1",prompt:"A long prompt\n".repeat(18), status:"idle",
    ...(master?{videoMasterSelectedClipId:"clip",videoMasterClips:[{id:"clip",title:"Scene 01",role:"scene",origin:"upload",duration:5,prompt:"A long scene prompt\n".repeat(18),modelId:"wan-3"}]}:{}),
  }}],edges:[]});
  const updateNode: GeneratorNodeActions["updateNode"]=(id,data)=>setGraph(current=>({...current,nodes:current.nodes.map(node=>node.id===id?{...node,data:{...node.data,...data}}:node)}));
  const actions: GeneratorNodeActions = {
    models: [{id:"wan-3",label:"Video fixture",mediaType:"video",description:"",maxReferences:1,ratios:["1:1"],resolutions:["720P"],durations:["5"]}, { id: "nano-banana-2", label: "Fixture", mediaType: "image", description: "", maxReferences: 1, ratios: ["1:1", "9:16", "16:9"], resolutions: ["1K"] }],
    personas: [], selectNode: noop, focusMasterClipSource: noop, updateNode, saveNow: noop,
    composePrompt: async () => "", composeMasterPrompt: async () => "", generateNode: noop, generateMasterClip: noop,
    updateMasterClipModel: noop, removeMasterClip: noop, uploadMasterClips: noop, runAssistant: noop, generateChain: noop,
    captureVideoFrame: async () => {}, extractVideoSegment: noop, openPreview: noop, downloadMasterMedia: async () => false,
    openEdit: noop, addToIdentity: async () => ({}), createIdentityFromAsset: async () => {}, deleteNode: noop,
    hasDownstreamGenerator: () => false, disconnectReference: noop, getReferences: () => [], getTextInput: () => null,
    generatingNodeIds: [], preparingMasterClipIds: {}, generationConcurrency: 1, queueLabel: "test", runningAssistantNodeId: null, activePreviewNodeId: null,
  };
  return <div style={{width:"100vw",height:"100vh"}}><GeneratorNodeContext.Provider value={actions}><ReactFlow nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} defaultViewport={{x:200,y:150,zoom}} panOnScroll zoomOnScroll={false}/></GeneratorNodeContext.Provider></div>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
