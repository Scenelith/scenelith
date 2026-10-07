import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {soundtrackArguments} from '../src/lib/generation-extras';

test('original audio keeps its timing and pitch, truncates or pads without loops, and supports MOV',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'studio-audio-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const audio=join(dir,'source.wav');
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=1','-ar','16000',audio]);
 for(const [seconds,ext] of [[.5,'mp4'],[2,'mov']] as const){
  const video=join(dir,`video-${seconds}.mp4`),out=join(dir,`out.${ext}`);
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i',`color=blue:s=64x64:r=30:d=${seconds}`,'-c:v','libx264',video]);
  execFileSync('ffmpeg',soundtrackArguments(video,audio,out));
  const duration=Number(execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',out],{encoding:'utf8'}));
  assert.ok(Math.abs(duration-seconds)<.15);
  const pcm=execFileSync('ffmpeg',['-v','error','-i',out,'-map','0:a:0','-f','s16le','-ar','16000','-ac','1','pipe:1']);
  const rms=(from:number,to:number)=>{let total=0,count=0;for(let i=Math.floor(from*16000)*2;i<Math.min(pcm.length,to*16000*2);i+=2){total+=pcm.readInt16LE(i)**2;count++;}return Math.sqrt(total/count);};
  assert.ok(rms(.1,.4)>1000,'original sound is present');
  if(seconds>1)assert.ok(rms(1.3,1.8)<10,'the tail is silence, not a loop');
 }
});

test('a boundary-length source fragment starts at zero without AAC preroll or cropping',async t=>{
 const {videoSegmentArguments}=await import('../src/lib/video-segment');
 const dir=await mkdtemp(join(tmpdir(),'studio-trim-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=join(dir,'source.mp4'),out=join(dir,'clip.mp4');
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=red:s=640x720:r=30:d=16','-f','lavfi','-i','sine=frequency=440:duration=16','-c:v','libx264','-c:a','aac',source]);
 execFileSync('ffmpeg',videoSegmentArguments(source,out,1,16,'seedance-2-5'));
 const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','format=duration:stream=start_time,duration,width,height','-of','json',out],{encoding:'utf8'}));
 assert.equal(Number(probe.format.duration),15);
 assert.ok(probe.streams.every((s:{start_time:string})=>Number(s.start_time)===0));
 assert.ok(Math.abs(probe.streams[0].width/probe.streams[0].height-640/720)<.002,'same composition and aspect ratio');
});
