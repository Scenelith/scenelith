import {createRoot} from 'react-dom/client';
import {MediaViewer} from '../../../src/components/MediaViewer';
import type {FrameNode} from '../../../src/lib/types';
const prompt=('A ceramic mug on a blue background. Soft lighting, realistic texture.\n').repeat(16)+'The last sentence must remain readable.';
const kind=new URLSearchParams(window.location.search).get('kind')==='video'?'video':'image';
const node:FrameNode={id:'sample',type:'generator',position:{x:0,y:0},data:{kind:'generation',title:'Image GEN',mediaType:kind,aspectRatio:'16:9',assetId:'sample',outputUrl:'/api/assets/sample',prompt}};
createRoot(document.getElementById('root')!).render(<MediaViewer projectId="fixture" node={node} url="/api/assets/sample" mediaTitle={prompt} references={[]} editCanvasReferences={[]} editPersonas={[]} identities={[]} initialEditReferences={[]} models={[]} createdAt="2026-10-10" projectName="Studio" canvasName="Image GEN" initialMode="view" onClose={()=>{}} onCreateEdit={async()=>{throw new Error('No generation');}} onRefineEdit={async()=>''} onUploadEditReferences={async()=>[]} onEditReferencesChange={()=>{}} onAddToIdentity={async()=>({})} onCreateIdentityFromAsset={async()=>{}}/>);
