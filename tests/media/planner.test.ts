import assert from 'node:assert/strict';
import {test} from 'node:test';
import {planProcessing,compatibleVideo} from '../../src/lib/media/planner';
import {quantizeRange,type MediaMetadata} from '../../src/lib/media/probe';
import {mediaJobRequestSchema,fingerprint} from '../../src/lib/media/contracts';
const metadata:MediaMetadata={version:1,duration:4,format:'mov,mp4',fps:25,rotation:0,directPlayback:true,
  streams:[{index:0,codec_type:'video',codec_name:'h264'}],video:{index:0,codec_type:'video',codec_name:'h264',width:64,height:64,pix_fmt:'yuv420p',extradata_hash:'same',r_frame_rate:'25/1',avg_frame_rate:'25/1',time_base:'1/12800'}};
test('reuse unchanged; strip audio copies video; a partial GOP always takes exact transcode',()=>{
  const clip={id:'a',start:0,end:4,metadata};
  assert.equal(planProcessing([clip],'selected').video,'reuse');
  assert.equal(planProcessing([clip],'none').video,'copy');
  assert.equal(planProcessing([{...clip,start:.28}],'selected').video,'transcode');
});
test('same codec name does not establish concat compatibility',()=>{
  assert.equal(compatibleVideo(metadata,{...metadata,video:{...metadata.video!,time_base:'1/90000'}}),false);
  assert.equal(compatibleVideo(metadata,{...metadata,rotation:90}),false);
  assert.equal(compatibleVideo(metadata,{...metadata,video:{...metadata.video!,color_primaries:'bt2020'}}),false);
  assert.equal(compatibleVideo(metadata,metadata),true);
});
test('timeline maps to actual VFR timestamps, not a 30fps grid',()=>{
  const frames=[0,.041,.079,.122,.2].map(time=>({time,key:false}));
  assert.deepEqual(quantizeRange(.08,.12,frames),{start:.079,end:.122});
});
test('contract canonicalizes settings and retains distinct ranges',()=>{
  assert.equal(fingerprint({b:2,a:1}),fingerprint({a:1,b:2}));
  assert.notEqual(fingerprint({start:.001}),fingerprint({start:.002}));
  assert.equal(mediaJobRequestSchema.safeParse({projectId:'test',requestKey:'test',spec:{operation:'export',assets:[{id:crypto.randomUUID(),start:0,end:1}]}}).success,true);
});
