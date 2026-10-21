import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {VideoSceneTimeline} from '../../../src/components/VideoSceneTimeline';
import {reconcileGeneratorReferenceChanges} from '../../../src/lib/generator-reference-modes';
import type {ProjectGraph} from '../../../src/lib/types';
const initial:ProjectGraph={nodes:[
 {id:'source',position:{x:0,y:0},data:{kind:'source',title:'Imported video',mediaType:'video',assetId:'original',videoOutputSelection:'full',videoSegments:[
  {id:'one',index:1,label:'Scene 01',role:'hook',confidence:1,start:0,end:3,clipAssetId:'clip-one',clipUrl:'/one.mp4'},
  {id:'two',index:2,label:'Scene 02',role:'cta',confidence:1,start:3,end:8,clipAssetId:'clip-two',clipUrl:'/two.mp4'}]}},
 {id:'generator',position:{x:700,y:0},data:{kind:'prompt',title:'Video generator',mediaType:'video',modelId:'seedance-2-5'}}
],edges:[{id:'ref',source:'source',target:'generator',sourceHandle:'video-output',targetHandle:'reference-video-input',data:{portType:'video',inputRole:'reference-video'}}]};
function Fixture(){
 const [graph,setGraph]=useState(initial),[mount,setMount]=useState(0);
 const update=(data:Record<string,unknown>)=>setGraph(before=>reconcileGeneratorReferenceChanges(before,{...before,nodes:before.nodes.map(n=>n.id==='source'?{...n,data:{...n.data,...data}}:n)}).graph);
 const source=graph.nodes[0];
 return <main style={{width:820,padding:30}}><VideoSceneTimeline key={mount} nodeId="source" title="Imported video" src="https://selection.test/video.mp4" selected segments={source.data.videoSegments!} durationHint={8} outputSelection={String(source.data.videoOutputSelection)} onOutputSelectionChange={videoOutputSelection=>update({videoOutputSelection})} onChange={(videoSegments)=>update({videoSegments})} onOpenPreview={()=>{}} onAspectRatio={()=>{}} onExtractSegment={()=>{}}/>
 <button onClick={()=>setMount(n=>n+1)}>Reopen saved timeline</button><output data-testid="graph">{JSON.stringify(graph)}</output></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
