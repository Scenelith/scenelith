import assert from 'node:assert/strict';
import test from 'node:test';
import {pricedAssistantCatalog} from '../src/lib/assistant-catalog';
import {createAssistantCatalogCache} from '../src/lib/assistant-catalog-server';
const id='google/gemini-3.7-flash';
const catalogue=(prompt:string,completion='0.000006')=>({data:[{id,pricing:{prompt,completion},architecture:{input_modalities:['text','image']}}]});
test('API prices and vision support override bundled values and absent models become unavailable',()=>{
 const models=pricedAssistantCatalog(catalogue('0.000004'));assert.equal(models[0].promptUsdPerToken,.000004);assert.equal(models[0].completionUsdPerToken,.000006);assert.equal(models[0].available,true);assert.equal(models[1].available,false);assert.equal(pricedAssistantCatalog(catalogue('invalid'))[0].available,false);assert.throws(()=>pricedAssistantCatalog({data:[]}),/unavailable/);
});
test('catalogue coalesces requests, refreshes after five minutes and retains last good prices for bounded outages',async()=>{
 let time=1000000,calls=0,fail=false,price='0.000004';const fetcher:typeof fetch=async()=>{calls++;if(fail)throw Error('Offline');return new Response(JSON.stringify(catalogue(price)));};const load=createAssistantCatalogCache(fetcher,()=>time);
 const values=await Promise.all([load(),load()]);assert.equal(calls,1);assert.equal(values[0].source,'live');assert.equal((await load()).source,'cached');assert.equal(calls,1);
 time+=300001;price='0.000008';assert.equal((await load()).models[0].promptUsdPerToken,.000008);assert.equal(calls,2);time+=300001;fail=true;assert.equal((await load()).models[0].promptUsdPerToken,.000008);assert.equal((await load()).source,'cached');assert.equal(calls,3);
 time+=86400001;assert.equal((await load()).models[0].available,false);
});
test('a cold catalogue outage never authorizes a paid request with stale bundled prices',async()=>{let calls=0;const load=createAssistantCatalogCache(async()=>{calls++;throw Error('Offline')});assert.equal((await load()).models[0].available,false);assert.equal((await load()).models[0].available,false);assert.equal(calls,1);});
