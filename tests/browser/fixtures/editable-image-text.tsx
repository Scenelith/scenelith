import { createRoot } from "react-dom/client";
import { useState } from "react";
import { TextOverlayPopover } from "../../../src/components/TextOverlayEditor";
import { MediaViewer } from "../../../src/components/MediaViewer";
import { saveTextOverlay } from "../../../src/lib/text-overlay/client";
import type { TextOverlaySettings } from "../../../src/lib/text-overlay/settings";
import type { FrameNode } from "../../../src/lib/types";

function Fixture() {
  const [asset, setAsset] = useState({assetId:'sample',url:'/api/assets/sample'});
  const [editing, setEditing] = useState(false);
  const apply = async (assetId:string,text:string,settings:TextOverlaySettings) => {
    const result = await saveTextOverlay('demo',assetId,text,settings);
    setAsset(result);
  };
  const node: FrameNode = {id:'image-node',type:'frame',position:{x:0,y:0},data:{kind:'prompt',title:'Image Generator 1',mediaType:'image',assetId:asset.assetId,outputUrl:asset.url,status:'ready'}};
  return <div style={{height:'100vh',padding:70,background:'#0e1010',color:'#eee'}}>
    <div className="generator-node-toolbar" style={{position:'relative',width:'fit-content'}}>
      <TextOverlayPopover projectId="demo" assetId={asset.assetId} onApply={apply} onEdit={() => setEditing(true)} />
      <button onClick={() => setEditing(true)}>Edit image</button>
    </div>
    <img src={asset.url} alt="Saved result" style={{height:'65vh',marginTop:24}} />
    {editing && <MediaViewer projectId="demo" onApplyTextOverlay={apply} node={node} url={asset.url} references={[]} editCanvasReferences={[]} editPersonas={[]} identities={[]} initialEditReferences={[]} models={[]} createdAt="2026-09-15" projectName="My App" canvasName="Text overlay" initialMode="edit" onClose={() => setEditing(false)} onCreateEdit={async () => {throw new Error('No paid generations in this fixture');}} onRefineEdit={async () => ''} onUploadEditReferences={async () => []} onEditReferencesChange={() => {}} onAddToIdentity={async () => ({})} onCreateIdentityFromAsset={async () => {}} />}
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
