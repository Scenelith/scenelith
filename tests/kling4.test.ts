import assert from "node:assert/strict";
import {test} from "node:test";
import {execFileSync} from "node:child_process";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import sharp from "sharp";
import {buildKieInput,getKieModel,startGeneration} from "../src/lib/kie";
import {newKieInputError,newKiePrompt,newKieReferenceNames,type ModelReference} from "../src/lib/kie-new-models";
import {prepareNewKieReferences} from "../src/lib/kie-reference-validation";
import {generationCreditCost} from "../src/lib/generation-pricing";

const ref=(role="reference-image",label="@Subject",durationSeconds?:number)=>({role,label,durationSeconds,assetUrl:`https://example.test/${label.slice(1)}`});
const prompt="Follow the subject's motion";
const error=(id:string,references:ReturnType<typeof ref>[],overrides={})=>newKieInputError(id,{prompt,references,...overrides});

test("Kling 4 encodes references, independently numbered voices, and ordered keyframes",()=>{
  const refs=[ref("reference-video","@Clip",7),ref("reference-image","@Hero"),ref("reference-audio","@Narrator")];
  assert.deepEqual(newKieReferenceNames("kling-4-reference",refs),["@video_1","@image_1","@voice_1"]);
  assert.deepEqual(buildKieInput("kling-4-reference",{prompt:"@Hero follows @Clip speaking as @Narrator",duration:"10",resolution:"1080P",aspectRatio:"21:9"},refs),{
    prompt:"@image_1 follows @video_1 speaking as @voice_1",duration:10,resolution:"1080p",aspect_ratio:"21:9",
    image_urls:[refs[1].assetUrl],video_urls:[refs[0].assetUrl],voices:[{name:"voice_1",audio_url:refs[2].assetUrl}],keep_original_sound:false,
  });
  const frames=[ref("end-frame","@Finish"),ref("reference-image","@MiddleA"),ref("start-frame","@Start"),ref("reference-image","@MiddleB")];
  const input=buildKieInput("kling-4-keyframe",{prompt:"@Start passes @MiddleA then @MiddleB to @Finish",duration:"3",aspectRatio:"21:9"},frames);
  assert.deepEqual(input,{prompt:"@first_frame passes @keyframe_1 then @keyframe_2 to @last_frame",duration:3,resolution:"720p",first_frame_url:frames[2].assetUrl,keyframe_urls:[frames[1].assetUrl,frames[3].assetUrl],last_frame_url:frames[0].assetUrl});
  assert.equal(error("kling-4-keyframe",[ref("end-frame")]),null,"last frame alone is permitted");
  assert.equal(buildKieInput("kling-4-keyframe",{prompt,aspectRatio:"9:16"},[]).aspect_ratio,"9:16","text-only mode keeps selected ratio");
});

test("Kling 4 validates mention boundaries, role counts, durations and frame budget before charging",()=>{
  assert.equal(newKiePrompt("kling-4-reference","@Hero_long and @Hero",[ref("reference-image","@Hero"),ref("reference-image","@Hero_long")]),"@image_2 and @image_1");
  assert.match(error("kling-4-reference",[ref()],{prompt:"Use @Subject_extra"})!,/does not match/);
  assert.match(error("kling-4-keyframe",[ref("end-frame")],{prompt:"Use @first_frame"})!,/does not match/);
  assert.match(error("kling-4-reference",[ref(),ref()],{prompt:"Use @Subject"})!,/ambiguous/);
  assert.match(error("kling-4-keyframe",[ref("reference-video","@Clip",4)])!,/unsupported input/);
  assert.match(error("kling-4-reference",[ref("start-frame")])!,/unsupported input/);
  for(const duration of [1,31])assert.match(error("kling-4-reference",[ref("reference-video","@Clip",duration)])!,/2–30s/);
  assert.match(error("kling-4-reference",[ref("reference-video")])!,/measured/);
  assert.equal(newKieInputError("kling-4-reference",{prompt,references:[ref("reference-video")]},{allowUnmeasuredMedia:true}),null);
  assert.match(error("kling-4-reference",Array.from({length:11},()=>ref()))!,/at most 10/);
  assert.match(error("kling-4-reference",Array.from({length:4},()=>ref("reference-audio")))!,/at most 3/);
  const frames=[ref("start-frame"),...Array.from({length:8},(_,i)=>ref("reference-image",`@Middle${i}`)),ref("end-frame")];
  assert.match(error("kling-4-keyframe",frames,{duration:"8"})!,/at most 9 total frames/);
  assert.equal(error("kling-4-keyframe",frames,{duration:"9"}),null);
  assert.match(error("kling-4-reference",[],{duration:"2"})!,/duration must/);
  assert.match(newKieInputError("kling-4-reference",{prompt,references:[{...ref(),sizeBytes:10*1024*1024+1}]} )!,/10 MB/);
  assert.match(newKieInputError("kling-4-reference",{prompt,references:[{...ref(),width:299,height:600}]} )!,/300–65536/);
});

test("Kling 4 pricing uses all input seconds with a two-output-duration floor only for video references",()=>{
  for(const id of ["kling-4-reference","kling-4-keyframe"]){
    assert.equal(generationCreditCost(id,"720P","10",2),285);
    assert.equal(generationCreditCost(id,"1080P","10",2),425);
  }
  for(const inputSeconds of [2,5,10]){
    assert.equal(generationCreditCost("kling-4-reference","720P","10",1,{hasVideoInput:true,inputVideoDurationSeconds:inputSeconds}),340);
    assert.equal(generationCreditCost("kling-4-reference","1080P","10",1,{hasVideoInput:true,inputVideoDurationSeconds:inputSeconds}),510);
  }
  assert.equal(generationCreditCost("kling-4-reference","720P","10",2,{hasVideoInput:true,inputVideoDurationSeconds:15}),425);
  assert.equal(generationCreditCost("kling-4-reference","1080P","3",2,{hasVideoInput:true,inputVideoDurationSeconds:7.25}),262);
});

test("Kling preflight measures stored video and image dimensions, then dispatches exact provider models without live generation",async(t)=>{
  const dir=await mkdtemp(join(tmpdir(),"kling4-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const video=join(dir,"video.mp4"),image=join(dir,"image.png");
  execFileSync("ffmpeg",["-v","error","-f","lavfi","-i","color=c=blue:s=320x480:r=25:d=3","-c:v","libx264","-pix_fmt","yuv420p",video]);
  await sharp({create:{width:320,height:480,channels:3,background:"red"}}).png().toFile(image);
  const storedRefs:Array<ModelReference & {path:string;mimeType:string;label:string}>=[{path:video,mimeType:"video/mp4",label:"@Clip",role:"reference-video",sizeBytes:1,durationSeconds:29},{path:image,mimeType:"image/png",label:"@Hero",role:"reference-image",sizeBytes:1}];
  const refs=await prepareNewKieReferences("kling-4-reference",storedRefs);
  assert.equal(refs[0].durationSeconds,3,"actual media, not stale duration, controls pricing");
  assert.equal(refs[1].width,320);
  assert.ok((refs[0].sizeBytes || 0)>1);
  for(const key of ["KIE_API_KEY","KIE_API_KEY_FILE","REDIS_URL"]){const old=process.env[key];delete process.env[key];t.after(()=>{if(old===undefined)delete process.env[key];else process.env[key]=old;});}
  process.env.KIE_API_KEY="test-kling-key";
  const requests:{model:string;input:Record<string,unknown>}[]=[];
  t.mock.method(globalThis,"fetch",async(url:string|URL|Request,init?:RequestInit)=>{
    if(String(url).includes("file-stream-upload"))return Response.json({code:200,data:{downloadUrl:"https://example.test/upload"}});
    assert.equal(String(url),"https://api.kie.ai/api/v1/jobs/createTask");requests.push(JSON.parse(String(init?.body)));
    return Response.json({code:200,data:{taskId:"mock-kling-task"}});
  });
  await startGeneration({modelId:"kling-4-reference",prompt:"@Hero follows @Clip",references:refs});
  assert.equal(requests[0].model,"kling-4.0/reference-to-video");
  assert.equal(requests[0].input.prompt,"@image_1 follows @video_1");
  await startGeneration({modelId:"kling-4-keyframe",prompt:"Arrive at @Finish",references:[{path:image,mimeType:"image/png",role:"end-frame",label:"@Finish"}]});
  assert.equal(requests[1].model,"kling-4.0/keyframe-to-video");
  assert.equal(requests[1].input.prompt,"Arrive at @last_frame");
  assert.equal(getKieModel("kling-4-reference").supportsAudio,undefined,"native sound must not expose a nonfunctional off switch");
});
