import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {probeFile,frameBoundaries,quantizeRange} from '../../src/lib/media/probe';
import {planProcessing} from '../../src/lib/media/planner';
import {renderPlan} from '../../src/lib/media/render';
const signal=new AbortController().signal;
function ffmpeg(args:string[]){const r=spawnSync('ffmpeg',['-v','error','-y',...args],{maxBuffer:32*1024*1024});assert.equal(r.status,0,r.stderr.toString());return r.stdout;}
test('real media: unchanged video frames survive audio removal; exact 25fps trim and concatenation decode',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'media-proof-'));
  try{
    const source=join(dir,'source.mp4');
    ffmpeg(['-f','lavfi','-i','testsrc2=s=96x64:r=25:d=2','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=2','-c:v','libx264','-g','50','-c:a','aac','-movflags','+faststart',source]);
    const metadata=await probeFile(source,signal),clip={id:'a',start:0,end:2,metadata};
    const media=new Map([['a',{path:source,metadata}]]);
    const silent=await renderPlan(planProcessing([clip],'none'),media,dir,signal);
    const hashes=(path:string)=>ffmpeg(['-i',path,'-map','0:v','-f','framemd5','-']).toString().split('\n').filter(l=>l&&!l.startsWith('#')).map(l=>l.split(',').at(-1)?.trim());
    assert.deepEqual(hashes(silent),hashes(source));
    assert.equal((await probeFile(silent,signal)).audio,undefined);
    const range=quantizeRange(.281,1.479,await frameBoundaries(source,metadata,signal));
    assert.deepEqual(range,{start:.28,end:1.48});
    const trimmed=await renderPlan(planProcessing([{...clip,...range}],'selected'),media,dir,signal);
    const frames=hashes(trimmed);assert.equal(frames.length,30);
    const probe=await probeFile(trimmed,signal);assert.equal(probe.fps,25);assert.ok(Math.abs(probe.duration-1.2)<.04);
    // Decode output as an independent playback validation.
    ffmpeg(['-i',trimmed,'-f','null','-']);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('copy concat keeps every frame; mixed rates normalize to first source and audio spans joins',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'media-concat-proof-'));
 try{
  const a=join(dir,'a.mp4'),b=join(dir,'b.mp4');
  for(const [path,rate] of [[a,24],[b,30]] as const)ffmpeg(['-f','lavfi','-i',`testsrc2=s=96x64:r=${rate}:d=1`,'-c:v','libx264','-movflags','+faststart',path]);
  const am=await probeFile(a,signal),bm=await probeFile(b,signal);
  const media=new Map([['a',{path:a,metadata:am}],['b',{path:b,metadata:bm}]]);
  const duplicate=planProcessing([{id:'a',start:0,end:1,metadata:am},{id:'a',start:0,end:1,metadata:am}],'none');
  assert.equal(duplicate.video,'copy');
  const copy=await renderPlan(duplicate,media,dir,signal);
  const count=(path:string)=>ffmpeg(['-i',path,'-map','0:v','-f','framemd5','-']).toString().split('\n').filter(l=>l&&!l.startsWith('#')).map(l=>l.split(',').at(-1)?.trim());
  assert.deepEqual(count(copy),[...count(a),...count(a)]);
  const mixed=planProcessing([{id:'a',start:0,end:1,metadata:am},{id:'b',start:0,end:1,metadata:bm}],'none');
  assert.equal(mixed.video,'transcode');
  const result=await renderPlan(mixed,media,dir,signal);
  assert.equal((await probeFile(result,signal)).fps,24);assert.equal(count(result).length,48);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('a VFR fractional cut preserves source frame intervals instead of imposing 30fps',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'media-vfr-proof-'));
 try{
  const source=join(dir,'vfr.mp4');
  ffmpeg(['-f','lavfi','-i','testsrc2=s=96x64:r=25:d=2','-vf',"select='not(mod(n,2))+not(mod(n,3))'",'-fps_mode','vfr','-c:v','libx264',source]);
  const metadata=await probeFile(source,signal);const frames=await frameBoundaries(source,metadata,signal);
  const range=quantizeRange(.28,1.48,frames);
  const output=await renderPlan(planProcessing([{id:'v',...range,metadata}],'none'),new Map([['v',{path:source,metadata}]]),dir,signal);
  const actual=(await frameBoundaries(output,await probeFile(output,signal),signal)).slice(0,-1).map(f=>f.time);
  const expected=frames.filter(f=>f.time>=range.start && f.time<range.end).map(f=>f.time-range.start);
  assert.equal(actual.length,expected.length);
  actual.forEach((t,i)=>assert.ok(Math.abs(t-expected[i])<.001,`${i}: ${t} vs ${expected[i]}`));
  ffmpeg(['-i',output,'-f','null','-']);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('continuous original audio crosses six generated sections without re-encoding or sample drift',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'media-audio-proof-'));
 try{
  const video=join(dir,'part.mp4'),source=join(dir,'original.mp4');
  ffmpeg(['-f','lavfi','-i','testsrc2=s=96x64:r=25:d=0.4','-c:v','libx264',video]);
  ffmpeg(['-f','lavfi','-i','testsrc2=s=96x64:r=25:d=2.4','-f','lavfi','-i','sine=frequency=997:sample_rate=48000:duration=2.4','-c:v','libx264','-c:a','aac',source]);
  const vm=await probeFile(video,signal),sm=await probeFile(source,signal);
  const clips=Array.from({length:6},(_,i)=>({id:'v',start:0,end:.4,metadata:vm,audio:{id:'s',start:i*.4,end:(i+1)*.4}}));
  const output=await renderPlan(planProcessing(clips,'original'),new Map([['v',{path:video,metadata:vm}],['s',{path:source,metadata:sm}]]),dir,signal);
  const pcm=(path:string)=>ffmpeg(['-i',path,'-map','0:a:0','-f','s16le','-']);
  assert.deepEqual(pcm(output),pcm(source));
  const metadata=await probeFile(output,signal);assert.ok(Math.abs(metadata.duration-2.4)<1/25);
  ffmpeg(['-i',output,'-f','null','-']);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('exact render preserves non-square pixels, rotation and first-source color space',async()=>{
 const dir=await mkdtemp(join(tmpdir(),"media-geometry-proof-"));
 try{
  const source=join(dir,'source.mp4'),rotated=join(dir,'rotated.mp4');
  ffmpeg(['-f','lavfi','-i','testsrc2=s=96x64:r=25:d=2','-vf','setsar=4/3,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv','-c:v','libx264','-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709','-color_range','tv',source]);
  const supportsDisplayRotation=spawnSync('ffmpeg',['-h','full']).stdout.toString().includes('-display_rotation');
  ffmpeg(supportsDisplayRotation?['-display_rotation','90','-i',source,'-c','copy',rotated]:['-i',source,'-c','copy','-metadata:s:v:0','rotate=90',rotated]);
  for(const path of [source,rotated]){
   const metadata=await probeFile(path,signal);
   const out=await renderPlan(planProcessing([{id:'v',start:.2,end:1.2,metadata}],'none'),new Map([['v',{path,metadata}]]),dir,signal);
   const result=await probeFile(out,signal);
   assert.equal(result.video?.sample_aspect_ratio,'1:1');
   assert.equal(result.video?.width,path===source?128:64);
   assert.equal(result.video?.height,path===source?64:128);
   assert.equal(result.video?.color_space,'bt709');
   assert.equal(result.video?.color_transfer,'bt709');
   ffmpeg(['-i',out,'-f','null','-']);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('fractional trim contains the selected visible frames, excluding both outside edges',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'media-boundaries-proof-'));
 try{
  const source=join(dir,'counter.mp4');
  ffmpeg(['-f','lavfi','-i',"nullsrc=s=96x64:r=25:d=2,geq=lum='N*4+16':cb=128:cr=128",'-c:v','libx264','-crf','0',source]);
  const metadata=await probeFile(source,signal),range=quantizeRange(.281,1.479,await frameBoundaries(source,metadata,signal));
  const output=await renderPlan(planProcessing([{id:'v',...range,metadata}],'none'),new Map([['v',{path:source,metadata}]]),dir,signal);
  const levels=(path:string)=>{const pixels=ffmpeg(['-i',path,'-map','0:v','-pix_fmt','gray','-f','rawvideo','-']);return Array.from({length:pixels.length/(96*64)},(_,i)=>pixels[i*96*64]);};
  const expected=levels(source).slice(7,37),actual=levels(output);assert.equal(actual.length,expected.length);
  actual.forEach((level,i)=>assert.ok(Math.abs(level-expected[i])<=1,`frame ${i}: ${level} vs ${expected[i]}`));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('joined generated sections round against one cumulative timeline without duration drift',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'media-cumulative-proof-'));
 try{
  const source=join(dir,'part.mp4');ffmpeg(['-f','lavfi','-i','testsrc2=s=96x64:r=25:d=1','-c:v','libx264',source]);
  const metadata=await probeFile(source,signal);
  const clips=Array.from({length:20},()=>({id:'v',start:0,end:.32,outputDuration:.34,metadata}));
  const plan=planProcessing(clips,'none');assert.ok(Math.abs(plan.duration-6.8)<.0001);
  const output=await renderPlan(plan,new Map([['v',{path:source,metadata}]]),dir,signal);
  assert.ok(Math.abs((await probeFile(output,signal)).duration-6.8)<.04);
  const frames=ffmpeg(['-i',output,'-map','0:v','-f','framemd5','-']).toString().split('\n').filter(l=>l&&!l.startsWith('#'));
  assert.equal(frames.length,170);
 }finally{await rm(dir,{recursive:true,force:true});}
});
