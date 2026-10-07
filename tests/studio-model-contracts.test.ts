import test from 'node:test';
import assert from 'node:assert/strict';
import { newKieInputError, newKiePayload, newKieReferenceNames } from '../src/lib/kie-new-models';
import { generationCreditCost } from '../src/lib/generation-pricing';
import { normalizeKieTask } from '../src/lib/kie';
const image={role:'reference-image',mimeType:'image/png',width:720,height:1280,sizeBytes:1000};
const video={role:'reference-video',mimeType:'video/mp4',durationSeconds:5,width:720,height:1280,fps:30,sizeBytes:1000};
const base={prompt:'Replace the performer',duration:'5',resolution:'720P',references:[image,video]};
test('Seedance validates exact caps, duration, pixel count and fps',()=>{
 assert.equal(newKieInputError('seedance-2-5',base),null);
 assert.match(newKieInputError('seedance-2-5',{...base,references:Array(31).fill(image)})!,/30/);
 assert.match(newKieInputError('seedance-2-5',{...base,references:[{...video,fps:23}]})!,/fps/);
 assert.match(newKieInputError('seedance-2-5',{...base,references:[{...video,width:1920,height:1080}]})!,/dimensions/);
 assert.match(newKieInputError('seedance-2-5',{...base,references:Array(7).fill(video)})!,/total/);
});
test('WAN sums all source videos and output duration',()=>{
 assert.equal(newKieInputError('wan-3',base),null);
 assert.match(newKieInputError('wan-3',{...base,duration:'26'})!,/30s/);
 assert.match(newKieInputError('wan-3',{...base,references:[{...image,hasAlpha:true},video]})!,/transparency/);
 assert.deepEqual(newKieReferenceNames('seedance-2-5',[image,video,image,{role:'reference-audio'}]),['Image1','Video1','Image2','Audio1']);
});
test('providers receive selected options and last-frame is not discarded',()=>{
 const refs=base.references.map((r,i)=>({...r,label:'ref',assetUrl:'https://example.test/'+i}));
 const payload=newKiePayload('seedance-2-5',{...base,outputFormat:'mov',returnLastFrame:true,webSearch:true},refs)!;
 assert.equal(payload.output_format,'mov');assert.equal(payload.return_last_frame,true);assert.equal(payload.web_search,true);
 assert.equal(newKiePayload('wan-3',{...base,seed:42},refs)!.seed,42);
 assert.equal(newKiePayload('gpt-image-2-5-sunburst',{prompt:'A character',background:'transparent'},[])!.background,'transparent');
 assert.match(newKieInputError('nano-banana-2-1',{prompt:'A character',references:[],background:'transparent'})!,/transparent/);
 assert.equal(normalizeKieTask({data:{resultJson:JSON.stringify({resultUrls:['video'],lastFrameUrl:'frame'})}}).lastFrameUrl,'frame');
});
test('new pricing includes all input video seconds',()=>{
 assert.equal(generationCreditCost('seedance-2-5','1080P','5',2,{hasVideoInput:true,inputVideoDurationSeconds:7}),1140);
 assert.equal(generationCreditCost('seedance-2-5','1080P','5'),790);
 assert.equal(generationCreditCost('nano-banana-2-1','4K','5'),9);
});
