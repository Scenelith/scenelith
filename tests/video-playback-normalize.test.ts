import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {normalizeVideoPlayback} from '../src/lib/video-playback-normalize';
import {mp4HasFastStart} from '../src/lib/media-probe';

test('playback copy normalizes audio, preserves video packets and supports silent files',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'playback-test-'));
 const run=(cmd:string,args:string[])=>{const r=spawnSync(cmd,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout;};
 try{
  for(const audio of [true,false]){
   const src=join(dir,`${audio}.mp4`),out=join(dir,`${audio}-out.mp4`);
   run('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=64x96:d=1',...(audio?['-f','lavfi','-i','sine=frequency=1000:sample_rate=22050:duration=1']:[]),'-c:v','libx264','-c:a','aac',src]);
   const original=await readFile(src),result=await normalizeVideoPlayback(original);await writeFile(out,result);
   assert.ok(mp4HasFastStart(result));assert.deepEqual(await readFile(src),original);
   const packetHash=(path:string)=>run('ffmpeg',['-v','error','-i',path,'-map','0:v','-c','copy','-f','hash','-']);
   assert.equal(packetHash(src),packetHash(out));
   const streams=JSON.parse(run('ffprobe',['-v','error','-show_streams','-of','json',out])).streams;
   const track=streams.find((s:{codec_type:string})=>s.codec_type==='audio');
   if(audio){assert.equal(track.profile,'LC');assert.equal(track.sample_rate,'48000');assert.equal(track.channels,2);}else assert.equal(track,undefined);
   assert.ok(Math.abs(Number(streams[0].duration)-1)<.1);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
