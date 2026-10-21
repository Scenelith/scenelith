import assert from 'node:assert/strict';
import test from 'node:test';
import {resolveTikTok} from '../src/lib/tiktok-resolver';
import {importMedia} from '../src/lib/media/import';
import {MediaError} from '../src/lib/media/contracts';

test('TikWM errors preserve actionable codes and transient retry policy',async(t)=>{
 for(const [status,code,retryable] of [[403,'TIKTOK_RESOLVER_BLOCKED',false],[429,'TIKTOK_RESOLVER_UNAVAILABLE',true],[503,'TIKTOK_RESOLVER_UNAVAILABLE',true]] as const){
  const mock=t.mock.method(globalThis,'fetch',async()=>new Response('',{status}));
  await assert.rejects(resolveTikTok('https://www.tiktok.com/@fixture/video/123'),(error:unknown)=>error instanceof MediaError&&error.code===code&&error.retryable===retryable);
  mock.mock.restore();
 }
 const mock=t.mock.method(globalThis,'fetch',async()=>Response.json({code:-1,msg:'Not available'}));
 await assert.rejects(resolveTikTok('https://www.tiktok.com/@fixture/video/123'),/TIKTOK_POST_UNAVAILABLE/);mock.mock.restore();
});

test('media worker uses the saved resolver snapshot without contacting TikWM',async(t)=>{
 const mock=t.mock.method(globalThis,'fetch',async()=>{throw new Error('worker must not contact the resolver');});
 await assert.rejects(importMedia('https://www.tiktok.com/@fixture/video/123','/unused',new AbortController().signal,{}, {id:'123'}),/IMPORT_VIDEO_MISSING/);
 assert.equal(mock.mock.callCount(),0);mock.mock.restore();
});
