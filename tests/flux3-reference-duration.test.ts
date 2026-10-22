import assert from "node:assert/strict";
import {test} from "node:test";
import {allowedKieRatios,buildKieInput,getKieModel} from "../src/lib/kie";
import {newKieInputError,newKiePrompt} from "../src/lib/kie-new-models";
import {generationCreditCost} from "../src/lib/generation-pricing";
import {defaultCanvasNodeData} from "../src/lib/mcp/canvas-capabilities";
import {referenceDurationSettings} from "../src/lib/reference-duration";

test("FLUX 3 routes ordered references and literal edit settings without losing the base image",()=>{
  const refs=[{assetUrl:"https://example.test/base.png",label:"@EditSource",role:"reference-image"},{assetUrl:"https://example.test/hair.png",label:"@Hair",role:"reference-image"}];
  const input=buildKieInput("flux-3-klein",{prompt:"Change only the hair",aspectRatio:"auto",resolution:"4K",seed:0,outputFormat:"webp"},refs);
  assert.deepEqual(input,{prompt:"Change only the hair",image_urls:refs.map(ref=>ref.assetUrl),aspect_ratio:"auto",resolution:"4K",output_format:"webp",num_images:1,enhance_prompt:false,seed:0});
  assert.match(newKiePrompt("flux-3-klein","Change only the hair",refs),/image 1: @EditSource\nimage 2: @Hair/);
  assert.equal(buildKieInput("flux-3-klein",{prompt:"A portrait"},[]).enhance_prompt,true);
  assert.equal(buildKieInput("flux-3-klein",{prompt:"A portrait",enhancePrompt:false},[]).enhance_prompt,false);
  assert.ok(!allowedKieRatios(getKieModel("flux-3-klein"),"1K",false).includes("auto"));
  assert.ok(allowedKieRatios(getKieModel("flux-3-klein"),"1K",true).includes("auto"));
  assert.match(newKieInputError("flux-3-klein",{prompt:"x",references:[],aspectRatio:"auto"})!,/aspect ratio/);
  assert.match(newKieInputError("flux-3-klein",{prompt:"x",references:Array.from({length:11},()=>refs[0])})!,/at most 10/);
  assert.match(newKieInputError("flux-3-klein",{prompt:"x",references:[{...refs[0],sizeBytes:31*1024*1024}]})!,/30 MB/);
  for(const [resolution,credits] of [["1K",2],["2K",3],["4K",7]] as const)assert.equal(generationCreditCost("flux-3-klein",resolution,"5",10),credits);
});

test("new generator defaults are portrait Nano Banana 2.1 and Wan 3 while explicit model choices remain intact",()=>{
  for(const [type,model] of [["image_generator","nano-banana-2-1"],["video_generator","wan-3"]] as const){
    const data=defaultCanvasNodeData(type,{});assert.equal(data.modelId,model);assert.equal(data.aspectRatio,"9:16");
  }
  assert.equal(defaultCanvasNodeData("image_generator",{modelId:"flux-3-klein"}).modelId,"flux-3-klein");
});

test("reference duration covers fractional scenes, caps one long source, and preserves explicit seconds",()=>{
  for(const [seconds,output] of [[8.234,"9"],[15,"15"],[25,"15"],[1,"2"]] as const){
    const refs=[{role:"reference-video",durationSeconds:seconds}];
    const automatic=referenceDurationSettings("wan-3",refs,"5","reference");
    assert.equal(automatic.duration,output);assert.equal(automatic.seconds,Math.min(15,seconds));
    assert.equal(refs[0].durationSeconds,seconds,"the source stays unchanged");
    assert.equal(referenceDurationSettings("wan-3",refs,"5","fixed").duration,"5");
  }
  const multiple=[{role:"reference-video",durationSeconds:10},{role:"reference-video",durationSeconds:9}];
  assert.equal(referenceDurationSettings("wan-3",multiple,"5","reference").seconds,19,"never silently discard or shorten multiple inputs");
  assert.equal(referenceDurationSettings("seedance-2",multiple,"5","reference").duration,"5");
  assert.equal(referenceDurationSettings("wan-3",[],"5","reference").active,false);
});
