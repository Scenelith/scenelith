import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {MediaViewer} from '../../../src/components/MediaViewer';
import type {FrameNode} from '../../../src/lib/types';
const source='/api/assets/source';
const connected={assetId:'hair',url:'/api/assets/hair',title:'Hair evidence',origin:'canvas' as const,detail:'Connected image'};
const iris={assetId:'iris',url:'/api/assets/iris',title:'Iris portrait',origin:'identity' as const,detail:'Identity reference',personaId:'iris',variant:'before' as const};
function Fixture(){
 const [calls,setCalls]=useState<unknown[]>([]),[selected,setSelected]=useState<unknown[]>([]);
 const node:FrameNode={id:'node',type:'frame',position:{x:0,y:0},data:{kind:'prompt',title:'Image generator',assetId:'source',outputUrl:source,mediaType:'image',modelId:'nano-banana-2',status:'ready'}};
 return <><MediaViewer node={node} url={source} references={[]} persona={{id:'iris',name:'Iris'}} availableEditReferences={[connected]} editCanvasReferences={[connected]} editPersonas={[{id:'other',name:'Other identity',references:[{...iris,assetId:'other',title:'Other portrait'}]},{id:'iris',name:'Iris',references:[iris]}]} identities={[]} initialEditReferences={[]} models={[{id:'nano-banana-2',label:'Nano Banana',mediaType:'image',description:'Edit',maxReferences:10,ratios:['9:16'],resolutions:['1K'],defaultRatio:'9:16'}]} createdAt="2026-10-22" projectName="Demo" canvasName="Canvas" initialMode="edit" onClose={()=>{}} onCreateEdit={async(prompt,options,references)=>{setCalls(current=>[...current,{kind:'generate',prompt,source:node.data.assetId,references}]);return {url:source,assetId:'source',mediaType:'image'};}} onRefineEdit={async(brief,options,references)=>{setCalls(current=>[...current,{kind:'compose',brief,source:node.data.assetId,references}]);return `Change hair color only on @EditSource using ${references[0]?.title||'the request'}.`;}} onUploadEditReferences={async()=>[]} onEditReferencesChange={setSelected} onAddToIdentity={async()=>({})} onCreateIdentityFromAsset={async()=>{}}/><output id="calls" style={{display:'none'}}>{JSON.stringify(calls)}</output><output id="selected" style={{display:'none'}}>{JSON.stringify(selected)}</output></>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
