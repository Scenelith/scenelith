import {assistantModels} from './assistant-models';
import {pricedAssistantCatalog,type AssistantCatalog} from './assistant-catalog';
// One request per process every five minutes; failures keep a bounded last-good
// snapshot. Only the explicit assistant allowlist is exposed, never API keys.
export function createAssistantCatalogCache(fetcher:typeof fetch=fetch,now:()=>number=Date.now){
 let snapshot:AssistantCatalog|null=null,nextRefresh=0,pending:Promise<AssistantCatalog>|undefined;
 return async():Promise<AssistantCatalog>=>{
  const time=now();if(pending)return pending;
  if(time<nextRefresh&&snapshot&&time-Date.parse(snapshot.updatedAt!)<86400000)return {...snapshot,source:'cached'};
  if(time<nextRefresh&&!snapshot)return {models:assistantModels.map(model=>({...model,available:false})),updatedAt:null,source:'fallback'};
  pending=(async()=>{try{const response=await fetcher('https://openrouter.ai/api/v1/models',{signal:AbortSignal.timeout(5000),cache:'no-store'});if(!response.ok)throw Error('Model catalogue is unavailable');const models=pricedAssistantCatalog(await response.json());snapshot={models,updatedAt:new Date(now()).toISOString(),source:'live'};nextRefresh=now()+300000;return snapshot;}catch{nextRefresh=now()+30000;return snapshot&&now()-Date.parse(snapshot.updatedAt!)<86400000?{...snapshot,source:'cached' as const}:{models:assistantModels.map(model=>({...model,available:false})),updatedAt:snapshot?.updatedAt||null,source:'fallback' as const};}finally{pending=undefined;}})();return pending;
 };
}
const cached=createAssistantCatalogCache((...args)=>fetch(...args));
export async function liveAssistantCatalog(){const result=await cached();if(result.source!=='fallback')assistantModels.splice(0,assistantModels.length,...result.models);return result;}
